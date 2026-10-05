import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const wizardPath = new URL("../.agents/skills/wizard/template.sh", import.meta.url);
const hitlPath = new URL("../.agents/skills/diagnosing-bugs/scripts/hitl-loop.template.sh", import.meta.url);
const requiresBash = { skip: process.platform === "win32" };

test("wizard input helpers preserve defaults, literal input and secret read options", requiresBash, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wizard-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, ".env");
  const template = await readFile(wizardPath, "utf8");
  const library = template.split("\nrun_stages() {")[0];
  for (const helper of ["ask", "ask_secret"]) {
    for (const scenario of [
      { existing: "", input: "new value\\with=$literal\n", expected: "new value\\with=$literal", keeps: false },
      { existing: "TEST_VALUE=first\nTEST_VALUE=saved value\n", input: "\n", expected: "saved value", keeps: true },
      { existing: "TEST_VALUE=old\n", input: "replacement\n", expected: "replacement", keeps: true },
      { existing: "", input: "\n", expected: "", keeps: false },
      { existing: "TEST_VALUE=saved\n", input: "", expected: "saved", keeps: true },
      { existing: "", input: "", expected: "", keeps: false },
    ]) {
      await writeFile(envFile, scenario.existing);
      const output = execFileSync("bash", ["-c", `${library}
read() { printf '%s' "$*" >&2; builtin read "$@"; }
${helper} TEST_VALUE "Value:"
printf 'result=%s' "$TEST_VALUE"
`], { input: scenario.input, encoding: "utf8", env: { ...process.env, ENV_FILE: envFile }, stdio: ["pipe", "pipe", "pipe"] });
      const prompt = `  Value: ${scenario.keeps ? "[Enter keeps current] " : ""}`;
      assert.equal(output, `${prompt}${helper === "ask_secret" ? "\n" : ""}result=${scenario.expected}`);
      assert.equal(await readFile(envFile, "utf8"), scenario.existing);
    }
    const options = execFileSync("bash", ["-c", `${library}
read() { printf '%s' "$*"; builtin read "$@"; }
${helper} TEST_VALUE "Value:"
`], { input: "value\n", encoding: "utf8", env: { ...process.env, ENV_FILE: envFile } });
    assert.ok(options.includes(helper === "ask_secret" ? "-rs input" : "-r input"));
  }
});

test("wizard template keeps script syntax and environment upserts intact", requiresBash, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wizard-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("bash", ["-n", wizardPath.pathname]);
  const envFile = join(directory, ".env");
  await writeFile(envFile, "KEEP=unchanged\nTEST_VALUE=old\nTEST_VALUE=duplicate\n");
  const library = (await readFile(wizardPath, "utf8")).split("\nrun_stages() {")[0];
  execFileSync("bash", ["-c", `${library}
write_env TEST_VALUE 'new value'
write_env TEST_VALUE 'new value'
`], { env: { ...process.env, ENV_FILE: envFile } });
  assert.equal(await readFile(envFile, "utf8"), "KEEP=unchanged\nTEST_VALUE=new value\n");
});

test("HITL template still captures observations without external actions", requiresBash, () => {
  execFileSync("bash", ["-n", hitlPath.pathname]);
  const output = execFileSync("bash", [hitlPath.pathname], { input: "\ny\nExample failure\n", encoding: "utf8" });
  assert.ok(output.endsWith("--- Captured ---\nERRORED=y\nERROR_MSG=Example failure\n"));
});

test("reviewed templates contain no code comments beyond their shebangs", async () => {
  for (const path of [wizardPath, hitlPath]) {
    const content = await readFile(path, "utf8");
    assert.equal(content.split("\n").filter((line) => /^\s*#/u.test(line) && !line.startsWith("#!")).length, 0);
    assert.doesNotMatch(content, /\s+#\s/u);
  }
});
