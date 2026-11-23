// abi-smoke.test.ts -- PANT-995. End-to-end smoke harness for Minerva's public ABI.
//
// Drives the whole planning loop the way Auriga (or any caller) does: a fresh `bin/minerva.ts`
// subprocess per call, JSON envelope on stdin, nothing imported from src/ to shortcut it.
// The driver turns are served by tests/e2e/abi-smoke-planner.mjs, a scripted stub planner the
// route points at (route `cli` = its path), so the run is deterministic, offline and free:
//
//   capabilities -> startRun -> getRunStatus/listRuns -> getQuestions -> submitAnswers
//   -> getRunStatus (complete) -> getOutput -> getMetrics, plus abortRun on a second run and the
//   error envelope for each failure path a caller has to handle.
//
// The method contract itself is documented in mkdocs_docs/abi-reference.md (summary: docs/abi.md).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { call, createSeedRepo, testHeimdallRouteUrl } from "../../src/test-cli.ts";

const PLANNER = join(dirname(fileURLToPath(import.meta.url)), "abi-smoke-planner.mjs");
const MODEL = "abi-smoke-model";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let minervaHome: string;
let seedRepo: string;

function env(): Record<string, string> {
  return {
    MINERVA_HOME: minervaHome,
    MINERVA_SEED_REPO: seedRepo,
    MINERVA_DRIVER: "spawn",
    MINERVA_DRIVE_MODEL: MODEL,
    MINERVA_PANTHEON_ROUTE_SELECT_URL: testHeimdallRouteUrl(MODEL, PLANNER),
    // Keeps the agnostic plan driver (network route lookup + opencode) out of the loop and swaps
    // the plugin-hive skill prompt for a short one; the stub planner ignores the prompt anyway.
    MINERVA_TEST_DRIVE_PROMPT: "Plan '{idea}' and ask the operator one question.",
    MINERVA_PLAN_AGNOSTIC: "off",
    // No operator defaults: the planner's question must park for a human, not auto-resolve.
    MINERVA_PLAN_DEFAULTS: "",
    MINERVA_PLAN_DEFAULTS_MODE: "off",
  };
}

function ok(method: string, params: Record<string, unknown> = {}): any {
  const res = call(method, params, env());
  assert.equal(res.status, 0, `${method} exited ${res.status}: ${JSON.stringify(res.error)}`);
  assert.ok(res.result, `${method} returned no result envelope`);
  return res.result;
}

function fails(method: string, params: Record<string, unknown>, code: string): void {
  const res = call(method, params, env());
  assert.equal(res.status, 1, `${method} should exit 1`);
  assert.equal(res.error?.code, code, `${method}: ${JSON.stringify(res.error)}`);
  assert.equal(typeof res.error.message, "string");
  assert.equal(res.error.retry_after_ms, null);
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-abi-smoke-"));
  seedRepo = createSeedRepo("minerva-seed-abi-smoke-");
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
});

test("ABI smoke: startRun -> getQuestions -> submitAnswers -> getOutput, end to end", () => {
  assert.equal(ok("capabilities").abi_version, "1.0.0");

  const { run_id: runId } = ok("startRun", { idea: "a board-game night scheduler" });
  assert.match(runId, UUID);

  const parked = ok("getRunStatus", { run_id: runId });
  assert.equal(parked.status, "waiting_on_human");
  assert.equal(parked.metrics.turns, 1);
  assert.equal(parked.metrics.escalations, 1);
  assert.equal(parked.metrics.driver, "spawn");

  const listed = ok("listRuns").runs.find((r: any) => r.run_id === runId);
  assert.equal(listed?.status, "waiting_on_human");

  assert.deepEqual(ok("getQuestions", { run_id: runId, channel: "agent" }).questions, []);
  const questions = ok("getQuestions", { run_id: runId, channel: "human" }).questions;
  assert.equal(questions.length, 1);
  const [q] = questions;
  assert.equal(q.text, "Which platform should the first release target: web or mobile?");
  assert.equal(q.channel, "human");
  assert.equal(q.status, "pending");

  // The output is not there yet, and the answer has to come in on the question's channel.
  fails("getOutput", { run_id: runId }, "NOT_READY");
  fails("submitAnswers", { run_id: runId, channel: "agent", answers: [{ question_id: q.id, answer: "web" }] }, "WRONG_CHANNEL");

  const answered = ok("submitAnswers", { run_id: runId, channel: "human", answers: [{ question_id: q.id, answer: "web" }] });
  assert.deepEqual(answered.result, {});
  assert.equal(answered.outcome, "resumed");
  assert.equal(answered.run_id, runId);

  const done = ok("getRunStatus", { run_id: runId });
  assert.equal(done.status, "complete");
  assert.equal(done.metrics.turns, 2);
  assert.equal(typeof done.metrics.elapsed_ms, "number");
  assert.deepEqual(ok("getQuestions", { run_id: runId, channel: "human" }).questions, []);

  const output = ok("getOutput", { run_id: runId });
  assert.equal(output.epic.epic_id, "abi-smoke-epic");
  assert.equal(output.epic.layout, "nested");
  assert.match(output.epic.epic_yaml, /title: ABI Smoke Epic/);
  assert.equal(output.epics.length, 1);
  assert.deepEqual(output.epic.stories.map((s: any) => s.id), ["story-1"]);
  assert.match(output.epic.stories[0].content, /Ship the web MVP/);
  assert.equal(output.metrics.turns, 2);

  const metrics = ok("getMetrics");
  assert.ok(metrics.overall.by_status.complete >= 1);
  assert.ok(metrics.by_driver.spawn.runs >= 1);
});

test("ABI smoke: abortRun stops a parked run and is idempotent", () => {
  const { run_id: runId } = ok("startRun", { idea: "a run the caller abandons" });
  assert.equal(ok("getRunStatus", { run_id: runId }).status, "waiting_on_human");

  assert.deepEqual(ok("abortRun", { run_id: runId }), { result: {} });
  assert.equal(ok("getRunStatus", { run_id: runId }).status, "aborted");
  assert.deepEqual(ok("abortRun", { run_id: runId }), { result: {} });
  fails("getOutput", { run_id: runId }, "NOT_READY");
});

test("ABI smoke: error envelopes for unknown runs, bad ids and unknown methods", () => {
  fails("getRunStatus", { run_id: "00000000-0000-4000-8000-000000000000" }, "NOT_FOUND");
  fails("getQuestions", { run_id: "../not-a-uuid", channel: "human" }, "VALIDATION_FAILED");
  fails("startRun", {}, "VALIDATION_FAILED");
  fails("notAMethod", {}, "UNKNOWN_METHOD");
});
