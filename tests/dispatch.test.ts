import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatchTask, DispatchError } from "../src/dispatch.ts";
import { OrcaError, type LaunchTerminalOptions } from "../src/orca.ts";
import { listJobs, listOrphanJobs, removeJob, snapshotUnused, statusOf } from "../src/jobs.ts";
import { resolveSessionDir } from "../src/jobs.ts";
import { inheritResourceArgs, launchShellCommand, taskTitle } from "../src/launch-plan.ts";

const exec = promisify(execFile);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "pi-orca-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "nested ' $(touch INJECTED) dir");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd); await mkdir(sessionDir);
  const header = { type: "session", version: 3, id: "parent-1", timestamp: "2026-09-15T00:00:00Z", cwd };
  const entries = [
    { type: "message", id: "a", parentId: null, timestamp: header.timestamp, message: { role: "user", content: "提案して" } },
    { type: "message", id: "b", parentId: "a", timestamp: header.timestamp, message: { role: "assistant", content: [{ type: "text", text: "案Aと案B" }] } },
  ];
  const parent = join(sessionDir, "parent.jsonl");
  const original = [header, ...entries, { type: "message", id: "unrelated", parentId: "a", message: { role: "user", content: "別の枝" } }].map(JSON.stringify).join("\n") + "\n";
  await writeFile(parent, original);
  const manager = {
    getHeader: () => header, getBranch: () => entries,
    getSessionId: () => header.id, getSessionFile: () => parent,
    getLeafId: () => entries.at(-1)?.id ?? null,
  };
  const input = { manager, sessionDir, cwd, configPath: join(root, "orca-dispatch.json"), sourceTerminalHandle: "source-pane", model: { provider: "provider", id: "exact/model" }, thinkingLevel: "medium", activeTools: ["read", "bash", "custom_tool"], packageDir, launchCommand: { command: [process.execPath, join(root, "fake-pi.mjs")], resourceArgs: [] } };
  return { root, cwd, sessionDir, header, entries, parent, original, manager, input };
}

test("dispatch launches a real child runner with exact instruction/model/cwd and leaves the active parent intact", async (t) => {
  const f = await fixture(t);
  await writeFile(f.input.launchCommand.command[1], `
    import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    const args=process.argv.slice(2);
    const session=args[args.indexOf('--session')+1];
    const task=args.find(a=>a.startsWith('@')).slice(1);
    writeFileSync(join(process.cwd(),'observed.json'),JSON.stringify({args,cwd:process.cwd(),task:readFileSync(task,'utf8'),session:readFileSync(session,'utf8')}));
    appendFileSync(session,JSON.stringify({type:'custom',data:'child-only'})+'\\n');
  `);
  const prompt = "案Bを実装。APIを維持。\n' ; $(touch INJECTED) `echo nope`\n/clear\n--session wrong";
  let calls = 0;
  const stored = await dispatchTask(prompt, f.input, {
    preflight: async () => ({ worktreeId: "pinned", worktreePath: f.root }),
    launchTerminal: async (options) => {
      calls++;
      assert.equal(options.worktreeId, "pinned");
      assert.equal(options.placement, "split");
      assert.equal(options.sourceTerminalHandle, "source-pane");
      assert.ok(!options.command.includes(prompt));
      await exec("/bin/sh", ["-c", options.command], { cwd: f.root });
      return { handle: "terminal-1" };
    },
  });
  const observed = JSON.parse(await readFile(join(f.cwd, "observed.json"), "utf8"));
  assert.equal(calls, 1);
  assert.equal(observed.task, prompt);
  assert.equal(observed.cwd, f.cwd);
  assert.equal(observed.args[observed.args.indexOf("--model") + 1], "exact/model");
  assert.equal(observed.args[observed.args.indexOf("--provider") + 1], "provider");
  assert.equal(observed.args[observed.args.indexOf("--thinking") + 1], "medium");
  const child = observed.session.trim().split("\n").map(JSON.parse);
  assert.deepEqual(child.slice(1, 3), f.entries);
  assert.equal(child[0].parentSession, f.parent);
  assert.notEqual(child[0].id, f.header.id);
  assert.equal(child.at(-1).type, "session_info");
  assert.equal(await readFile(f.parent, "utf8"), f.original);
  assert.equal(f.manager.getLeafId(), "b");
  assert.deepEqual(await listJobs(f.sessionDir, "parent-1"), [stored]);
  // The child appended one entry, so the recorded snapshot length still marks this job as used.
  assert.equal(stored.job.snapshotLines, f.entries.length + 2);
  assert.equal((await readFile(stored.job.sessionFile, "utf8")).trim().split("\n").length, stored.job.snapshotLines! + 1);
  assert.equal(await snapshotUnused(stored), false);
  assert.equal((await statusOf(stored)).state, "closed");
  assert.equal((await stat(stored.job.taskFile)).mode & 0o777, 0o600);
  assert.equal((await stat(stored.path)).mode & 0o777, 0o600);
  assert.ok(!(await readdir(f.cwd)).includes("INJECTED"));
});

