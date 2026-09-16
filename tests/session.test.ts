import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  captureSnapshot,
  writeSnapshot,
  type SnapshotEntry,
  type SnapshotSessionManager,
} from "../src/session.ts";

const timestamp = "2026-09-15T01:00:00.000Z";

function entry(
  id: string,
  parentId: string | null,
  values: Record<string, unknown> = {},
): SnapshotEntry {
  return { type: "custom", id, parentId, timestamp, ...values };
}

function fixture(entries: SnapshotEntry[], parentSessionFile?: string) {
  const header = {
    type: "session",
    version: 3,
    id: "parent-session",
    cwd: "/old/cwd",
    timestamp,
    parentSession: "/older/ancestor.jsonl",
    extensionMetadata: { preserved: true },
  };
  const manager: SnapshotSessionManager = {
    getHeader: () => header,
    getBranch: () => entries,
    getSessionId: () => header.id,
    getSessionFile: () => parentSessionFile,
    getLeafId: () => entries.at(-1)?.id ?? null,
  };
  return { manager, header };
}

async function tempDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-orca-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readEntries(file: string): Promise<Record<string, unknown>[]> {
  const contents = await readFile(file, "utf8");
  assert.ok(contents.endsWith("\n"));
  return contents.trimEnd().split("\n").map((line) => JSON.parse(line));
}

test("captures the active in-memory branch rather than unrelated disk history", async (t) => {
  const directory = await tempDirectory(t);
  const root = entry("root", null, { type: "message", message: { role: "user", content: "Question" } });
  const selected = entry("selected", "root", {
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "Option B" }] },
  });
  const unrelated = entry("other-branch", "root", { data: { unrelated: true } });
  const parentFile = join(directory, "parent.jsonl");
  const { manager, header } = fixture([root, selected], parentFile);
  const originalFile = [header, root, selected, unrelated].map((value) => JSON.stringify(value)).join("\n");
  // No trailing newline, so opening the parent through pi's loader could repair it.
  await writeFile(parentFile, originalFile);
  const snapshot = captureSnapshot(manager, "/project/current");
  const child = await writeSnapshot(snapshot, { sessionDir: directory, title: "Option B" });
  const saved = await readEntries(child.sessionFile);

  assert.deepEqual(saved.slice(1, -1), [root, selected]);
  assert.equal(saved[0].parentSession, parentFile);
  assert.equal(saved[0].cwd, "/project/current");
  assert.notEqual(child.sessionId, header.id);
  assert.equal(saved.at(-1)?.parentId, "selected");
  assert.equal(saved.at(-1)?.name, "Option B");
  assert.equal(await readFile(parentFile, "utf8"), originalFile);
  assert.equal(manager.getSessionId(), "parent-session");
  assert.equal(manager.getLeafId(), "selected");
});

test("preserves compaction, label chains, custom state, models and external references", async (t) => {
  const directory = await tempDirectory(t);
  const entries = [
    entry("model", null, { type: "model_change", provider: "custom", modelId: "chosen" }),
    entry("thinking", "model", { type: "thinking_level_change", thinkingLevel: "high" }),
    entry("user", "thinking", { type: "message", message: { role: "user", content: "Keep this" } }),
    entry("label", "user", { type: "label", targetId: "user", label: "Chosen option" }),
    entry("answer", "label", { type: "message", message: { role: "assistant", content: [] } }),
    entry("compaction", "answer", {
      type: "compaction", firstKeptEntryId: "label", summary: "Earlier work", tokensBefore: 1234,
      fromHook: true, details: { index: { user: "original-id" } },
    }),
    entry("summary", "compaction", {
      type: "branch_summary", fromId: "entry-on-another-branch", summary: "Prior branch",
    }),
    entry("state", "summary", { customType: "third-party", data: { ids: ["user", "answer"] } }),
    entry("context", "state", {
      type: "custom_message", customType: "constraints", content: "Preserve public API", display: false,
    }),
  ];
  const { manager } = fixture(entries);
  const snapshot = captureSnapshot(manager, "/project");
  const saved = await readEntries((await writeSnapshot(snapshot, { sessionDir: directory, title: "Refactor" })).sessionFile);

  assert.deepEqual(saved.slice(1, -1), entries);
  const byId = new Map(saved.slice(1).map((value) => [value.id, value]));
  assert.equal(byId.get("compaction")?.firstKeptEntryId, "label");
  assert.equal(byId.get("answer")?.parentId, "label");
  const reconstructed: unknown[] = [];
  let cursor = saved.at(-1);
  while (cursor) {
    reconstructed.unshift(cursor.id);
    cursor = byId.get(cursor.parentId);
  }
  assert.deepEqual(reconstructed.slice(0, -1), entries.map((value) => value.id));
});

