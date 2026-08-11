// turn-timeout.test.ts — regression coverage for goblin PAN-7572 ("Minerva turn-timeout
// SIGKILLs long plans + loses work (no resume)"). Root cause: a turn that simply ran longer
// than MINERVA_TURN_TIMEOUT_MS was indistinguishable, at the call site, from a genuine crash --
// both surfaced as a plain Error and propagated straight out of startRun/submitAnswers
// uncaught, destroying the whole run even though its session_id was still a perfectly valid
// --resume target. The fix: driver.ts's timeout-triggered kill now throws a distinguishable
// TurnTimeoutError, and kickoff-engine.ts's runTurnResumable retries exactly that error type
// (bounded by MINERVA_TURN_RETRY_LIMIT) instead of letting one slow turn discard the run.
//
// Goes through the full CLI (call(), per AD-1 -- see test-cli.ts), a fresh process per call,
// exactly like subagent-driver.test.ts's own timeout regression test: MINERVA_TURN_TIMEOUT_MS
// is read once at driver.ts's module top level, so a custom value can't be exercised by
// importing the driver directly within this (or any) already-running process.
//
// No real `claude`/network calls -- turn-timeout-harness.mjs stands in as the routed CLI (via a
// custom Heimdall route, same seam driver.test.ts's testHeimdallRouteUrl() always uses), so
// every case below is fast and deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { call, createSeedRepo, testHeimdallRouteUrl } from "./test-cli.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(__dirname, "turn-timeout-harness.mjs");
const BIN = join(__dirname, "..", "bin", "minerva.ts");

// TURN_RETRY_LIMIT is computed unconditionally at kickoff-engine.ts's module top level, on
// every CLI invocation -- so an invalid value crashes at import time, before dispatch.ts's own
// try/catch is reachable (matches MINERVA_TURN_TIMEOUT_MS's identical, already-established
// validation shape in driver-selection.test.ts). A cheap "capabilities" call is enough to
// exercise it.
function runCliRaw(env: Record<string, string>): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", BIN], {
      input: JSON.stringify({ method: "capabilities" }),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

test("a planning turn that times out twice is retried automatically and the run still completes, instead of losing the whole plan", () => {
  const minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-timeout-retry-"));
  const seedRepo = createSeedRepo();
  const counterDir = mkdtempSync(join(tmpdir(), "minerva-timeout-counter-"));
  const counterFile = join(counterDir, "count");
  try {
    const env = {
      MINERVA_HOME: minervaHome,
      MINERVA_SEED_REPO: seedRepo,
      MINERVA_TURN_TIMEOUT_MS: "500", // tiny -- forces the hung invocations to be SIGKILL'd fast
      MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: testHeimdallRouteUrl("unused-model", HARNESS),
      HARNESS_COUNTER_FILE: counterFile,
      HARNESS_HANG_COUNT: "2", // the first 2 invocations hang past the timeout; the 3rd responds
    };

    const started = call("startRun", { idea: "a tiny scratch project" }, env);

    // Two timed-out attempts (retried automatically, within MINERVA_TURN_RETRY_LIMIT's default
    // of 2) were survived; the 3rd attempt's real response let the run park normally on the
    // question the harness returned -- a clean waiting_on_human park, NOT a fatal top-level
    // error that would have discarded the run.
    assert.equal(started.status, 0, JSON.stringify(started));
    assert.equal(typeof started.result.run_id, "string");

    // Confirms the retry actually happened (rather than, say, the harness never hanging at
    // all): 2 hung attempts + the 1 that responded.
    assert.equal(Number(readFileSync(counterFile, "utf8")), 3);
  } finally {
    rmSync(minervaHome, { recursive: true, force: true });
    rmSync(seedRepo, { recursive: true, force: true });
    rmSync(counterDir, { recursive: true, force: true });
  }
});

test("retrying a turn that never stops timing out is bounded -- it eventually gives up rather than retrying forever", () => {
  const minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-timeout-bound-"));
  const seedRepo = createSeedRepo();
  const counterDir = mkdtempSync(join(tmpdir(), "minerva-timeout-bound-counter-"));
  const counterFile = join(counterDir, "count");
  try {
    const env = {
      MINERVA_HOME: minervaHome,
      MINERVA_SEED_REPO: seedRepo,
      MINERVA_TURN_TIMEOUT_MS: "300",
      MINERVA_TURN_RETRY_LIMIT: "1", // 1 initial attempt + 1 retry = 2 total, both time out
      MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: testHeimdallRouteUrl("unused-model", HARNESS),
      HARNESS_COUNTER_FILE: counterFile,
      HARNESS_HANG_COUNT: "999", // every invocation hangs -- never recovers
    };

    const started = call("startRun", { idea: "a tiny scratch project" }, env);

    assert.equal(started.status, 1);
    assert.match(started.error.message, /did not complete within/);

    // Exactly the bounded number of attempts happened (1 initial + MINERVA_TURN_RETRY_LIMIT
    // retries) -- proving this degrades to a clean, reported failure instead of hanging or
    // retrying without limit.
    assert.equal(Number(readFileSync(counterFile, "utf8")), 2);
  } finally {
    rmSync(minervaHome, { recursive: true, force: true });
    rmSync(seedRepo, { recursive: true, force: true });
    rmSync(counterDir, { recursive: true, force: true });
  }
});

test('MINERVA_TURN_RETRY_LIMIT="-1" fails loudly at startup -- never silently falls back or guesses', () => {
  const result = runCliRaw({ MINERVA_TURN_RETRY_LIMIT: "-1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MINERVA_TURN_RETRY_LIMIT/);
});
