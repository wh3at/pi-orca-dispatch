import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface OrcaOptions {
  cwd: string;
  /** Executable path, not a shell command. */
  orcaCommand?: string;
  timeoutMs?: number;
}

export interface OrcaTarget {
  worktreeId: string;
  worktreePath: string;
}

export interface LaunchTerminalOptions extends OrcaOptions {
  title: string;
  command: string;
  /** Pass the ID returned by preflight to pin the workspace. */
  worktreeId?: string;
}

export interface LaunchedTerminal {
  handle: string;
  surface?: 'background' | 'visible';
  warning?: string;
}

export class OrcaError extends Error {
  readonly code: string;
  /** True means the host may already have created the terminal. Never auto-retry. */
  readonly ambiguous: boolean;

  constructor(message: string, code: string, ambiguous: boolean) {
    super(message);
    this.name = 'OrcaError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const PRE_MUTATION_ERRORS = new Set([
  'invalid_argument',
  'selector_not_found',
  'selector_ambiguous',
  'unknown_command',
  'runtime_unavailable',
  'incompatible_runtime',
]);

/** The CLI name Orca installs per platform. Linux avoids the GNOME screen reader. */
export function orcaCliName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'linux' ? 'orca-ide' : 'orca';
}

/**
 * Finds a command on PATH by stat, never by running it: on Linux bare `orca` is
 * the GNOME screen reader and starting it would speak on the user's machine.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  // Windows shims are usually .cmd/.exe, so the extension list decides the match.
  const extensions = platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((value) => value.toLowerCase())]
    : [''];
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch { /* Keep looking. */ }
    }
  }
  return undefined;
}

/**
 * Resolves the Orca CLI from Orca's own environment and the OS defaults, so a
 * plain pi session needs no extension-specific configuration. Linux resolves to
 * `orca-ide` and never falls back to bare `orca`; macOS and Windows use `orca`.
 */
export function resolveOrcaCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const explicit = env.ORCA_CLI_COMMAND?.trim();
  if (explicit) return explicit;
  if (env.ORCA_DEV_REPO_ROOT) return 'orca-dev';
  return findExecutable(orcaCliName(platform), env, platform);
}

export interface OrcaSpawnPlan {
  file: string;
  args: string[];
  /** cmd.exe parses its own command line, so Node must not quote again. */
  verbatim: boolean;
}

/**
 * Escapes one argument for cmd.exe. Node refuses to launch .bat/.cmd without a
 * shell, so batch shims are spawned through cmd.exe with these escaping rules,
 * which follow cross-spawn's battle-tested implementation.
 */
