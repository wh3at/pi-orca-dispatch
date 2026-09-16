import { randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

/** The public read-only pi API used by this module. */
export interface SnapshotSessionManager {
  getHeader(): unknown;
  getBranch(): readonly unknown[];
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
}

export interface SnapshotHeader extends Record<string, unknown> {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SnapshotEntry extends Record<string, unknown> {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionSnapshot {
  header: SnapshotHeader;
  entries: SnapshotEntry[];
  parentSessionId: string;
  parentSessionFile?: string;
  leafId: string | null;
}

export interface WriteSnapshotOptions {
  sessionDir: string;
  title: string;
}

export interface WrittenSnapshot {
  sessionId: string;
  sessionFile: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Copy the actual JSON representation, including extension-owned fields. */
function copyJson<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (error) {
    throw new Error("The session contains data that cannot be saved as JSON.", {
      cause: error,
    });
  }
}

function validateSnapshot(snapshot: SessionSnapshot): void {
  const header: unknown = snapshot.header;
  if (!record(header) || header.type !== "session" || header.version !== 3) {
    throw new Error("Orca dispatch requires pi session format version 3.");
  }
  if (
    !nonemptyString(header.id) ||
    !nonemptyString(header.timestamp) ||
    !nonemptyString(header.cwd) ||
    header.id !== snapshot.parentSessionId
  ) {
    throw new Error("The parent session header is invalid or changed during capture.");
  }
  if (
    snapshot.parentSessionFile !== undefined &&
    !nonemptyString(snapshot.parentSessionFile)
  ) {
    throw new Error("The parent session file path is invalid.");
  }
  if (!Array.isArray(snapshot.entries)) {
    throw new Error("The session branch is invalid.");
  }

  const previousIds = new Set<string>();
  let previousId: string | null = null;
  for (const value of snapshot.entries) {
    const entry: unknown = value;
    if (
      !record(entry) ||
      !nonemptyString(entry.type) ||
      entry.type === "session" ||
      !nonemptyString(entry.id) ||
      !nonemptyString(entry.timestamp) ||
      entry.parentId !== previousId ||
      previousIds.has(entry.id)
    ) {
      throw new Error("The current session branch has an invalid parent chain.");
    }
    if (
      entry.type === "compaction" &&
      (!nonemptyString(entry.firstKeptEntryId) ||
        !previousIds.has(entry.firstKeptEntryId))
    ) {
      throw new Error("A compaction references an entry outside the captured branch.");
    }
    previousIds.add(entry.id);
    previousId = entry.id;
  }
  if (snapshot.leafId !== previousId) {
    throw new Error("The current session leaf does not match the captured branch.");
  }
}

/**
 * Capture only the active branch from memory. No parent file is opened and no
 * session-switching API is called, including for an unpersisted parent session.
 */
export function captureSnapshot(
  manager: SnapshotSessionManager,
  cwd: string,
): SessionSnapshot {
  if (!nonemptyString(cwd)) {
    throw new Error("A working directory is required to capture the session.");
  }
  const sourceHeader = manager.getHeader();
  if (!record(sourceHeader)) {
    throw new Error("The parent session has no valid header.");
  }
  const parentSessionFile = manager.getSessionFile();
  const snapshot = copyJson({
    header: { ...sourceHeader, cwd } as SnapshotHeader,
    entries: manager.getBranch() as SnapshotEntry[],
    parentSessionId: manager.getSessionId(),
    ...(parentSessionFile === undefined ? {} : { parentSessionFile }),
    leafId: manager.getLeafId(),
  });
  validateSnapshot(snapshot);
  return snapshot;
}

/** Write a separately resumable session while preserving all original entry IDs. */
export async function writeSnapshot(
  snapshot: SessionSnapshot,
  options: WriteSnapshotOptions,
): Promise<WrittenSnapshot> {
  // Serialize before awaiting IO so callers cannot change the captured data
  // while the directory or file is being created.
  const captured = copyJson(snapshot);
  validateSnapshot(captured);
  if (!nonemptyString(options.sessionDir)) {
    throw new Error("A session directory is required.");
  }
  if (typeof options.title !== "string" || options.title.trim().length === 0) {
    throw new Error("A title is required for the dispatched session.");
  }

  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const directory = resolve(options.sessionDir);
  const sessionFile = join(
    directory,
    `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
  );
  // A memory-only parent must not accidentally inherit its own parent's path.
  const { parentSession: _previousParent, ...sourceHeader } = captured.header;
  const header: SnapshotHeader = {
    ...sourceHeader,
    id: sessionId,
    timestamp,
    ...(captured.parentSessionFile === undefined
      ? {}
      : { parentSession: captured.parentSessionFile }),
  };
  const existingIds = new Set(captured.entries.map((entry) => entry.id));
  let titleEntryId: string;
  do {
    titleEntryId = randomUUID();
  } while (existingIds.has(titleEntryId));
  const titleEntry: SnapshotEntry = {
    type: "session_info",
    id: titleEntryId,
    parentId: captured.leafId,
    timestamp,
    name: options.title.trim(),
  };
  const contents = [header, ...captured.entries, titleEntry]
    .map((entry) => JSON.stringify(entry))
    .join("\n") + "\n";

  await mkdir(directory, { recursive: true, mode: 0o700 });
  let handle: FileHandle | undefined;
  let created = false;
  try {
    handle = await open(sessionFile, "wx", 0o600);
    created = true;
    await handle.writeFile(contents, "utf8");
    await handle.close();
    handle = undefined;
    return { sessionId, sessionFile };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(sessionFile).catch(() => undefined);
    throw error;
  }
}
