// agnostic-plan-driver.test.ts — hermetic tests for the runner-agnostic PLAN driver.
// No network, no real runtime: AgnosticPlanDriver is pointed at a tiny fake CLI that echoes
// back its argv + a canned {session_id, result} line, so we assert the arg adapter and the
// output parsing without spawning gemini/claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgnosticPlanDriver,
  agnosticPlanCliPath,
  agnosticPlanDriverFromRecord,
  resolveAgnosticPlanDriver,
  resolvePlanningRoute,
  type PlanningRoute,
} from "./agnostic-plan-driver.ts";

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
  assert.equal(typeof resolvePlanningRoute, "function");
  assert.equal(typeof resolveAgnosticPlanDriver, "function");
  assert.equal(typeof agnosticPlanDriverFromRecord, "function");
  assert.equal(typeof agnosticPlanCliPath, "function");
  const route: PlanningRoute = { runtime: "gemini", model: "google/gemini-3.1-pro-preview" };
  const { cliPath, argvOut } = writeFakeCli();
  const d = new AgnosticPlanDriver(route.runtime, route.model, cliPath);
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

test("agnosticPlanCliPath logs exactly one structured WARN line to stderr when all five candidates are absent, and still returns null", () => {
  // Point homedir() at a freshly-created, empty temp dir: none of the five hardcoded
  // candidates (all rooted at homedir()) can possibly exist under it, and no override env var
  // short-circuits the search -- so this deterministically exercises the "all candidates
  // absent" path regardless of what's actually installed on the host running this test.
  const previousHome = process.env.HOME;
  const previousOverride = process.env.HIVE_PLAN_AGNOSTIC_CLI;
  const fakeHome = mkdtempSync(join(tmpdir(), "agnostic-cli-no-home-"));
  process.env.HOME = fakeHome;
  delete process.env.HIVE_PLAN_AGNOSTIC_CLI;

  const expectedCandidates = [
    join(fakeHome, "code", "plugin-hive-fork-dev", "hive", "agnostic", "plan-agnostic.mjs"),
    join(fakeHome, "Code", "plugin-hive-fork-dev", "hive", "agnostic", "plan-agnostic.mjs"),
    join(fakeHome, "code", "plugin-hive-fork", "hive", "agnostic", "plan-agnostic.mjs"),
    join(fakeHome, "Code", "plugin-hive-fork", "hive", "agnostic", "plan-agnostic.mjs"),
    join(fakeHome, ".claude", "plugins", "plugin-hive", "hive", "agnostic", "plan-agnostic.mjs"),
  ];

  const originalWrite = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let result: string | null;
  try {
    result = agnosticPlanCliPath();
  } finally {
    process.stderr.write = originalWrite;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousOverride === undefined) delete process.env.HIVE_PLAN_AGNOSTIC_CLI;
    else process.env.HIVE_PLAN_AGNOSTIC_CLI = previousOverride;
  }

  // Fallback behavior unchanged: still returns null.
  assert.equal(result, null);

  // Exactly one structured (JSON) WARN line on stderr, naming the checked candidates.
  const lines = chunks.join("").split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, `expected exactly one stderr line, got: ${JSON.stringify(lines)}`);

  const parsed = JSON.parse(lines[0] as string);
  assert.equal(String(parsed.level).toLowerCase(), "warn");
  const serialized = JSON.stringify(parsed);
  for (const candidate of expectedCandidates) {
    assert.ok(serialized.includes(candidate), `expected log line to name checked candidate ${candidate}`);
  }
});
