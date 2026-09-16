import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import observer, { samePath } from "../observer.ts";

const launcher = fileURLToPath(new URL("../bin/launch.mjs", import.meta.url));

function fixture(t: TestContext, script = "process.exit(0)") {
  const dir = mkdtempSync(join(tmpdir(), "pi dispatch ' $(literal) "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, "fake pi ' $(literal).mjs");
  writeFileSync(executable, script);
  const sessionFile = join(dir, "child session.jsonl");
  writeFileSync(sessionFile, "{}");
  const job = {
    version: 1, id: "dispatch-test", sessionFile, cwd: dir,
    command: [process.execPath, executable], args: [] as string[], activeTools: ["read", "edit"],
    createdAt: new Date().toISOString(),
  };
  const jobPath = join(dir, "job.json");
  const save = () => writeFileSync(jobPath, JSON.stringify(job), { mode: 0o600 });
  save();
  return { dir, job, jobPath, save };
}

function run(jobPath: string) {
  return spawnSync(process.execPath, [launcher, jobPath], { encoding: "utf8", timeout: 5_000 });
}

function status(dir: string, owner: "runner" | "agent" = "runner") {
  return JSON.parse(readFileSync(join(dir, `${owner}-status.json`), "utf8"));
}

test("runner passes literal argv, cwd, job environment and exit status without a shell", (t) => {
  const f = fixture(t, `
    import { writeFileSync } from 'node:fs';
    writeFileSync('captured.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), job: process.env.PI_ORCA_DISPATCH_JOB }));
    process.exit(7);
  `);
  f.job.args = ["--session", f.job.sessionFile, "@task ' $(touch INJECTED);`touch INJECTED`.txt", "", "line\none"];
  f.save();
  const result = run(f.jobPath);
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "captured.json"), "utf8")), {
    args: f.job.args, cwd: f.dir, job: f.jobPath,
  });
  assert.equal(existsSync(join(f.dir, "INJECTED")), false);
  assert.equal(status(f.dir).state, "exited");
  assert.equal(status(f.dir).exitCode, 7);
  assert.equal(statSync(join(f.dir, "runner-status.json")).mode & 0o777, 0o600);
});

test("duplicate claim never executes the task again or replaces the first status", (t) => {
  const f = fixture(t, "import { appendFileSync } from 'node:fs'; appendFileSync('runs', 'once\\n');");
  assert.equal(run(f.jobPath).status, 0);
  const initial = status(f.dir);
  const result = run(f.jobPath);
  assert.equal(result.status, 73);
  assert.match(result.stderr, /already claimed/);
  assert.equal(readFileSync(join(f.dir, "runs"), "utf8"), "once\n");
  assert.deepEqual(status(f.dir), initial);
});

test("spawn failure keeps the saved session and reports failure without retrying", (t) => {
  const f = fixture(t);
  f.job.command = [join(f.dir, "missing-pi")];
  f.save();
  const result = run(f.jobPath);
  assert.equal(result.status, 127);
  assert.match(result.stderr, /Saved session for manual resume/);
  assert.equal(status(f.dir).state, "failed");
  assert.equal(existsSync(f.job.sessionFile), true);
  assert.equal(run(f.jobPath).status, 73);
});

test("invalid job never claims or starts a process", (t) => {
  const f = fixture(t);
  f.job.cwd = "relative/path";
  f.save();
  assert.equal(run(f.jobPath).status, 65);
  assert.equal(existsSync(join(f.dir, "claimed")), false);
  assert.equal(existsSync(join(f.dir, "runner-status.json")), false);
});

test("runner inherits the explicitly captured pi configuration directory", (t) => {
  const f = fixture(t, `
    import { writeFileSync } from 'node:fs';
    writeFileSync('captured.json', JSON.stringify({ directory: process.env.PI_CODING_AGENT_DIR, job: process.env.PI_ORCA_DISPATCH_JOB }));
  `);
  const directory = join(f.dir, "alternate config ' $(literal)");
  Object.assign(f.job, { env: { PI_CODING_AGENT_DIR: directory } });
  f.save();
  const result = run(f.jobPath);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "captured.json"), "utf8")), {
    directory, job: f.jobPath,
  });
});

test("runner rejects arbitrary environment overrides before claiming a job", (t) => {
  const f = fixture(t);
  for (const env of [{ NODE_OPTIONS: "--inspect" }, { PI_ORCA_DISPATCH_JOB: "/other/job.json" },
    { PI_CODING_AGENT_DIR: null }, { PI_CODING_AGENT_DIR: "bad\0path" }, []]) {
    Object.assign(f.job, { env });
    f.save();
    assert.equal(run(f.jobPath).status, 65);
    assert.equal(existsSync(join(f.dir, "claimed")), false);
  }
});