function escapeForCmd(value: string, doubleEscapeMetaChars: boolean): string {
  let escaped = value.replace(/(?=(\\+?)?)\1"/gu, '$1$1\\"');
  escaped = escaped.replace(/(?=(\\+?)?)\1$/u, '$1$1');
  escaped = `"${escaped}"`.replace(/([()%!^"<>&|;, *?])/gu, '^$1');
  return doubleEscapeMetaChars ? escaped.replace(/(?=(\\+?)?)\1"/gu, '$1$1\\"') : escaped;
}

/** Batch shims need cmd.exe and .ps1 needs PowerShell; everything else is direct. */
export function orcaSpawnPlan(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OrcaSpawnPlan {
  if (platform !== 'win32') return { file: command, args, verbatim: false };
  const extension = extname(command).toLowerCase();
  if (extension === '.cmd' || extension === '.bat') {
    return {
      file: env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', `"${escapeForCmd(command, true)} ${args.map((value) => escapeForCmd(value, false)).join(' ')}"`],
      verbatim: true,
    };
  }
  if (extension === '.ps1') {
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', command, ...args], verbatim: false };
  }
  return { file: command, args, verbatim: false };
}

async function callOrca(
  args: string[],
  options: OrcaOptions,
  mutation: boolean,
): Promise<Record<string, unknown>> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OrcaError('Orca timeout must be a positive number.', 'invalid_argument', false);
  }
  const command = options.orcaCommand ?? resolveOrcaCommand();
  if (!command) {
    throw new OrcaError(
      `Orca CLI (${orcaCliName()}) not found. Install the Orca app or set ORCA_CLI_COMMAND to its CLI executable.`,
      'orca_cli_missing',
      false,
    );
  }
  const plan = orcaSpawnPlan(command, args);
  return new Promise((resolveResult, reject) => {
    // Orca owns the shell interpretation of --command. The outer invocation must
    // remain argv-based so user prompts, titles, and paths cannot become shell code.
    execFile(
      plan.file,
      plan.args,
      {
        cwd: options.cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: plan.verbatim,
      },
      (error, stdout, stderr) => {
        if (error && (error.code === 'ENOENT' || error.code === 'EACCES')) {
          reject(new OrcaError(
            `Cannot start Orca CLI (${command}). Register it in Orca settings and check its executable path.`,
            String(error.code),
            false,
          ));
          return;
        }
        if (error?.killed || error?.signal) {
          reject(new OrcaError(
            mutation
              ? 'Orca did not confirm terminal creation before the request stopped. The terminal may already exist; check Orca before dispatching again.'
              : 'Orca did not respond before the request stopped. Check that Orca is running.',
            'orca_timeout',
            mutation,
          ));
          return;
        }
        let envelope: Record<string, unknown> | undefined;
        try {
          envelope = object(JSON.parse(stdout));
        } catch {
          // Handled with the same conservative rule as a truncated JSON envelope.
        }
        if (envelope?.ok === false) {
          const details = object(envelope.error);
          const code = nonempty(details?.code) ? details.code : 'orca_error';
          const message = nonempty(details?.message) ? details.message : 'Orca rejected the request.';
          reject(new OrcaError(message, code, mutation && !PRE_MUTATION_ERRORS.has(code)));
          return;
        }
        const result = envelope?.ok === true ? object(envelope.result) : undefined;
        if (error || !result) {
          const diagnostic = stderr.trim().slice(0, 600);
          reject(new OrcaError(
            `Orca returned no valid success response.${diagnostic ? ` ${diagnostic}` : ''}${mutation ? ' The terminal may already exist; check Orca before dispatching again.' : ''}`,
            error ? 'orca_process_failed' : 'orca_invalid_response',
            mutation,
          ));
          return;
        }
        resolveResult(result);
      },
    );
  });
}

/** Resolves the enclosing managed worktree and verifies that the local runtime is reachable. */
export async function preflight(options: OrcaOptions): Promise<OrcaTarget> {
  // `current` resolves nested cwd paths and rejects paired remote runtime targets,
  // whose paths cannot safely reference this machine's session file.
  const result = await callOrca(['worktree', 'current', '--json'], options, false);
  const worktree = object(result.worktree);
  if (!nonempty(worktree?.id) || !nonempty(worktree?.path) || !isAbsolute(worktree.path)) {
    throw new OrcaError('Orca returned an invalid current worktree.', 'orca_invalid_response', false);
  }
  if ((nonempty(worktree.hostId) && worktree.hostId !== 'local') || nonempty(worktree.runtimeOwnerEnvironmentId)) {
    throw new OrcaError(
      'This Orca worktree runs on another host. Dispatch from pi running on the worktree host so the new terminal can read its session files.',
      'orca_remote_worktree',
      false,
    );
  }
  const worktreePath = resolve(worktree.path);
  const inside = relative(worktreePath, resolve(options.cwd));
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new OrcaError('The current Orca worktree does not contain this pi session directory.', 'orca_wrong_worktree', false);
  }
  return { worktreeId: worktree.id, worktreePath };
}

/** Creates the tab and reveals it, so the dispatched session becomes the active one. */
export async function launchTerminal(options: LaunchTerminalOptions): Promise<LaunchedTerminal> {
  const selector = options.worktreeId ? `id:${options.worktreeId}` : `path:${resolve(options.cwd)}`;
  const result = await callOrca(
    ['terminal', 'create', '--worktree', selector, '--title', options.title, '--command', options.command, '--focus', '--json'],
    options,
    true,
  );
  const terminal = object(result.terminal);
  if (!nonempty(terminal?.handle)) {
    throw new OrcaError(
      'Orca confirmed a request without a terminal handle. Check Orca before dispatching again.',
      'orca_invalid_response',
      true,
    );
  }
  return {
    handle: terminal.handle,
    ...(terminal.surface === 'background' || terminal.surface === 'visible' ? { surface: terminal.surface } : {}),
    ...(nonempty(terminal.warning) ? { warning: terminal.warning } : {}),
  };
}

/** User-initiated navigation from the dispatched-session list. */
export async function switchTerminal(options: OrcaOptions & { handle: string }): Promise<void> {
  const result = await callOrca(
    ['terminal', 'switch', '--terminal', options.handle, '--json'],
    options,
    false,
  );
  const focus = object(result.focus);
  if (focus?.handle !== options.handle) {
    throw new OrcaError('Orca did not confirm the selected terminal.', 'orca_invalid_response', false);
  }
}

/** Closes one tab. Only `/orca-dispatch --clean` calls this, best-effort. */
export async function closeTerminal(options: OrcaOptions & { handle: string }): Promise<void> {
  const result = await callOrca(
    ['terminal', 'close', '--terminal', options.handle, '--json'],
    options,
    false,
  );
  const close = object(result.close);
  if (close?.handle !== options.handle) {
    throw new OrcaError('Orca did not confirm closing the terminal.', 'orca_invalid_response', false);
  }
}
