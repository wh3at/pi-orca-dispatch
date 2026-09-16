import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";

test("extension exposes one independent command and cancelling its editor does not create a session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-orca-ui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = new Map<string, Function>();
  let command: { handler: Function; getArgumentCompletions: Function } | undefined;
  const notices: string[] = [];
  const statuses: unknown[] = [];
  const pi = {
    registerCommand(name: string, options: typeof command) { assert.equal(name, "orca-dispatch"); command = options; },
    on(event: string, handler: Function) { events.set(event, handler); },
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "medium",
  };
  const ctx = {
    cwd: directory, hasUI: true, mode: "tui", model: { provider: "test", id: "model" },
    sessionManager: {
      getSessionDir: () => directory, getSessionId: () => "parent",
      getSessionFile: () => undefined, getLeafId: () => null,
      getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: directory, timestamp: "2026-09-15" }),
      getBranch: () => [],
    },
    isIdle: () => true,
    ui: {
      notify(message: string) { notices.push(message); },
      setStatus(_key: string, value: unknown) { statuses.push(value); },
      getEditorText: () => "existing draft", setEditorText() { throw new Error("must preserve editor"); },
      editor: async () => undefined,
      select: async () => undefined,
      confirm: async () => false,
    },
  };
  extension(pi as Parameters<typeof extension>[0]);
  await events.get("session_start")!({ reason: "startup" }, ctx);
  try {
    await command!.handler("", ctx);
    assert.deepEqual(await readdir(directory), []);
    assert.deepEqual(command!.getArgumentCompletions("--l").map((x: { value: string }) => x.value), ["--list"]);
    assert.deepEqual(command!.getArgumentCompletions("--c").map((x: { value: string }) => x.value), ["--clean"]);
    await command!.handler("--list", ctx);
    assert.match(notices.at(-1)!, /作業はありません/u);
    await command!.handler("--clean", ctx);
    assert.match(notices.at(-1)!, /片付ける作業はありません/u);
    assert.deepEqual(await readdir(directory), []);
    await command!.handler("--help", ctx);
    assert.match(notices.at(-1)!, /orca-dispatch/u);
    assert.match(notices.at(-1)!, /Orca CLI: /u);
    assert.deepEqual([...events.keys()], ["session_start", "session_shutdown"]);
  } finally { await events.get("session_shutdown")!({}, ctx); }
});
