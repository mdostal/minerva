// e2e-driver-validation.test.ts -- PAN-8613. Exercises the env-selected ForkedHiveDriver path
// through the real Minerva subprocess ABI, without live model/plugin calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call, createSeedRepo } from "./test-cli.ts";

function createFakeForkedRuntime(): string {
  const dir = mkdtempSync(join(tmpdir(), "minerva-fake-forked-runtime-"));
  const runtime = join(dir, "fake-runtime.mjs");
  writeFileSync(
    runtime,
    `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = process.argv[process.argv.length - 1] ?? "";
const cwd = process.cwd();
const questionsDir = join(cwd, ".pHive", "questions");
const envelopePath = join(questionsDir, "forked-e2e.yaml");

function respond(result) {
  console.log(JSON.stringify({
    is_error: false,
    stop_reason: "end_turn",
    session_id: "fake-runtime-session",
    result: JSON.stringify(result),
  }));
}

if (prompt.includes("Classify this question")) {
  respond({ suggested_channel: "agent", confidence: 0.99, reason: "routine validation gate" });
  process.exit(0);
}

mkdirSync(questionsDir, { recursive: true });
if (existsSync(envelopePath) && /status:\\s*answered/.test(readFileSync(envelopePath, "utf8"))) {
  const epicDir = join(cwd, ".pHive", "epics", "forked-e2e-validation");
  mkdirSync(join(epicDir, "stories"), { recursive: true });
  writeFileSync(join(epicDir, "epic.yaml"), "id: forked-e2e-validation\\ntitle: Forked E2E Validation\\nstatus: approved\\n");
  writeFileSync(join(epicDir, "stories", "complete-flow.yaml"), "id: complete-flow\\ntitle: Complete Forked Driver Flow\\n");
  respond({ question: "", suggested_channel: "human", confidence: 0, reason: "complete" });
  process.exit(0);
}

writeFileSync(envelopePath, \`id: forked-e2e
skill: plugin-hive
phase: kickoff
status: pending
provenance:
  raised_by: fake-runtime
  raised_at: "2026-08-11T00:00:00.000Z"
deadline: "2026-08-11T00:30:00.000Z"
renewal_count: 0
questions:
  - qid: route_ok
    text: "Proceed with the forked-driver E2E validation?"
    kind: single-select
    options:
      - "yes"
      - "no"
    required: true
    answer: null
\`);
respond({ question: "envelope emitted", suggested_channel: "agent", confidence: 1, reason: "pending" });
`,
  );
  chmodSync(runtime, 0o755);
  return runtime;
}

function routeUrl(cli: string): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ cli, model: "fake-model" }))}`;
}

function readRecord(minervaHome: string, runId: string) {
  return JSON.parse(readFileSync(join(minervaHome, "runs", runId, "run.yaml"), "utf8"));
}

test("E2E driver validation: env routing initializes ForkedHiveDriver and completes a run", () => {
  const minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-forked-e2e-"));
  const seedRepo = createSeedRepo("minerva-forked-e2e-seed-");
  const fakeRuntime = createFakeForkedRuntime();
  const env = {
    MINERVA_HOME: minervaHome,
    MINERVA_SEED_REPO: seedRepo,
    MINERVA_DRIVER: "forked",
    MINERVA_PLAN_AGNOSTIC: "off",
    MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: routeUrl(fakeRuntime),
  };

  try {
    const started = call("startRun", { idea: "validate the forked driver decision path" }, env);
    assert.equal(started.status, 0);
    const runId = started.result.run_id as string;

    let record = readRecord(minervaHome, runId);
    assert.equal(record.metrics.driver, "forked");
    assert.match(record.session_id, /^forked-hive-driver:/);

    const agentQuestions = call("getQuestions", { run_id: runId, channel: "agent" }, env);
    assert.equal(agentQuestions.status, 0);
    assert.equal(agentQuestions.result.questions.length, 1);
    assert.deepEqual(agentQuestions.result.questions[0].options, ["yes", "no"]);
    assert.equal(agentQuestions.result.questions[0].kind, "single-select");
    assert.equal(agentQuestions.result.questions[0].qid, "route_ok");

    const submitted = call(
      "submitAnswers",
      { run_id: runId, channel: "agent", answers: [{ question_id: "q-1", answer: "yes" }] },
      env,
    );
    assert.equal(submitted.status, 0);

    const status = call("getRunStatus", { run_id: runId }, env);
    assert.equal(status.status, 0);
    assert.equal(status.result.status, "complete");

    const output = call("getOutput", { run_id: runId }, env);
    assert.equal(output.status, 0);
    assert.equal(output.result.epic.epic_id, "forked-e2e-validation");
    assert.equal(output.result.epic.stories[0].id, "complete-flow");

    record = readRecord(minervaHome, runId);
    assert.equal(record.plan_push.committed, true);
  } finally {
    rmSync(minervaHome, { recursive: true, force: true });
    rmSync(seedRepo, { recursive: true, force: true });
    rmSync(join(fakeRuntime, ".."), { recursive: true, force: true });
  }
});