test("runner relays termination and waits for pi to clean up", { timeout: 10_000 }, async (t) => {
  const f = fixture(t, `
    import { writeFileSync } from 'node:fs';
    process.on('SIGTERM', () => { writeFileSync('cleanup', 'restored'); process.exit(42); });
    process.stdout.write('READY');
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [launcher, f.jobPath], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const finished = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.stdout.on("data", (chunk) => { if (chunk.toString().includes("READY")) resolve(); });
    child.once("exit", () => reject(new Error("Runner exited before readiness")));
  });
  // A duplicate arriving while pi is alive must not steal or replace the job.
  assert.equal(run(f.jobPath).status, 73);
  child.kill("SIGTERM");
  const result = await finished;
  assert.equal(result.code, 42);
  assert.equal(readFileSync(join(f.dir, "cleanup"), "utf8"), "restored");
  assert.equal(status(f.dir).exitCode, 42);
});

function observe(t: TestContext, available = ["read", "edit", "bash", "custom"]) {
  const f = fixture(t);
  const previous = process.env.PI_ORCA_DISPATCH_JOB;
  process.env.PI_ORCA_DISPATCH_JOB = f.jobPath;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_ORCA_DISPATCH_JOB;
    else process.env.PI_ORCA_DISPATCH_JOB = previous;
  });
  const handlers = new Map<string, Function>();
  const calls: string[][] = [];
  const notifications: string[] = [];
  let active: string[] = [];
  const api = {
    on: (event: string, handler: Function) => handlers.set(event, handler),
    getAllTools: () => available.map((name) => ({ name })),
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { calls.push(names); active = names; },
  };
  const ctx = {
    sessionManager: { getSessionFile: () => f.job.sessionFile },
    ui: { notify: (message: string) => { notifications.push(message); } },
    model: { provider: "test-provider", id: "test-model" },
  };
  const start = () => observer(api);
  const emit = (event: string, data: Record<string, unknown> = {}, context = ctx) => handlers.get(event)?.(data, context);
  return { ...f, start, emit, ctx, api, calls, handlers, notifications };
}

test("observer restores exact active tools and tracks activity without touching messages", (t) => {
  const f = observe(t);
  f.start();
  assert.deepEqual(f.emit("input"), { action: "handled" });
  f.emit("session_start", { reason: "startup" });
  assert.deepEqual(f.calls, [["read", "edit"]]);
  assert.equal(status(f.dir, "agent").state, "ready");
  assert.equal(f.emit("input"), undefined);
  assert.equal(f.emit("tool_call"), undefined);
  f.emit("agent_start");
  assert.equal(status(f.dir, "agent").state, "working");
  f.emit("agent_end", { messages: ["private result which must not be inspected"] });
  assert.equal(status(f.dir, "agent").state, "idle");
  assert.equal(readFileSync(join(f.dir, "agent-status.json"), "utf8").includes("private result"), false);
  f.emit("session_shutdown");
  assert.equal(status(f.dir, "agent").state, "closed");
});

test("missing inherited custom tool blocks both initial input and tool calls", (t) => {
  const f = observe(t, ["read"]);
  f.start();
  f.emit("session_start", { reason: "startup" });
  assert.equal(f.calls.length, 0);
  assert.equal(status(f.dir, "agent").state, "blocked");
  assert.deepEqual(f.emit("input"), { action: "handled" });
  assert.equal(f.emit("tool_call").block, true);
  assert.match(f.notifications.join(" "), /Required tools are unavailable: edit/);
});

test("tool selection mismatch fails closed even when the API silently ignores a tool", (t) => {
  const f = observe(t);
  f.api.getActiveTools = () => ["read", "edit", "bash"];
  f.start();
  f.emit("session_start", { reason: "startup" });
  assert.equal(status(f.dir, "agent").state, "blocked");
  assert.deepEqual(f.emit("input"), { action: "handled" });
});

test("first input restores tool selection changed by a later startup hook, later inputs preserve user changes", (t) => {
  const f = observe(t);
  f.start();
  f.emit("session_start", { reason: "startup" });
  f.api.setActiveTools(["bash"]);
  assert.equal(f.emit("input"), undefined);
  assert.deepEqual(f.api.getActiveTools(), ["read", "edit"]);
  f.api.setActiveTools(["custom"]);
  assert.equal(f.emit("input"), undefined);
  assert.deepEqual(f.api.getActiveTools(), ["custom"]);
});

test("model fallback blocks startup without enabling tools", (t) => {
  const f = observe(t);
  Object.assign(f.job, { model: { provider: "intended-provider", id: "intended-model" } });
  f.save();
  f.start();
  f.emit("session_start", { reason: "startup" });
  assert.equal(f.calls.length, 0);
  assert.equal(status(f.dir, "agent").state, "blocked");
  assert.match(status(f.dir, "agent").error, /intended-provider\/intended-model/);
  assert.deepEqual(f.emit("input"), { action: "handled" });
  assert.equal(f.emit("tool_call").block, true);
});

test("model changes from later startup hooks block initial input", (t) => {
  const f = observe(t);
  Object.assign(f.job, { model: { ...f.ctx.model } });
  f.save();
  f.start();
  f.emit("session_start", { reason: "startup" });
  assert.equal(status(f.dir, "agent").state, "ready");
  f.ctx.model = { provider: "other-provider", id: "other-model" };
  assert.deepEqual(f.emit("input"), { action: "handled" });
  assert.equal(status(f.dir, "agent").state, "blocked");
  assert.equal(f.emit("tool_call").block, true);
});

test("model changes after accepted initial input remain under user control", (t) => {
  const f = observe(t);
  Object.assign(f.job, { model: { ...f.ctx.model } });
  f.save();
  f.start();
  f.emit("session_start", { reason: "startup" });
  assert.equal(f.emit("input"), undefined);
  f.ctx.model = { provider: "other-provider", id: "other-model" };
  assert.equal(f.emit("input"), undefined);
  assert.equal(f.emit("tool_call"), undefined);
});

test("reload after initial dispatch preserves deliberate model and tool changes", (t) => {
  const f = observe(t);
  Object.assign(f.job, { model: { ...f.ctx.model } });
  f.save();
  f.start();
  f.emit("session_start", { reason: "startup" });
  assert.equal(f.emit("input"), undefined);
  assert.equal(existsSync(join(f.dir, "task-started")), true);
  f.ctx.model = { provider: "chosen-provider", id: "chosen-model" };
  f.api.setActiveTools(["custom"]);
  const changesBeforeReload = f.calls.length;
  f.emit("session_shutdown", { reason: "reload" });
  f.start(); // Pi creates a new extension instance on reload.
  f.emit("session_start", { reason: "reload" });
  assert.equal(status(f.dir, "agent").state, "idle");
  assert.equal(f.calls.length, changesBeforeReload);
  assert.deepEqual(f.api.getActiveTools(), ["custom"]);
  assert.equal(f.emit("input"), undefined);
  assert.equal(f.emit("tool_call"), undefined);
  assert.equal(f.calls.length, changesBeforeReload);
});

test("failed initial input has no startup marker and reload retries the original guard", (t) => {
  const f = observe(t);
  Object.assign(f.job, { model: { ...f.ctx.model } });
  f.save();
  f.start();
  f.emit("session_start", { reason: "startup" });
  f.ctx.model = { provider: "wrong-provider", id: "wrong-model" };
  assert.deepEqual(f.emit("input"), { action: "handled" });
  assert.equal(existsSync(join(f.dir, "task-started")), false);
  f.emit("session_shutdown", { reason: "reload" });
  f.start();
  f.emit("session_start", { reason: "reload" });
  assert.equal(status(f.dir, "agent").state, "blocked");
  assert.deepEqual(f.emit("input"), { action: "handled" });
});

test("wrong startup session is never mutated and does not receive the task", (t) => {
  const f = observe(t);
  f.ctx.sessionManager.getSessionFile = () => join(f.dir, "parent.jsonl");
  f.start();
  f.emit("session_start", { reason: "startup" });
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(f.dir, "agent-status.json")), false);
  assert.deepEqual(f.emit("input"), { action: "handled" });
});

test("intentional session switch detaches observer without changing the new session", (t) => {
  const f = observe(t);
  f.start();
  f.emit("session_start", { reason: "startup" });
  f.emit("session_shutdown", { reason: "resume" });
  const saved = status(f.dir, "agent");
  f.ctx.sessionManager.getSessionFile = () => join(f.dir, "other.jsonl");
  f.emit("session_start", { reason: "resume" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.emit("input"), undefined);
  assert.equal(f.emit("tool_call"), undefined);
  f.emit("agent_start");
  f.emit("agent_end");
  assert.deepEqual(status(f.dir, "agent"), saved);
});

test("malformed observer job blocks input and never writes a guessed status location", (t) => {
  const f = observe(t);
  writeFileSync(f.jobPath, "{");
  f.start();
  f.emit("session_start", { reason: "startup" });
  assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(f.dir, "agent-status.json")), false);
  assert.deepEqual(f.emit("input"), { action: "handled" });
});

test("observer does nothing without a dispatched job environment", (t) => {
  const f = observe(t);
  delete process.env.PI_ORCA_DISPATCH_JOB;
  f.start();
  assert.equal(f.handlers.size, 0);
});

test("session file comparison is platform aware", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orca-path-"));
  const file = join(dir, "Session File.jsonl");
  writeFileSync(file, "{}\n");
  try {
    assert.equal(samePath(file, file), true);
    assert.equal(samePath(file, join(dir, "other.jsonl")), false);
    // Windows folds case before comparing; POSIX does not.
    assert.equal(samePath(file, file.toUpperCase()), process.platform === "win32");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
