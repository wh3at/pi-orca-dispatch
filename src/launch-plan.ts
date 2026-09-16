import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface LaunchCommand { command: string[]; resourceArgs: string[] }

// Keep configuration inputs, never the parent's prompt, --resume, --session,
// credentials, or print/RPC mode. The child must get its own interactive session.
const VALUE_FLAGS = new Set([
  "-e", "--extension", "--skill", "--prompt-template", "--theme",
  "--system-prompt", "--append-system-prompt",
  "--use-theme", "--tui-mode",
]);
const BOOLEAN_FLAGS = new Set([
  "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
  "-ne", "-ns", "-np", "--no-context-files", "-nc", "--no-approve", "-na",
]);

export function inheritResourceArgs(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (BOOLEAN_FLAGS.has(arg)) result.push(arg);
    else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`起動引数 ${arg} の値がありません。`);
      result.push(arg, value);
    }
  }
  return result;
}

export function currentPiCommand(
  argv: readonly string[] = process.argv,
  executable: string = process.execPath,
): LaunchCommand {
  const entrypoint = argv[1];
  if (!entrypoint || !existsSync(entrypoint)) {
    throw new Error("pi の起動ファイルを特定できません。Node.js 版の pi から実行してください。");
  }
  return {
    command: [executable, isAbsolute(entrypoint) ? entrypoint : resolve(entrypoint)],
    resourceArgs: inheritResourceArgs(argv.slice(2)),
  };
}

export function shellQuote(value: string): string {
  if (value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error("起動パスに改行または NUL を含めることはできません。");
  }
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** PowerShell string literal: single quotes only, doubling is the whole escape. */
function powerShellQuote(value: string): string {
  if (value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error("起動パスに改行または NUL を含めることはできません。");
  }
  return "'" + value.replaceAll("'", "''") + "'";
}

/**
 * Builds the `--command` text Orca types into the new terminal. Orca's Windows
 * shell is configurable (PowerShell, CMD, or WSL), so Windows sends the argv
 * through one base64 PowerShell command: the visible text then has no quote or
 * metacharacter that CMD and PowerShell would parse differently, and the paths
 * with spaces stay intact.
 */
export function launchShellCommand(
  node: string,
  launcher: string,
  jobPath: string,
  platform: string = process.platform,
): string {
  if (platform === "win32") {
    const script = [node, launcher, jobPath].map(powerShellQuote).join(" ");
    return `powershell -NoProfile -EncodedCommand ${Buffer.from(`& ${script}`, "utf16le").toString("base64")}`;
  }
  return [node, launcher, jobPath].map(shellQuote).join(" ");
}

export function taskTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u).find((line) => line.trim()) ?? "作業";
  const clean = firstLine.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
  const chars = Array.from(clean);
  return `pi: ${chars.slice(0, 54).join("")}${chars.length > 54 ? "…" : ""}`;
}