test("failed preflight creates no child sessions or job files", async (t) => {
  const f = await fixture(t);
  await assert.rejects(dispatchTask("案B", f.input, {
    preflight: async () => { throw new OrcaError("not running", "runtime_unavailable", false); },
    launchTerminal: async () => { throw new Error("must not launch"); },
  }), /not running/);
  assert.deepEqual(await readdir(f.sessionDir), ["parent.jsonl"]);
});

test("snapshot is captured before async preflight while later parent turns stay in parent only", async (t) => {
  const f = await fixture(t);
  const stored = await dispatchTask("案B", f.input, {
    preflight: async () => {
      f.entries.push({ ...f.entries[0], id: "new", parentId: "b", message: { role: "user", content: "次の検討" } });
      return { worktreeId: "pinned", worktreePath: f.root };
    },
    launchTerminal: async () => ({ handle: "child" }),
  });
  const child = await readFile(stored.job.sessionFile, "utf8");
  assert.ok(!child.includes("次の検討"));
  assert.equal(stored.job.sourceLeafId, "b");
});

test("switching parent while preflight runs cancels before any child is created", async (t) => {
  const f = await fixture(t);
  let current = true;
  await assert.rejects(dispatchTask("案B", { ...f.input, isCurrent: () => current }, {
    preflight: async () => { current = false; return { worktreeId: "pinned", worktreePath: f.root }; },
    launchTerminal: async () => { throw new Error("must not launch"); },
  }), /切り替わった/);
  assert.deepEqual(await readdir(f.sessionDir), ["parent.jsonl"]);
});

test("uncertain terminal creation is recorded once and retained for recovery without a retry", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let failure: DispatchError | undefined;
  try {
    await dispatchTask("案B", f.input, {
      preflight: async () => ({ worktreeId: "pinned", worktreePath: f.root }),
      launchTerminal: async () => { calls++; throw new OrcaError("timed out", "orca_timeout", true); },
    });
  } catch (error) { failure = error as DispatchError; }
  assert.equal(calls, 1);
  assert.ok(failure instanceof DispatchError);
  assert.equal(failure.ambiguous, true);
  assert.equal(await readFile(failure.stored!.job.taskFile, "utf8"), "案B");
  assert.equal((await statusOf((await listJobs(f.sessionDir, "parent-1"))[0])).state, "unknown");
  assert.equal(await readFile(f.parent, "utf8"), f.original);
});

test("startup args carry explicit resources but exclude original tasks, sessions and credentials", () => {
  assert.deepEqual(inheritResourceArgs(["--session", "old", "--api-key", "secret", "--model", "old", "-e", "./custom.ts", "--no-skills", "--system-prompt", "./system.md", "original prompt"]), ["-e", "./custom.ts", "--no-skills", "--system-prompt", "./system.md"]);
  assert.ok(!launchShellCommand("/usr/bin/node", "/a'b/launch.mjs", "/job.json").includes("secret"));
  assert.throws(() => launchShellCommand("node", "line\nbreak", "job"), /改行/);
  assert.equal(taskTitle("案B\n追加条件"), "pi: 案B");
  assert.deepEqual(inheritResourceArgs(["-ne", "-ns", "-np", "-nc", "-na", "--no-context-files", "--no-approve", "-e", "custom.ts"]), ["-ne", "-ns", "-np", "-nc", "-na", "--no-context-files", "--no-approve", "-e", "custom.ts"]);
});

