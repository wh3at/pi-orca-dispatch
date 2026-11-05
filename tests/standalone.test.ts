import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { dispatchTask } from "../src/dispatch.ts";
import { shellQuote } from "../src/launch-plan.ts";

const exec = promisify(execFile);
const binary = process.env.PI_TEST_STANDALONE;
const packageDir = resolve(import.meta.dirname, "..");
const checksum = "61a84400938da652ed69aac9c1ad2ca23af3c9bd8cc2f46ce571ed84ae6a35e5";

test("pinned standalone pi launches through Node, accepts the instruction once, and can redispatch", {
  skip: !binary && "Set PI_TEST_STANDALONE to the pinned Linux x64 pi 1.5.0 binary",
  timeout: 30000,
}, async (t) => {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(createHash("sha256").update(await readFile(binary!)).digest("hex"), checksum);
  assert.equal((await exec(binary!, ["--version"])).stdout.trim(), "1.5.0");
  const root = await mkdtemp(join(tmpdir(), "pi's standalone "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const output = join(root, "plan.json");
  const childOutput = join(root, "child.jsonl");
  const env = { ...process.env, ANTHROPIC_API_KEY: "pi-dispatch-offline-test", PI_ORCA_DISPATCH_JOB: "", PI_CODING_AGENT_DIR: join(root, "agent"), PI_DISPATCH_PLAN_OUTPUT: output, PI_DISPATCH_CHILD_OUTPUT: childOutput };
  const args = ["-ne", "-ns", "-np", "--no-themes", "--no-context-files", "--no-session", "-p", "-e", join(packageDir, "tests/fixtures/standalone-plan.ts"), "-e", join(packageDir, "tests/fixtures/standalone-child.ts")];
  const parentProbe = exec(binary!, args, { cwd: root, env, timeout: 10000 });
  parentProbe.child.stdin!.end();
  await parentProbe;
  const actual = JSON.parse(await readFile(output, "utf8"));
  assert.ok(actual.versions.bun);
  assert.deepEqual(actual.plan.command, [actual.executable]);
  assert.notEqual(actual.plan.launcherNode, actual.executable);
  assert.equal((await exec(actual.plan.launcherNode, ["-p", "process.release.name"])).stdout.trim(), "node");
  const parent = join(sessionDir, "parent.jsonl");
  const header = { type: "session", version: 3, id: "standalone-parent", cwd: root, timestamp: new Date().toISOString() };
  const entries = [{ type: "message", id: "prior", parentId: null, timestamp: header.timestamp, message: { role: "user", content: "Keep this conversation", timestamp: Date.now() } }];
  const original = [header, ...entries].map(JSON.stringify).join("\n") + "\n";
  await writeFile(parent, original);
  const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
  const prompt = "Implement plan B.\nSpaces and 'quotes' must survive.";
  const stored = await dispatchTask(prompt, {
    manager: { getHeader: () => header, getBranch: () => entries, getSessionId: () => header.id, getSessionFile: () => parent, getLeafId: () => "prior" },
    sessionDir, cwd: root, model, thinkingLevel: "medium", activeTools: ["read", "bash"], packageDir,
    sourceTerminalHandle: "test-pane", configPath: join(root, "config.json"), launchCommand: actual.plan,
  }, {
    preflight: async () => ({ worktreeId: "test-worktree", worktreePath: root }),
    launchTerminal: async ({ command }) => {
      try {
        await exec("script", ["-q", "-e", "-c", command, "/dev/null"], { cwd: root, env, timeout: 20000 });
      } catch (error: any) {
        throw new Error(`${error.message}\n${error.stdout}\n${error.stderr}\n${await readFile(childOutput, "utf8").catch(() => "No child observation")}`);
      }
      return { handle: "test-child-pane" };
    },
  });
  const observations = (await readFile(childOutput, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(observations.length, 1);
  const observed = observations[0];
  assert.equal(observed.text, `<file name="${stored.job.taskFile}">\n${prompt}\n</file>\n`);
  assert.equal(observed.inputs, 1);
  assert.equal(observed.cwd, root);
  assert.equal(observed.sessionFile, stored.job.sessionFile);
  assert.deepEqual(observed.model, model);
  assert.equal(observed.thinking, "medium");
  assert.deepEqual(observed.tools, ["read", "bash"]);
  assert.ok(observed.branch.some((entry: any) => entry.id === "prior"));
  assert.deepEqual(observed.plan.command, [actual.executable]);
  assert.deepEqual(observed.nested.job.command, [actual.executable]);
  assert.equal(observed.nested.job.args.filter((arg: string) => arg === join(packageDir, "observer.ts")).length, 1);
  assert.equal(await readFile(parent, "utf8"), original);
  const directory = dirname(stored.path);
  assert.ok((await readdir(directory)).includes("claimed"));
  assert.equal(JSON.parse(await readFile(join(directory, "runner-status.json"), "utf8")).exitCode, 0);
  assert.equal(JSON.parse(await readFile(join(directory, "task-started"), "utf8")).sessionFile, stored.job.sessionFile);
  const launcher = [actual.plan.launcherNode, join(packageDir, "bin/launch.mjs"), stored.path].map(shellQuote).join(" ");
  await assert.rejects(exec("/bin/sh", ["-c", launcher], { cwd: root, env }), (error: any) => error.code === 73);
  assert.equal((await readFile(childOutput, "utf8")).trim().split("\n").length, 1);
});
