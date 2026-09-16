import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface DispatchJob {
  version: 1;
  id: string;
  sourceSessionId: string;
  sourceLeafId: string | null;
  sessionFile: string;
  snapshotLines?: number;
  cwd: string;
  title: string;
  command: string[];
  args: string[];
  activeTools: string[];
  createdAt: string;
  taskFile: string;
  model: { provider: string; id: string };
  env?: { PI_CODING_AGENT_DIR: string };
}
export interface LaunchReceipt { handle?: string; warning?: string; error?: string; ambiguous?: boolean }
export interface StoredJob { job: DispatchJob; path: string; receipt: LaunchReceipt }
export interface JobStatus { state: string; label: string; error?: string }

export function resolveSessionDir(value: string, cwd: string): string {
  if (value) return resolve(value);
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const safePath = `--${resolve(cwd).replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  return join(agentDir, "sessions", safePath);
}

export function jobsDirectory(sessionDir: string, parentId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parentId) || parentId.includes("..")) {
    throw new Error("セッション ID の形式を確認できません。");
  }
  return join(sessionDir, "orca-dispatch", parentId);
}

export async function writePrivate(path: string, content: string): Promise<void> {
  await writeFile(path, content, { flag: "wx", mode: 0o600 });
}

export async function readObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

async function readJobsIn(parentDir: string, parentId: string): Promise<StoredJob[]> {
  let dirs;
  try { dirs = await readdir(parentDir, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: StoredJob[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const path = join(parentDir, dir.name, "job.json");
    const job = await readObject(path);
    if (job?.version !== 1 || job.sourceSessionId !== parentId || job.id !== dir.name || typeof job.title !== "string") continue;
    const receipt = await readObject(join(parentDir, dir.name, "receipt.json")) ?? {};
    jobs.push({ job: job as unknown as DispatchJob, path, receipt: receipt as LaunchReceipt });
  }
  return jobs;
}

function newestFirst(jobs: StoredJob[]): StoredJob[] {
  // Same-millisecond dispatches keep a stable order in --list.
  return jobs.sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt) || b.job.id.localeCompare(a.job.id));
}

export async function listJobs(sessionDir: string, parentId: string): Promise<StoredJob[]> {
  return newestFirst(await readJobsIn(jobsDirectory(sessionDir, parentId), parentId));
}

/** Jobs left behind by other sessions in this project. Nothing else lists them. */
export async function listOrphanJobs(sessionDir: string, currentParentId: string): Promise<StoredJob[]> {
  const root = join(sessionDir, "orca-dispatch");
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jobs: StoredJob[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || dir.name === currentParentId) continue;
    jobs.push(...await readJobsIn(join(root, dir.name), dir.name));
  }
  return newestFirst(jobs);
}

/** `starting` and `unknown` are not finished: their tab may still run the child. */
export function isFinished(state: string): boolean {
  return state === "closed" || state === "failed";
}

/**
 * True only while the dispatched child never added anything to its snapshot.
 * Jobs without a recorded line count are treated as used, so cleanup can never
 * delete a conversation that was actually worked on.
 */
export async function snapshotUnused(stored: StoredJob): Promise<boolean> {
  const expected = stored.job.snapshotLines;
  if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 2) return false;
  try {
    const lines = (await readFile(stored.job.sessionFile, "utf8")).split("\n").filter((line) => line !== "");
    return lines.length === expected;
  } catch {
    return false;
  }
}

/** Drops a job from the list, and its derived session file only when asked. */
export async function removeJob(stored: StoredJob, options: { snapshot: boolean }): Promise<void> {
  if (options.snapshot) await rm(stored.job.sessionFile, { force: true });
  await rm(dirname(stored.path), { recursive: true, force: true });
}

export async function statusOf(stored: StoredJob): Promise<JobStatus> {
  const directory = join(stored.path, "..");
  const [runner, agent] = await Promise.all([
    readObject(join(directory, "runner-status.json")),
    readObject(join(directory, "agent-status.json")),
  ]);
  if (runner?.id === stored.job.id && runner.state === "failed") {
    return { state: "failed", label: "起動エラー", error: String(runner.error ?? "pi を起動できませんでした。") };
  }
  if (runner?.id === stored.job.id && runner.state === "exited") {
    return runner.exitCode === 0
      ? { state: "closed", label: "終了" }
      : { state: "failed", label: "エラー終了", error: `pi exit=${runner.exitCode ?? runner.signal ?? "unknown"}` };
  }
  if (agent?.id === stored.job.id) {
    const labels: Record<string, string> = { ready: "起動済み", working: "実行中", idle: "待機中", closed: "セッション終了", blocked: "起動エラー" };
    if (typeof agent.state === "string" && labels[agent.state]) {
      return { state: agent.state, label: labels[agent.state], ...(typeof agent.error === "string" ? { error: agent.error } : {}) };
    }
  }
  if (stored.receipt.error) return {
    state: stored.receipt.ambiguous ? "unknown" : "failed",
    label: stored.receipt.ambiguous ? "起動状況未確認" : "起動エラー",
    error: stored.receipt.error,
  };
  return Date.now() - Date.parse(stored.job.createdAt) > 30_000
    ? { state: "unknown", label: "起動状況未確認", error: "pi の起動を確認できません。Orca のタブを開いて確認してください。" }
    : { state: "starting", label: "起動待ち" };
}

export async function createJobDirectory(sessionDir: string, parentId: string, id: string): Promise<string> {
  const parent = jobsDirectory(sessionDir, parentId);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = join(parent, id);
  await mkdir(directory, { mode: 0o700 });
  return directory;
}