test("nested dispatch includes the child observer only once and preserves other resource flags", async (t) => {
  const f = await fixture(t);
  const observer = join(packageDir, "observer.ts");
  f.input.launchCommand.resourceArgs.push("-ne", "-e", "custom.ts", "-e", observer);
  const stored = await dispatchTask("nested", f.input, {
    preflight: async () => ({ worktreeId: "pinned", worktreePath: f.root }),
    launchTerminal: async () => ({ handle: "child" }),
  });
  assert.equal(stored.job.args.filter((arg) => arg === observer).length, 1);
  assert.ok(stored.job.args.includes("-ne"));
  assert.ok(stored.job.args.includes("custom.ts"));
});

test("memory-only sessions resolve a discoverable project session directory", () => {
  assert.match(resolveSessionDir("", "/project/nested"), /sessions\/--project-nested--$/u);
  assert.equal(resolveSessionDir("/explicit/sessions", "/project"), "/explicit/sessions");
});

test("a tab without pi startup acknowledgement becomes unconfirmed instead of running forever", async (t) => {
  const f = await fixture(t);
  const stored = await dispatchTask("案B", f.input, {
    preflight: async () => ({ worktreeId: "pinned", worktreePath: f.root }),
    launchTerminal: async () => ({ handle: "child" }),
  });
  stored.job.createdAt = "2000-01-01T00:00:00Z";
  assert.equal((await statusOf(stored)).state, "unknown");
});

test("cleanup removes jobs but only the snapshots the child never used", async (t) => {
  const f = await fixture(t);
  const launch = {
    preflight: async () => ({ worktreeId: "pinned", worktreePath: f.root }),
    launchTerminal: async () => ({ handle: "term-1" }),
  };
  const untouched = await dispatchTask("未使用", f.input, launch);
  const used = await dispatchTask("使用済み", f.input, launch);
  await appendFile(used.job.sessionFile, JSON.stringify({
    type: "message", id: "work", parentId: used.job.sourceLeafId, timestamp: "2026-09-15",
    message: { role: "user", content: "子タブでの続き" },
  }) + "\n");
  for (const stored of [untouched, used]) {
    await writeFile(join(dirname(stored.path), "runner-status.json"), JSON.stringify({
      version: 1, id: stored.job.id, state: "exited", exitCode: 0,
    }) + "\n");
  }
  const jobs = await listJobs(f.sessionDir, "parent-1");
  assert.deepEqual(jobs.map((job) => job.job.id).sort(), [untouched.job.id, used.job.id].sort());
  assert.deepEqual((await Promise.all(jobs.map(statusOf))).map((status) => status.state), ["closed", "closed"]);
  assert.equal(await snapshotUnused(used), false);
  assert.equal(await snapshotUnused(untouched), true);

  await removeJob(untouched, { snapshot: true });
  await assert.rejects(readFile(untouched.job.sessionFile, "utf8"), { code: "ENOENT" });
  assert.deepEqual((await listJobs(f.sessionDir, "parent-1")).map((job) => job.job.id), [used.job.id]);

  await removeJob(used, { snapshot: false });
  assert.equal((await readFile(used.job.sessionFile, "utf8")).includes("子タブでの続き"), true);
  assert.deepEqual(await listJobs(f.sessionDir, "parent-1"), []);
});

test("jobs from other sessions are found for cleanup and never mixed into --list", async (t) => {
  const f = await fixture(t);
  const launch = {
    preflight: async () => ({ worktreeId: "pinned", worktreePath: f.root }),
    launchTerminal: async () => ({ handle: "term-1" }),
  };
  const mine = await dispatchTask("この会話", f.input, launch);
  const otherManager = {
    ...f.manager,
    getSessionId: () => "parent-2",
    getHeader: () => ({ ...f.header, id: "parent-2" }),
  };
  const orphan = await dispatchTask("別の会話", { ...f.input, manager: otherManager }, launch);

  assert.deepEqual((await listJobs(f.sessionDir, "parent-1")).map((job) => job.job.id), [mine.job.id]);
  assert.deepEqual((await listOrphanJobs(f.sessionDir, "parent-1")).map((job) => job.job.id), [orphan.job.id]);
  assert.deepEqual((await listOrphanJobs(f.sessionDir, "parent-2")).map((job) => job.job.id), [mine.job.id]);

  await removeJob(orphan, { snapshot: true });
  assert.deepEqual(await listOrphanJobs(f.sessionDir, "parent-1"), []);
  assert.equal((await listJobs(f.sessionDir, "parent-1")).length, 1);
});

