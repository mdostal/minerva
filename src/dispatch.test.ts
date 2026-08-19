// dispatch.test.ts -- add-upstream-error-code story.
//
// dispatch.ts's handler-catch branch (lines ~71-85) used to coerce ANY exception thrown by a
// dispatched method's handler into UNKNOWN_METHOD, indistinguishable from the genuine
// "no such method" case just above it. This file proves the fix: a HeimdallRouteError (the
// typed error fix-heimdall-route-fail-fast-with-fallback introduced for a Heimdall routing
// failure) now surfaces as the new UPSTREAM_ERROR code, while a truly nonexistent method name
// is completely unaffected and still returns UNKNOWN_METHOD.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dispatch } from "./dispatch.ts";
import { __setDriverForTest } from "./kickoff-engine.ts";
import { HeimdallRouteError, type Driver, type DriverInput, type DriverResult } from "./driver.ts";
import { createSeedRepo } from "./test-cli.ts";
import { allocateRun } from "./run-manager.ts";

let minervaHome: string;
let seedRepo: string;
let savedDriver: Driver;
const savedEnv = {
  MINERVA_HOME: process.env.MINERVA_HOME,
  MINERVA_SEED_REPO: process.env.MINERVA_SEED_REPO,
};

// A driver whose very first turn throws the same typed error resolveRuntimeRoute() throws when
// Heimdall fails and no operator fallback is configured -- exactly what a real SpawnDriver /
// SubagentDriver / ForkedHiveDriver.runTurn() would propagate, per driver.ts's resolveRuntimeRoute.
class HeimdallFailureDriver implements Driver {
  async runTurn(_input: DriverInput): Promise<DriverResult> {
    throw new HeimdallRouteError(
      "Heimdall routing failed and no MINERVA_FALLBACK_CLI/MINERVA_FALLBACK_MODEL fallback is configured: connect ECONNREFUSED",
    );
  }
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-dispatch-"));
  seedRepo = createSeedRepo("minerva-seed-repo-dispatch-");
  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_SEED_REPO = seedRepo;
  savedDriver = __setDriverForTest(new HeimdallFailureDriver());
});

after(() => {
  __setDriverForTest(savedDriver);
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a HeimdallRouteError raised inside startRun's handler surfaces as UPSTREAM_ERROR, not UNKNOWN_METHOD", async () => {
  const response = await dispatch({ method: "startRun", params: { idea: "an app that hits a dead Heimdall" } });

  assert.ok("error" in response, `expected an error response, got ${JSON.stringify(response)}`);
  assert.equal(response.error.code, "UPSTREAM_ERROR");
  assert.match(response.error.message, /Heimdall routing failed/);
  assert.equal(response.error.retry_after_ms, null);
});

test("a genuinely nonexistent method name still returns UNKNOWN_METHOD -- this path is unchanged", async () => {
  const response = await dispatch({ method: "thisMethodDoesNotExist" });

  assert.ok("error" in response, `expected an error response, got ${JSON.stringify(response)}`);
  assert.equal(response.error.code, "UNKNOWN_METHOD");
  assert.match(response.error.message, /Unknown method: thisMethodDoesNotExist/);
  assert.equal(response.error.retry_after_ms, null);
});

// validate-run-id-uuid-shape story -- run_id reaches run-manager.ts's runDir()/runRecordPath()
// path-join with no format validation anywhere upstream. dispatch.ts's method routing is one of
// the two ABI boundaries (the other is mcp-server.ts's CallToolRequestSchema handler) that must
// reject a non-UUID run_id with VALIDATION_FAILED BEFORE calling into the run-manager.ts-backed
// handler at all, for exactly these five methods.
const RUN_ID_METHODS = ["getRunStatus", "getQuestions", "submitAnswers", "getOutput", "abortRun"] as const;
const NON_UUID_RUN_IDS = ["x", "", "../../etc/passwd", "not-a-uuid-at-all", "12345"];

// Every one of these methods declares other required params too (channel, answers) -- pass
// well-formed values for those so a failure can ONLY be attributed to run_id shape, never to a
// different, unrelated VALIDATION_FAILED (e.g. "requires channel ..."). This isolates exactly
// what the guard is supposed to catch.
function fullParamsFor(runId: string): Record<string, unknown> {
  return {
    run_id: runId,
    channel: "agent",
    answers: [{ question_id: "q1", answer: "an answer" }],
  };
}

for (const method of RUN_ID_METHODS) {
  for (const badRunId of NON_UUID_RUN_IDS) {
    test(`dispatch rejects ${method} with non-UUID run_id ${JSON.stringify(badRunId)} as VALIDATION_FAILED naming run_id`, async () => {
      const response = await dispatch({ method, params: fullParamsFor(badRunId) });

      assert.ok("error" in response, `expected an error response, got ${JSON.stringify(response)}`);
      assert.equal(response.error.code, "VALIDATION_FAILED");
      assert.match(response.error.message, /run_id/);
      assert.equal(response.error.retry_after_ms, null);
    });
  }
}

test("dispatch: a valid-UUID run_id round-trips unchanged through all five methods (no regression)", async () => {
  const { run_id: runId } = allocateRun("an idea for the dispatch UUID regression test", undefined);

  const status = await dispatch({ method: "getRunStatus", params: { run_id: runId } });
  assert.ok("result" in status, `expected a result, got ${JSON.stringify(status)}`);
  assert.equal(status.result.status, "in_progress");

  const questions = await dispatch({ method: "getQuestions", params: { run_id: runId, channel: "agent" } });
  assert.ok("result" in questions, `expected a result, got ${JSON.stringify(questions)}`);
  assert.deepEqual(questions.result.questions, []);

  const output = await dispatch({ method: "getOutput", params: { run_id: runId } });
  assert.ok("error" in output, `expected an error, got ${JSON.stringify(output)}`);
  assert.equal(output.error.code, "NOT_READY", "a real run_id must reach run-manager, not be rejected as VALIDATION_FAILED");

  const submit = await dispatch({
    method: "submitAnswers",
    params: { run_id: runId, channel: "agent", answers: [{ question_id: "no-such-question", answer: "x" }] },
  });
  assert.ok("error" in submit, `expected an error, got ${JSON.stringify(submit)}`);
  assert.equal(submit.error.code, "NOT_FOUND", "a real run_id must reach kickoff-engine, not be rejected as VALIDATION_FAILED");

  const abort = await dispatch({ method: "abortRun", params: { run_id: runId } });
  assert.ok("result" in abort, `expected a result, got ${JSON.stringify(abort)}`);
});