test("snapshot copies are independent and writing never mutates the source", async (t) => {
  const directory = await tempDirectory(t);
  const entries = [entry("root", null, { data: { nested: [1, 2, 3] } })];
  const { manager, header } = fixture(entries);
  const original = JSON.stringify({ entries, header });
  const snapshot = captureSnapshot(manager, "/project");
  const snapshotBeforeWrite = JSON.stringify(snapshot);
  const childPromise = writeSnapshot(snapshot, { sessionDir: directory, title: "Copy" });
  (snapshot.entries[0].data as { nested: number[] }).nested.push(4);
  const saved = await readEntries((await childPromise).sessionFile);
  assert.deepEqual(saved[1], entries[0]);
  assert.equal(JSON.stringify({ entries, header }), original);
  assert.notEqual(JSON.stringify(snapshot), snapshotBeforeWrite);
  assert.equal(header.cwd, "/old/cwd");
});

test("memory-only and empty parents produce resumable named sessions without a false parent path", async (t) => {
  const directory = await tempDirectory(t);
  for (const entries of [[], [entry("user", null, { type: "message", message: { role: "user", content: "Unflushed" } })]]) {
    const { manager } = fixture(entries);
    const snapshot = captureSnapshot(manager, "/project");
    assert.equal(snapshot.parentSessionFile, undefined);
    const saved = await readEntries((await writeSnapshot(snapshot, { sessionDir: directory, title: "New task" })).sessionFile);
    assert.equal(Object.hasOwn(saved[0], "parentSession"), false);
    assert.equal(saved.at(-1)?.parentId, entries.at(-1)?.id ?? null);
    assert.equal(saved[0].version, 3);
  }
});

test("rejects unsupported session versions and mismatched session identity", () => {
  const { manager, header } = fixture([]);
  for (const version of [1, 2, 4]) {
    header.version = version;
    assert.throws(() => captureSnapshot(manager, "/project"), /format version 3/);
  }
  header.version = 3;
  assert.throws(() => captureSnapshot({ ...manager, getSessionId: () => "different" }, "/project"), /header/);
});

test("rejects broken chains, duplicate IDs, wrong leaf and dangling compaction references", () => {
  const invalidBranches = [
    [entry("root", "missing")],
    [entry("root", null), entry("root", "root")],
    [entry("root", null), entry("child", null)],
    [entry("root", null), entry("compaction", "root", { type: "compaction", firstKeptEntryId: "missing" })],
    [entry("root", null), entry("compaction", "root", { type: "compaction", firstKeptEntryId: "future" }), entry("future", "compaction")],
  ];
  for (const branch of invalidBranches) {
    assert.throws(() => captureSnapshot(fixture(branch).manager, "/project"));
  }
  const { manager } = fixture([entry("root", null)]);
  assert.throws(() => captureSnapshot({ ...manager, getLeafId: () => "other" }, "/project"), /leaf/);
});

test("revalidates changed snapshots before creating files", async (t) => {
  const directory = await tempDirectory(t);
  const snapshot = captureSnapshot(fixture([entry("root", null)]).manager, "/project");
  snapshot.entries[0].parentId = "broken";
  await assert.rejects(writeSnapshot(snapshot, { sessionDir: directory, title: "Invalid" }), /parent chain/);
  assert.deepEqual(await readdir(directory), []);
});

test("creates fresh private files and leaves existing session bytes intact", async (t) => {
  const directory = await tempDirectory(t);
  const snapshot = captureSnapshot(fixture([entry("root", null)]).manager, "/project");
  const first = await writeSnapshot(snapshot, { sessionDir: directory, title: "First" });
  const firstBytes = await readFile(first.sessionFile, "utf8");
  const second = await writeSnapshot(snapshot, { sessionDir: directory, title: "Second" });
  assert.notEqual(first.sessionId, second.sessionId);
  assert.notEqual(first.sessionFile, second.sessionFile);
  assert.equal(await readFile(first.sessionFile, "utf8"), firstBytes);
  assert.equal((await stat(first.sessionFile)).mode & 0o777, 0o600);
  assert.equal((await stat(second.sessionFile)).mode & 0o777, 0o600);
  const firstSaved = await readEntries(first.sessionFile);
  assert.notEqual(firstSaved.at(-1)?.id, "root");
});

test("cannot overwrite an existing non-directory as the session directory", async (t) => {
  const directory = await tempDirectory(t);
  const existing = join(directory, "existing.jsonl");
  await writeFile(existing, "keep existing bytes");
  const snapshot = captureSnapshot(fixture([]).manager, "/project");
  await assert.rejects(writeSnapshot(snapshot, { sessionDir: existing, title: "Task" }));
  assert.equal(await readFile(existing, "utf8"), "keep existing bytes");
});