test("windows starts the child through one base64 command both Windows shells parse the same", () => {
  const command = launchShellCommand(
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\pi pkg\\bin\\launch.mjs",
    "C:\\jobs\\job's.json",
    "win32",
  );
  assert.match(command, /^powershell -NoProfile -EncodedCommand [A-Za-z0-9+/=]+$/u);
  const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
  assert.equal(script, "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\pi pkg\\bin\\launch.mjs' 'C:\\jobs\\job''s.json'");
  // Nothing survives that cmd.exe and PowerShell would parse differently.
  assert.equal(/["'&^%!<>|;]/u.test(command), false);
  assert.throws(() => launchShellCommand("node", "line\nbreak", "job", "win32"), /改行/);
  assert.equal(
    launchShellCommand("/usr/bin/node", "/a/launch.mjs", "/job.json", "linux"),
    "'/usr/bin/node' '/a/launch.mjs' '/job.json'",
  );
});

test("only the model identity is persisted, never the rest of Pi's model object", async (t) => {
  const f = await fixture(t);
  // Pi passes its full model object at runtime; only provider and id may be stored.
  const model = {
    provider: "provider",
    id: "exact/model",
    api: "openai-completions",
    baseUrl: "https://internal.example/v1",
    cost: { input: 0.15, output: 0.6 },
    compat: { supportsStore: false },
  };
  const stored = await dispatchTask("案B", { ...f.input, model }, {
    preflight: async () => ({ worktreeId: "pinned", worktreePath: f.root }),
    launchTerminal: async () => ({ handle: "child" }),
  });
  assert.deepEqual(stored.job.model, { provider: "provider", id: "exact/model" });
  const raw = await readFile(stored.path, "utf8");
  assert.ok(!raw.includes("baseUrl") && !raw.includes("internal.example") && !raw.includes("compat"));
  assert.equal(stored.job.args[stored.job.args.indexOf("--provider") + 1], "provider");
  assert.equal(stored.job.args[stored.job.args.indexOf("--model") + 1], "exact/model");
  assert.deepEqual(await listJobs(f.sessionDir, "parent-1"), [stored]);
});

test("global placement changes apply on the next dispatch and tab mode needs no source pane", async (t) => {
  const f = await fixture(t);
  const placements: string[] = [];
  const deps = {
    preflight: async () => ({ worktreeId: "pinned", worktreePath: f.root }),
    launchTerminal: async (options: LaunchTerminalOptions) => {
      placements.push(options.placement!);
      return { handle: "child" };
    },
  };
  await dispatchTask("split", f.input, deps);
  await writeFile(f.input.configPath, JSON.stringify({ placement: "tab" }));
  await dispatchTask("tab", { ...f.input, sourceTerminalHandle: "" }, deps);
  await writeFile(f.input.configPath, JSON.stringify({ placement: "split" }));
  await dispatchTask("split again", f.input, deps);
  assert.deepEqual(placements, ["split", "tab", "split"]);
});

test("invalid configuration and missing source pane leave sessions untouched", async (t) => {
  const f = await fixture(t);
  const deps = {
    preflight: async () => { throw new Error("must not preflight"); },
    launchTerminal: async () => { throw new Error("must not launch"); },
  };
  await assert.rejects(dispatchTask("task", { ...f.input, sourceTerminalHandle: "" }, deps), /実行元のペイン/u);
  await writeFile(f.input.configPath, '{"placement":"invalid"}');
  await assert.rejects(dispatchTask("task", f.input, deps), /placement/u);
  assert.deepEqual(await readdir(f.sessionDir), ["parent.jsonl"]);
  assert.equal(await readFile(f.parent, 'utf8'), f.original);
});
