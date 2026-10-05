import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configPath, readPlacement } from "../src/config.ts";

test("global configuration follows the pi agent directory", () => {
  assert.equal(configPath({}), join(homedir(), ".pi", "agent", "orca-dispatch.json"));
  assert.equal(configPath({ PI_CODING_AGENT_DIR: "/custom" }), join("/custom", "orca-dispatch.json"));
});

test("configuration defaults to split and reloads placement each time", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "orca-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "orca-dispatch.json");
  assert.equal(readPlacement(path), "split");
  for (const [settings, expected] of [[{}, "split"], [{ placement: "tab" }, "tab"], [{ placement: "split" }, "split"]] as const) {
    await writeFile(path, JSON.stringify(settings));
    assert.equal(readPlacement(path), expected);
  }
});

test("invalid JSON, objects, placement values and read failures stop dispatch", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "orca-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "orca-dispatch.json");
  for (const content of ["{", "null", "[]", '"tab"', '{"placement":"auto"}', '{"placement":null}', '{"placement":1}']) {
    await writeFile(path, content);
    assert.throws(() => readPlacement(path), new RegExp(path));
  }
  const unreadable = join(directory, "directory");
  await mkdir(unreadable);
  assert.throws(() => readPlacement(unreadable), /読み取れません/u);
});
