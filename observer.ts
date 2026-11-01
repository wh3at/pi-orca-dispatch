import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

interface Context {
  sessionManager: { getSessionFile(): string | undefined };
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
  model?: { provider: string; id: string };
}

interface ObserverAPI {
  on(event: string, handler: (event: Record<string, unknown>, ctx: Context) => unknown): void;
  getAllTools(): { name: string }[];
  getActiveTools?(): string[];
  setActiveTools(names: string[]): void;
}

interface Job {
  version: 1;
  id: string;
  sessionFile: string;
  activeTools: string[];
  model?: { provider: string; id: string };
}

function normalized(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** Windows paths are case-insensitive, so they are folded there before comparing. */
export function samePath(left: string, right: string): boolean {
  const a = normalized(left);
  const b = normalized(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Loaded only in the child via -e; never adds messages to either conversation. */
export default function observer(pi: ObserverAPI): void {
  const jobPath = process.env.PI_ORCA_DISPATCH_JOB;
  if (!jobPath) return;

  let job: Job | undefined;
  let blockedReason = "Dispatch startup has not finished.";
  let verified = false;
  let detached = false;
  let firstInputPending = false;
  let generation = 0;
  let deadline = 0;
  let registration: Promise<boolean> | undefined;
  let cancelRegistration: (() => void) | undefined;
  let checkRegistration: (() => void) | undefined;
  let acceptingInput = false;

  try {
    if (!isAbsolute(jobPath)) throw new Error("Dispatch job path must be absolute.");
    const candidate = JSON.parse(readFileSync(jobPath, "utf8"));
    if (!candidate || candidate.version !== 1 || typeof candidate.id !== "string" || !candidate.id
      || typeof candidate.sessionFile !== "string" || !isAbsolute(candidate.sessionFile)
      || !Array.isArray(candidate.activeTools)
      || candidate.activeTools.some((name: unknown) => typeof name !== "string" || !name)) {
      throw new Error("Invalid dispatch job.");
    }
    if (candidate.model !== undefined && (!candidate.model
      || typeof candidate.model.provider !== "string" || !candidate.model.provider
      || typeof candidate.model.id !== "string" || !candidate.model.id)) {
      throw new Error("Invalid dispatch model.");
    }
    job = candidate;
  } catch (error) {
    blockedReason = error instanceof Error ? error.message : String(error);
  }

  function matches(ctx: Context): boolean {
    const sessionFile = ctx.sessionManager.getSessionFile();
    return Boolean(job && sessionFile && samePath(sessionFile, job.sessionFile));
  }

  function status(ctx: Context, state: string, error?: string): void {
    // /resume, /new and /clone can retain the CLI extension. Never report their
    // work as this dispatch, or apply this dispatch's tool selection to them.
    if (!job || !matches(ctx)) return;
    const destination = join(dirname(jobPath!), "agent-status.json");
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({
        version: 1, id: job.id, state, pid: process.pid,
        updatedAt: new Date().toISOString(), ...(error ? { error } : {}),
      }) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(temporary, destination);
    } catch {
      // Status is informational; a disk error must not disrupt an agent turn.
    } finally {
      try { unlinkSync(temporary); } catch { /* Already renamed or not created. */ }
    }
  }

  function notifyBlocked(ctx: Context): void {
    ctx.ui.notify(`Orca dispatch did not start: ${blockedReason} The task remains in task.txt beside job.json.`, "error");
  }

  function missingTools(): string[] {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    return job!.activeTools.filter((name) => !available.has(name));
  }

  function waitForTools(ctx: Context): Promise<boolean> {
    const owner = generation;
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let missing = [...job!.activeTools];
      function finish(ready: boolean): void {
        clearTimeout(timer);
        cancelRegistration = undefined;
        checkRegistration = undefined;
        resolve(ready);
      }
      cancelRegistration = () => finish(false);
      function check(): void {
        clearTimeout(timer);
        if (generation !== owner || detached || !matches(ctx)) {
          finish(false);
          return;
        }
        try {
          const remaining = deadline - Date.now();
          if (remaining >= 0) {
            missing = missingTools();
            if (!missing.length) {
              finish(true);
              return;
            }
          }
          if (remaining <= 0) {
            block(ctx, new Error(`Timed out after 30 seconds waiting for tool registration. Required tools are unavailable: ${missing.join(", ")}.`));
            firstInputPending = false;
            finish(false);
            return;
          }
          timer = setTimeout(check, Math.min(100, remaining));
        } catch (error) {
          block(ctx, error);
          firstInputPending = false;
          finish(false);
        }
      }
      checkRegistration = check;
      check();
    });
  }

  function restoreConfiguration(ctx: Context): void {
    if (job!.model && (ctx.model?.provider !== job!.model.provider || ctx.model?.id !== job!.model.id)) {
      const requested = `${job!.model.provider}/${job!.model.id}`;
      const actual = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
      throw new Error(`The requested model ${requested} was not restored (opened ${actual}).`);
    }
    const missing = missingTools();
    if (missing.length) throw new Error(`Required tools are unavailable: ${missing.join(", ")}.`);
    pi.setActiveTools([...job!.activeTools]);
    if (pi.getActiveTools) {
      const active = new Set(pi.getActiveTools());
      if (active.size !== new Set(job!.activeTools).size || job!.activeTools.some((name) => !active.has(name))) {
        throw new Error("The requested tool selection could not be restored.");
      }
    }
  }

  function hasStartedTask(): boolean {
    const markerPath = join(dirname(jobPath!), "task-started");
    let marker;
    try { marker = JSON.parse(readFileSync(markerPath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("The dispatch startup marker could not be read.");
    }
    if (marker?.version !== 1 || marker.id !== job!.id || marker.sessionFile !== job!.sessionFile) {
      throw new Error("The dispatch startup marker does not match this session.");
    }
    return true;
  }

  function markTaskStarted(): void {
    const markerPath = join(dirname(jobPath!), "task-started");
    try {
      writeFileSync(markerPath, JSON.stringify({
        version: 1, id: job!.id, sessionFile: job!.sessionFile,
        pid: process.pid, acceptedAt: new Date().toISOString(),
      }) + "\n", { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && hasStartedTask()) return;
      throw new Error("The accepted dispatch input could not be recorded.");
    }
  }

  function block(ctx: Context, error: unknown): void {
    verified = false;
    blockedReason = error instanceof Error ? error.message : String(error);
    status(ctx, "blocked", blockedReason);
    notifyBlocked(ctx);
  }

  pi.on("session_start", (event, ctx) => {
    cancelRegistration?.();
    registration = undefined;
    generation++;
    deadline = Date.now() + 30_000;
    acceptingInput = false;
    verified = false;
    detached = false;
    firstInputPending = true;
    if (!matches(ctx)) {
      // An intentional session switch is outside the dispatch's ownership.
      if (["new", "resume", "fork", "reload"].includes(String(event.reason))) {
        detached = true;
        return;
      }
      if (job) blockedReason = "The opened session does not match the dispatched session.";
      notifyBlocked(ctx);
      return;
    }
    try {
      // The startup gate belongs to the original dispatched input. After that
      // input was accepted, /reload and /resume retain the user's own model
      // and tool choices instead of applying the parent's old selection again.
      if (hasStartedTask()) {
        verified = true;
        firstInputPending = false;
        status(ctx, "idle");
        return;
      }
      if (missingTools().length) {
        registration = waitForTools(ctx);
        return;
      }
      restoreConfiguration(ctx);
      verified = true;
      status(ctx, "ready");
    } catch (error) {
      block(ctx, error);
    }
  });

  function acceptInput(ctx: Context, owner: number): { action: "handled" } | undefined {
    if (owner !== generation || detached || !matches(ctx)) return { action: "handled" };
    firstInputPending = false;
    acceptingInput = false;
    try {
      restoreConfiguration(ctx);
      markTaskStarted();
      verified = true;
      status(ctx, "ready");
    } catch (error) {
      block(ctx, error);
      return { action: "handled" };
    }
  }

  pi.on("input", (_event, ctx) => {
    if (detached) return;
    if (acceptingInput) return { action: "handled" };
    if (firstInputPending && matches(ctx)) {
      acceptingInput = true;
      const owner = generation;
      try {
        if (registration || missingTools().length) {
          verified = false;
          registration ??= waitForTools(ctx);
          checkRegistration?.();
          return registration.then((ready) => ready ? acceptInput(ctx, owner) : { action: "handled" });
        }
        return acceptInput(ctx, owner);
      } catch (error) {
        firstInputPending = false;
        acceptingInput = false;
        block(ctx, error);
        return { action: "handled" };
      }
    }
    if (!verified || !matches(ctx)) {
      notifyBlocked(ctx);
      return { action: "handled" };
    }
  });
  pi.on("tool_call", (_event, ctx) => {
    if (!detached && (!verified || !matches(ctx))) return { block: true, reason: blockedReason };
  });
  pi.on("agent_start", (_event, ctx) => {
    if (verified) status(ctx, "working");
  });
  pi.on("agent_end", (_event, ctx) => {
    // A run ending can mean a question, error, retry, or completed task. `idle`
    // deliberately makes no assertion about implementation or test success.
    if (verified) status(ctx, "idle");
  });
  pi.on("session_shutdown", (_event, ctx) => {
    generation++;
    cancelRegistration?.();
    status(ctx, "closed");
    verified = false;
    detached = true;
  });
}
