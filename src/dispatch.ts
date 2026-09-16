import { join, resolve } from "node:path";
import { captureSnapshot, writeSnapshot } from "./session.ts";
import type { DispatchJob, StoredJob } from "./jobs.ts";
import { createJobDirectory, writePrivate } from "./jobs.ts";
import { currentPiCommand, launchShellCommand, taskTitle } from "./launch-plan.ts";
import { preflight, launchTerminal, OrcaError } from "./orca.ts";

export interface DispatchInput {
  manager: Parameters<typeof captureSnapshot>[0];
  sessionDir: string;
  cwd: string;
  model: { provider: string; id: string };
  thinkingLevel: string;
  activeTools: string[];
  packageDir: string;
  orcaCommand?: string;
  /** False after the parent switches sessions or shuts down. */
  isCurrent?: () => boolean;
  launchCommand?: ReturnType<typeof currentPiCommand>;
}
export interface DispatchDependencies {
  preflight: typeof preflight;
  launchTerminal: typeof launchTerminal;
}

export class DispatchError extends Error {
  stored?: StoredJob;
  ambiguous: boolean;
  constructor(message: string, stored?: StoredJob, ambiguous = false) {
    super(message);
    this.name = "DispatchError";
    this.stored = stored;
    this.ambiguous = ambiguous;
  }
}

export async function dispatchTask(
  prompt: string,
  input: DispatchInput,
  deps: DispatchDependencies = { preflight, launchTerminal },
): Promise<StoredJob> {
  if (!prompt.trim()) throw new DispatchError("別タブへ渡す指示を入力してください。");
  if (prompt.includes("\0")) throw new DispatchError("指示には NUL 文字を使用できません。");
  const checkCurrent = () => {
    if (input.isCurrent && !input.isCurrent()) throw new DispatchError("元セッションが切り替わったため、起動を中止しました。");
  };
  checkCurrent();
  // Capture all live state together before the first await. No parent mutation.
  const snapshot = captureSnapshot(input.manager, input.cwd);
  const launch = input.launchCommand ?? currentPiCommand();
  const activeTools = [...input.activeTools];
  // Pi hands over its full model object. Only the identity is stored, so job.json
  // stays readable and no endpoint or pricing detail is copied into the job.
  const model = { provider: input.model.provider, id: input.model.id };
  const title = taskTitle(prompt);
  const observerPath = join(input.packageDir, "observer.ts");
  // A dispatched session may itself dispatch. Do not add another copy of its
  // observer, which would register duplicate input/status handlers.
  const resourceArgs: string[] = [];
  for (let i = 0; i < launch.resourceArgs.length; i++) {
    const flag = launch.resourceArgs[i];
    if ((flag === "-e" || flag === "--extension") && launch.resourceArgs[i + 1]
      && resolve(input.cwd, launch.resourceArgs[i + 1]) === observerPath) { i++; continue; }
    resourceArgs.push(flag);
  }
  const target = await deps.preflight({ cwd: input.cwd, orcaCommand: input.orcaCommand });
  checkCurrent();
  const child = await writeSnapshot(snapshot, { sessionDir: input.sessionDir, title });
  const directory = await createJobDirectory(input.sessionDir, snapshot.parentSessionId, child.sessionId);
  const taskFile = join(directory, "task.txt");
  const jobPath = join(directory, "job.json");
  await writePrivate(taskFile, prompt);
  const job: DispatchJob = {
    version: 1,
    id: child.sessionId,
    sourceSessionId: snapshot.parentSessionId,
    sourceLeafId: snapshot.leafId,
    sessionFile: child.sessionFile,
    // Lets cleanup tell an untouched snapshot from a conversation worked on in the child.
    snapshotLines: snapshot.entries.length + 2,
    cwd: input.cwd,
    title,
    command: launch.command,
    args: [
      ...resourceArgs,
      "--session", child.sessionFile,
      "--provider", model.provider, "--model", model.id,
      "--thinking", input.thinkingLevel,
      "-e", observerPath,
      `@${taskFile}`,
    ],
    activeTools,
    createdAt: new Date().toISOString(),
    taskFile,
    model,
    ...(process.env.PI_CODING_AGENT_DIR ? { env: { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } } : {}),
  };
  await writePrivate(jobPath, JSON.stringify(job, null, 2) + "\n");
  const stored: StoredJob = { job, path: jobPath, receipt: {} };
  try {
    checkCurrent();
    const terminal = await deps.launchTerminal({
      cwd: input.cwd,
      worktreeId: target.worktreeId,
      title,
      command: launchShellCommand(process.execPath, join(input.packageDir, "bin", "launch.mjs"), jobPath),
      orcaCommand: input.orcaCommand,
    });
    stored.receipt = { handle: terminal.handle, ...(terminal.warning ? { warning: terminal.warning } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const ambiguous = error instanceof OrcaError && error.ambiguous;
    stored.receipt = { error: message, ambiguous };
    await writePrivate(join(directory, "receipt.json"), JSON.stringify(stored.receipt) + "\n").catch(() => {});
    throw new DispatchError(message, stored, ambiguous);
  }
  // Failure to save a receipt must never trigger another terminal creation.
  try { await writePrivate(join(directory, "receipt.json"), JSON.stringify(stored.receipt) + "\n"); }
  catch { stored.receipt.warning = "起動済みですがタブ情報を保存できませんでした。Orca のタブから開いてください。"; }
  return stored;
}
