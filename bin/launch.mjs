#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

function nonempty(value) {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function validStrings(value) {
  return Array.isArray(value) && value.every((part) => typeof part === "string" && !part.includes("\0"));
}

function validEnvironment(value) {
  return value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([key, entry]) => key === "PI_CODING_AGENT_DIR" && nonempty(entry)));
}

function readJob(path) {
  const job = JSON.parse(readFileSync(path, "utf8"));
  if (!job || job.version !== 1 || !nonempty(job.id)
    || !nonempty(job.sessionFile) || !isAbsolute(job.sessionFile)
    || !nonempty(job.cwd) || !isAbsolute(job.cwd)
    || !validStrings(job.command) || !nonempty(job.command[0])
    || !validStrings(job.args) || !validStrings(job.activeTools) || !job.activeTools.every(nonempty)
    || !nonempty(job.createdAt) || !validEnvironment(job.env)) {
    throw new Error("Invalid dispatch job. The saved session can be resumed manually.");
  }
  return job;
}

function writeStatus(jobPath, job, detail) {
  const destination = join(dirname(jobPath), "runner-status.json");
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({
      version: 1, id: job.id, updatedAt: new Date().toISOString(), ...detail,
    }) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, destination);
  } finally {
    try { unlinkSync(temporary); } catch { /* Already renamed or not created. */ }
  }
}

function say(message) {
  process.stderr.write(`[pi-orca-dispatch] ${message}\n`);
}

async function main() {
  if (process.argv.length !== 3 || !isAbsolute(process.argv[2])) {
    say("Usage: node launch.mjs /absolute/path/to/job.json");
    process.exitCode = 64;
    return;
  }
  const jobPath = resolve(process.argv[2]);
  let job;
  try { job = readJob(jobPath); } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    process.exitCode = 65;
    return;
  }

  // A terminal-create request can time out after Orca already created the tab.
  // Claim once so opening the saved job again cannot run the same task twice.
  try {
    const fd = openSync(join(dirname(jobPath), "claimed"), "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n");
    } finally { closeSync(fd); }
  } catch (error) {
    say(error?.code === "EEXIST"
      ? "This dispatch was already claimed; a second pi was not started."
      : `Cannot claim this dispatch: ${error instanceof Error ? error.message : String(error)}`);
    say(`Saved session for manual resume: ${job.sessionFile}`);
    process.exitCode = 73;
    return;
  }

  const status = (detail) => {
    try { writeStatus(jobPath, job, detail); } catch (error) {
      say(`Cannot update runner status: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let child;
  try {
    child = spawn(job.command[0], [...job.command.slice(1), ...job.args], {
      cwd: job.cwd,
      stdio: "inherit",
      env: { ...process.env, ...job.env, PI_ORCA_DISPATCH_JOB: jobPath },
      shell: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status({ state: "failed", exitCode: 127, error: message });
    say(`Could not start pi: ${message}`);
    say(`Saved session for manual resume: ${job.sessionFile}`);
    process.exitCode = 127;
    return;
  }

  // Keep the wrapper alive until pi closes and restores its terminal. Inherited
  // stdin/stdout/stderr preserve the TUI and terminal resize behavior.
  const relays = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const relay = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    relays.set(signal, relay);
    process.on(signal, relay);
  }
  let spawnError;
  child.once("spawn", () => status({ state: "started", pid: child.pid }));
  child.once("error", (error) => { spawnError = error; });
  const result = await new Promise((resolveExit) => child.once("close", (code, signal) => resolveExit({ code, signal })));
  for (const [signal, relay] of relays) process.off(signal, relay);

  if (spawnError) {
    status({ state: "failed", exitCode: 127, error: spawnError.message });
    say(`Could not start pi: ${spawnError.message}`);
    say(`Saved session for manual resume: ${job.sessionFile}`);
    process.exitCode = 127;
    return;
  }
  const exitCode = result.code ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 1) : 1);
  status({ state: "exited", pid: child.pid, exitCode, signal: result.signal });
  process.exitCode = exitCode;
}

await main();
