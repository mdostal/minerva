// agnostic-plan-driver.test.ts — hermetic tests for the runner-agnostic PLAN driver.
// No network, no real runtime: AgnosticPlanDriver is pointed at a tiny fake CLI that echoes
// back its argv + a canned {session_id, result} line, so we assert the arg adapter and the
// output parsing without spawning gemini/claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgnosticPlanDriver, resolveAgnosticPlanDriver } from "./agnostic-plan-driver.ts";

// A fake plan-agnostic CLI: writes its argv to $FAKE_ARGV_OUT, prints the canned result line.
function writeFakeCli(): { cliPath: string; argvOut: string } {
  const dir = mkdtempSync(join(tmpdir(), "agnostic-cli-"));
  const cliPath = join(dir, "fake-plan-agnostic.mjs");
  const argvOut = join(dir, "argv.json");
  writeFileSync(
    cliPath,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdout.write('some log noise\\n');",
      "process.stdout.write(JSON.stringify({ session_id: 'ses_fake', result: 'PLAN_WRITTEN epic=x stories=3' }) + '\\n');",
    ].join("\n"),
  );
  return { cliPath, argvOut };
}

test("AgnosticPlanDriver initial turn passes --idea and parses {session_id, result}", async () => {
  const { cliPath, argvOut } = writeFakeCli();
  const d = new AgnosticPlanDriver("gemini", "google/gemini-3.1-pro-preview", cliPath);
  const res = await d.runTurn({ cwd: tmpdir(), sessionId: null, prompt: "Add CSV export" });
  assert.equal(res.session_id, "ses_fake");
  assert.match(res.raw_result, /PLAN_WRITTEN epic=x stories=3/);
  const argv = JSON.parse((await import("node:fs")).readFileSync(argvOut, "utf8"));
  assert.deepEqual(argv, [
    "--runtime", "gemini",
    "--model", "google/gemini-3.1-pro-preview",
    "--cwd", tmpdir(),
    "--idea", "Add CSV export",
  ]);
});

test("AgnosticPlanDriver continuation turn passes --session and --prompt (same runtime session)", async () => {
  const { cliPath, argvOut } = writeFakeCli();
  const d = new AgnosticPlanDriver("gemini", "google/gemini-3.1-pro-preview", cliPath);
  await d.runTurn({ cwd: tmpdir(), sessionId: "ses_prev", prompt: "yes proceed" });
  const argv = JSON.parse((await import("node:fs")).readFileSync(argvOut, "utf8"));
  assert.ok(argv.includes("--session"));
  assert.equal(argv[argv.indexOf("--session") + 1], "ses_prev");
  assert.equal(argv[argv.indexOf("--prompt") + 1], "yes proceed");
  assert.ok(!argv.includes("--idea"));
});

test("AgnosticPlanDriver surfaces a non-zero CLI exit as a thrown error (fallback-visible)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agnostic-cli-fail-"));
  const cliPath = join(dir, "fail.mjs");
  writeFileSync(cliPath, "process.stderr.write('boom\\n'); process.exit(3);");
  const d = new AgnosticPlanDriver("gemini", "m", cliPath);
  await assert.rejects(() => d.runTurn({ cwd: "/tmp", sessionId: null, prompt: "x" }), /exited 3/);
});

test("resolveAgnosticPlanDriver returns null in test mode (bulletproof claude fallback)", async () => {
  const prev = process.env.MINERVA_TEST_DRIVE_PROMPT;
  process.env.MINERVA_TEST_DRIVE_PROMPT = "synthetic";
  try {
    assert.equal(await resolveAgnosticPlanDriver(), null);
  } finally {
    if (prev === undefined) delete process.env.MINERVA_TEST_DRIVE_PROMPT;
    else process.env.MINERVA_TEST_DRIVE_PROMPT = prev;
  }
});

test("resolveAgnosticPlanDriver returns null when feature is off", async () => {
  const prev = process.env.MINERVA_PLAN_AGNOSTIC;
  process.env.MINERVA_PLAN_AGNOSTIC = "off";
  try {
    assert.equal(await resolveAgnosticPlanDriver(), null);
  } finally {
    if (prev === undefined) delete process.env.MINERVA_PLAN_AGNOSTIC;
    else process.env.MINERVA_PLAN_AGNOSTIC = prev;
  }
});
