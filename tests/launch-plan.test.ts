import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { currentPiCommand, shellQuote } from "../src/launch-plan.ts";

const standalone = { bun: "1.4.4", node: "26.3.0" };

test("standalone pi reexecutes itself without its embedded entrypoint and uses external Node", () => {
  const plan = currentPiCommand(["bun", "/$bunfs/root/pi", "-e", "custom.ts", "old prompt"], "/opt/pi's folder/pi", standalone);
  assert.deepEqual(plan.command, ["/opt/pi's folder/pi"]);
  assert.equal(plan.launcherNode, process.execPath);
  assert.deepEqual(plan.resourceArgs, ["-e", "custom.ts"]);
});

test("Node pi retains the parent executable and on-disk entrypoint", () => {
  const plan = currentPiCommand([process.execPath, import.meta.filename, "--no-skills"], process.execPath, process.versions);
  assert.deepEqual(plan.command, [process.execPath, import.meta.filename]);
  assert.equal(plan.launcherNode, process.execPath);
  assert.deepEqual(plan.resourceArgs, ["--no-skills"]);
});

test("standalone resolution fails clearly without external Node", () => {
  assert.throws(() => currentPiCommand(["bun", "/$bunfs/root/pi"], "/pi", standalone, { PATH: "" }), /Node.js.*22\.19\.0/u);
});

test("unsupported runtimes and absent Node entrypoints are rejected", () => {
  assert.throws(() => currentPiCommand(["bun", import.meta.filename], "/bun", standalone), /起動形態/u);
  assert.throws(() => currentPiCommand(["node", "/$bunfs/root/pi"], process.execPath, process.versions), /起動形態/u);
  assert.throws(() => currentPiCommand(["node", "/missing/pi.js"], process.execPath, process.versions), /起動パス/u);
  assert.throws(() => currentPiCommand(["unknown", import.meta.filename], "/unknown", {}), /起動形態/u);
});

test("Windows embedded entrypoints never become child arguments", () => {
  assert.deepEqual(currentPiCommand(["bun", "B:\\~BUN\\root\\pi"], "/parent-pi", standalone).command, ["/parent-pi"]);
});

test("Node version and runtime identity are validated, including PATH entries with quotes and spaces", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX executable fixture");
  const root = await mkdtemp(join(tmpdir(), "node's path "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const node = join(root, "node");
  for (const [version, bun, valid] of [["22.18.0", false, false], ["22.19.0", false, true], ["24.0.0", false, true], ["26.0.0", true, false]] as const) {
    const result = JSON.stringify({ release: "node", version, bun, executable: node });
    await writeFile(node, `#!/bin/sh\nprintf '%s' '${result.replaceAll("'", "'\\''")}'\n`);
    await chmod(node, 0o700);
    const resolve = () => currentPiCommand(["bun", "/$bunfs/root/pi"], "/pi", standalone, { PATH: root });
    if (valid) assert.equal(resolve().launcherNode, node);
    else assert.throws(resolve, /Node.js.*22\.19\.0/u);
  }
  assert.equal(dirname(currentPiCommand(["bun", "/$bunfs/root/pi"], "/pi", standalone).launcherNode), dirname(process.execPath));
});

test("Node shims are invoked by their PATH name, then pinned to the actual Node executable", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX shim fixture");
  const root = await mkdtemp(join(tmpdir(), "node-shim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shim = join(root, "runtime-manager");
  await writeFile(shim, `#!/bin/sh\ncase "$0" in */node) exec ${shellQuote(process.execPath)} "$@";; *) exit 77;; esac\n`, { mode: 0o700 });
  await symlink(shim, join(root, "node"));
  const plan = currentPiCommand(["bun", "/$bunfs/root/pi"], "/parent/pi", standalone, { PATH: root });
  assert.equal(plan.launcherNode, process.execPath);
  assert.deepEqual(plan.command, ["/parent/pi"]);
});
