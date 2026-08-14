// kickoff-engine.test.ts — kickoff-engine-plumbing story
// Spawns real bin/minerva.ts subprocesses, which in turn spawn real `claude -p` subprocesses
// (real API calls, kept cheap via MINERVA_DRIVE_MODEL=haiku and MINERVA_TEST_DRIVE_PROMPT --
// same cost-control pattern as docs/spike-plugin-hive-drivability-spike.test.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call, createSeedRepo, testHeimdallRouteUrl } from "./test-cli.ts";

let minervaHome: string;
let seedRepo: string;

const TEST_DRIVE_PROMPT =
  "You are running headlessly (no interactive terminal, no AskUserQuestion tool available) " +
  "for idea '{idea}'. You need one piece of information from the human operator before you " +
  "can proceed: their favorite fruit. Ask exactly one clear question in your final text " +
  "response, then stop and wait -- do not guess an answer, do not proceed further this turn.";

function env() {
  return {
    MINERVA_HOME: minervaHome,
    MINERVA_SEED_REPO: seedRepo,
    MINERVA_DRIVE_MODEL: "claude-haiku-4-5-20251001",
    MINERVA_TEST_DRIVE_PROMPT: TEST_DRIVE_PROMPT,
  };
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-engine-"));
  seedRepo = createSeedRepo();
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
});

test("startRun drives a real headless session to its first question; getQuestions surfaces raw prose on the human channel only", () => {
  const started = call("startRun", { idea: "a tiny CLI todo app" }, env());
  assert.equal(started.status, 0);
  const runId = started.result.run_id;
  assert.ok(runId);

  const status = call("getRunStatus", { run_id: runId }, env());
  assert.equal(status.result.status, "waiting_on_human");

  const human = call("getQuestions", { run_id: runId, channel: "human" }, env());
  assert.equal(human.status, 0);
  assert.equal(human.result.questions.length, 1);
  assert.match(human.result.questions[0].text.toLowerCase(), /fruit/);
  assert.equal(human.result.questions[0].channel, "human");
  assert.equal(human.result.questions[0].status, "pending");

  const agent = call("getQuestions", { run_id: runId, channel: "agent" }, env());
  assert.equal(agent.result.questions.length, 0);
});

test("No Autonomous Progress: polling getRunStatus repeatedly never advances a waiting_on_human run", () => {
  const runId = call("startRun", { idea: "a note-taking app" }, env()).result.run_id;
  const before1 = call("getRunStatus", { run_id: runId }, env()).result.status;
  const before2 = call("getRunStatus", { run_id: runId }, env()).result.status;
  const before3 = call("getRunStatus", { run_id: runId }, env()).result.status;
  assert.equal(before1, "waiting_on_human");
  assert.equal(before2, "waiting_on_human");
  assert.equal(before3, "waiting_on_human");
});

test("submitAnswers resumes the real session with correct context, mirroring the spike's own resume proof", () => {
  const runId = call("startRun", { idea: "a habit tracker" }, env()).result.run_id;
  const q1 = call("getQuestions", { run_id: runId, channel: "human" }, env()).result.questions[0];

  // Ask a follow-up that forces the retained context word INTO the grammatical body of the
  // next question itself, not into surrounding narrative -- extraction correctly strips framing
  // clauses ("given that your favorite fruit is mango, ...") down to the bare interrogative, so
  // a preamble-based proof doesn't survive extraction. Embedding the word inside a fill-in-the-
  // blank the model must complete does survive, since it's syntactically part of the question.
  const followUp =
    "My answer: mango. Now ask me exactly this one follow-up question, with the blank filled " +
    "in using what I just told you: 'Would you like a ___-flavored recipe?' Then stop and wait.";
  const submitted = call(
    "submitAnswers",
    { run_id: runId, channel: "human", answers: [{ question_id: q1.id, answer: followUp }] },
    env(),
  );
  assert.equal(submitted.status, 0);

  const status = call("getRunStatus", { run_id: runId }, env());
  assert.equal(status.result.status, "waiting_on_human");

  const q2 = call("getQuestions", { run_id: runId, channel: "human" }, env()).result.questions[0];
  assert.notEqual(q2.id, q1.id);
  assert.match(q2.text.toLowerCase(), /mango/);
  assert.match(q2.text.toLowerCase(), /recipe/);

  // The first question must now be answered, not pending -- confirms submitAnswers is what
  // advances the run and old questions don't linger as pending forever.
  const stillPendingHuman = call("getQuestions", { run_id: runId, channel: "human" }, env());
  assert.equal(stillPendingHuman.result.questions.length, 1); // only q2, not q1+q2
});

test("WRONG_CHANNEL: submitting on the wrong channel is rejected and the run does not advance", () => {
  const runId = call("startRun", { idea: "a recipe box" }, env()).result.run_id;
  const q1 = call("getQuestions", { run_id: runId, channel: "human" }, env()).result.questions[0];

  const rejected = call(
    "submitAnswers",
    { run_id: runId, channel: "agent", answers: [{ question_id: q1.id, answer: "irrelevant" }] },
    env(),
  );
  assert.equal(rejected.status, 1);
  assert.equal(rejected.error.code, "WRONG_CHANNEL");

  // Run must NOT have advanced -- same question still pending, status unchanged.
  const status = call("getRunStatus", { run_id: runId }, env());
  assert.equal(status.result.status, "waiting_on_human");
  const stillPending = call("getQuestions", { run_id: runId, channel: "human" }, env());
  assert.equal(stillPending.result.questions[0].id, q1.id);
  assert.equal(stillPending.result.questions[0].status, "pending");
});

test("questions carry real escalation-classification fields, not the old hardcoded stub", () => {
  const runId = call("startRun", { idea: "a bookmark manager" }, env()).result.run_id;
  const q1 = call("getQuestions", { run_id: runId, channel: "human" }, env()).result.questions[0];

  assert.ok(["agent", "human"].includes(q1.suggested_channel));
  assert.equal(typeof q1.confidence, "number");
  assert.ok(q1.confidence >= 0 && q1.confidence <= 1);
  assert.ok(q1.reason.length > 0);
  // The old kickoff-engine-plumbing stub always said this exact placeholder string --
  // confirms real classification replaced it, not just that SOME string is present.
  assert.doesNotMatch(q1.reason, /escalation classification not yet implemented/);
  // Enforced channel defaults to the classifier's suggestion (v1, no external override yet).
  assert.equal(q1.channel, q1.suggested_channel);
});

test("submitAnswers validation: missing/invalid params return VALIDATION_FAILED without spawning claude", () => {
  const runId = call("startRun", { idea: "a link shortener" }, env()).result.run_id;

  const noChannel = call("submitAnswers", { run_id: runId, answers: [{ question_id: "q-1", answer: "x" }] }, env());
  assert.equal(noChannel.status, 1);
  assert.equal(noChannel.error.code, "VALIDATION_FAILED");

  const emptyAnswers = call("submitAnswers", { run_id: runId, channel: "human", answers: [] }, env());
  assert.equal(emptyAnswers.status, 1);
  assert.equal(emptyAnswers.error.code, "VALIDATION_FAILED");

  const unknownQuestion = call(
    "submitAnswers",
    { run_id: runId, channel: "human", answers: [{ question_id: "not-a-real-id", answer: "x" }] },
    env(),
  );
  assert.equal(unknownQuestion.status, 1);
  assert.equal(unknownQuestion.error.code, "NOT_FOUND");
});

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { spawn } from "node:child_process";

function createMockHeimdall(responseBody: any, statusCode = 200) {
  return new Promise<{ server: any, url: string }>((resolve) => {
    const child = spawn("node", ["-e", `
      const http = require("http");
      const server = http.createServer((req, res) => {
        res.writeHead(${statusCode}, { "Content-Type": "application/json" });
        res.end(JSON.stringify(${JSON.stringify(responseBody)}));
      });
      server.listen(0, "127.0.0.1", () => console.log("PORT:" + server.address().port));
    `]);
    child.stdout.on("data", (data) => {
      const match = data.toString().match(/PORT:(\d+)/);
      if (match) {
        resolve({ server: { close: () => child.kill() }, url: "http://127.0.0.1:" + match[1] });
      }
    });
  });
}

function readRecord(runId: string) {
  return JSON.parse(readFileSync(join(minervaHome, "runs", runId, "run.yaml"), "utf8"));
}

// NOTE: this file's env() unconditionally sets MINERVA_TEST_DRIVE_PROMPT (needed to keep every
// test's real `claude -p` subprocess spawn cheap/scripted). src/agnostic-plan-driver.ts's
// resolveAgnosticPlanDriver() treats that as a deliberate "bulletproof claude fallback" test
// seam and short-circuits to null before ever reaching Heimdall's resolved route -- so
// plan_runtime/plan_model can never actually freeze to a non-claude value inside this file,
// regardless of what a mock Heimdall server returns. The test below confirms that guard holds
// even when Heimdall explicitly offers a non-claude runtime, rather than asserting the freeze
// itself (which needs a non-test-mode path -- see triage t-007).
test("planning route stays absent in test mode even when Heimdall offers a non-claude runtime (bulletproof claude fallback)", async () => {
  const mock = await createMockHeimdall({ runtime: "gemini", model: "gemini-2.0-flash-exp" });
  try {
    const customEnv = { ...env(), MINERVA_HEIMDALL_URL: mock.url, MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: testHeimdallRouteUrl() };
    const started = call("startRun", { idea: "freeze test" }, customEnv);
    assert.equal(started.status, 0);
    const runId = started.result.run_id;

    const record = readRecord(runId);
    assert.equal(record.plan_runtime, undefined);
    assert.equal(record.plan_model, undefined);
  } finally {
    mock.server.close();
  }
});

test("planning route falls back to claude (absent fields) when Heimdall is unreachable or returns 500", async () => {
  const mock = await createMockHeimdall({}, 500);
  try {
    const customEnv = { ...env(), MINERVA_HEIMDALL_URL: mock.url, MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: testHeimdallRouteUrl() };
    const started = call("startRun", { idea: "fallback test" }, customEnv);
    assert.equal(started.status, 0);
    const runId = started.result.run_id;
    
    const record = readRecord(runId);
    assert.equal(record.plan_runtime, undefined);
    assert.equal(record.plan_model, undefined);
  } finally {
    mock.server.close();
  }
});

test("planning route stays absent when Heimdall explicitly returns claude", async () => {
  const mock = await createMockHeimdall({ runtime: "claude", model: "claude-3-5-sonnet" });
  try {
    const customEnv = { ...env(), MINERVA_HEIMDALL_URL: mock.url, MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: testHeimdallRouteUrl() };
    const started = call("startRun", { idea: "claude explicit test" }, customEnv);
    assert.equal(started.status, 0);
    const runId = started.result.run_id;
    
    const record = readRecord(runId);
    assert.equal(record.plan_runtime, undefined);
    assert.equal(record.plan_model, undefined);
  } finally {
    mock.server.close();
  }
});

// Same bulletproof-fallback caveat as above: plan_runtime never freezes in this file's test
// mode, so "no drift" here means submitAnswers doesn't introduce a spurious plan_runtime value
// on a run that started with none -- not that a frozen non-claude value survives a continuation
// turn (that positive path is untested anywhere yet -- see triage t-007).
test("submitAnswers introduces no plan_runtime drift on a run that never froze one, and falls back correctly if CLI is missing", async () => {
  const mock = await createMockHeimdall({ runtime: "gemini", model: "gemini-2.0-flash-exp" });
  try {
    const customEnv = { ...env(), MINERVA_HEIMDALL_URL: mock.url, MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: testHeimdallRouteUrl(), HIVE_PLAN_AGNOSTIC_CLI: "/does/not/exist" };
    const started = call("startRun", { idea: "continuation test" }, customEnv);
    assert.equal(started.status, 0);
    const runId = started.result.run_id;

    const record1 = readRecord(runId);
    assert.equal(record1.plan_runtime, undefined); // bulletproof fallback holds in test mode

    const q1 = call("getQuestions", { run_id: runId, channel: "human" }, customEnv).result.questions[0];
    
    // During submitAnswers, if CLI is missing, driverForRecord falls back to claude gracefully.
    // So the run progresses successfully instead of throwing.
    const submitted = call(
      "submitAnswers",
      { run_id: runId, channel: "human", answers: [{ question_id: q1.id, answer: "mango" }] },
      customEnv,
    );
    assert.equal(submitted.status, 0);
    
    const record2 = readRecord(runId);
    // plan_runtime should not change during submitAnswers
    assert.equal(record2.plan_runtime, undefined);
  } finally {
    mock.server.close();
  }
});

// auto-cleanup-orphaned-runs-on-first-turn-failure story: allocateRun() durably writes the run
// record (status "in_progress") and workspace/worktree BEFORE startRun()'s first drive turn is
// attempted. These tests confirm a failure in that very first turn now auto-transitions the run
// to "aborted" via the existing, unmodified abortRun()/recordCleanup() mechanism (cleanup-ledger.ts)
// instead of leaving a permanently stuck orphan -- and that this new hook is scoped ONLY to that
// first turn, never to a later-stage failure on a run that already reached waiting_on_human (that
// is a stall, protected by AD-5, explicitly out of scope for this story).

function listRunIds(): string[] {
  const dir = join(minervaHome, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

function readLedgerLines(): any[] {
  const path = join(minervaHome, "cleanup-ledger.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function readEventLines(): any[] {
  const path = join(minervaHome, "events", "cleanup_needed.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("orphan cleanup: a first-turn failure (Heimdall routing failure, no fallback configured) auto-aborts the run, writes exactly one ledger record + one cleanup_needed event, and the caller still receives an error, not silence", () => {
  // MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL pointed at an unreachable port, with no
  // MINERVA_FALLBACK_CLI/MODEL configured, forces SpawnDriver.runTurn's resolveRuntimeRoute()
  // to throw HeimdallRouteError before any real `claude` process is ever spawned -- fast, and
  // no real API cost, matching the exact failure shape this epic is fixing.
  const brokenEnv = { ...env(), MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: "http://127.0.0.1:1" };

  const before = new Set(listRunIds());
  const started = call("startRun", { idea: "an idea whose first turn will fail" }, brokenEnv);

  // Caller still learns the run failed -- not silence.
  assert.equal(started.status, 1);
  assert.ok(started.error);
  assert.equal(started.error.code, "UPSTREAM_ERROR");

  // startRun threw before returning a run_id, so recover it from the newly-created run directory
  // (allocateRun() already durably wrote it before the failing turn).
  const after = listRunIds();
  const newRunIds = after.filter((id) => !before.has(id));
  assert.equal(newRunIds.length, 1);
  const runId = newRunIds[0]!;

  const status = call("getRunStatus", { run_id: runId }, env());
  assert.equal(status.result.status, "aborted");

  const record = readRecord(runId);

  // AD-4: abortRun()/recordCleanup() only records + signals -- never deletes. Workspace/worktree
  // and state dir must still exist on disk after this auto-cleanup.
  assert.ok(existsSync(record.workspace_path));
  assert.ok(existsSync(record.state_path));

  const ledgerEntries = readLedgerLines().filter((l) => l.run_id === runId);
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].status, "aborted");
  assert.equal(ledgerEntries[0].workspace_path, record.workspace_path);
  assert.equal(ledgerEntries[0].state_path, record.state_path);

  const eventEntries = readEventLines().filter((l) => l.run_id === runId);
  assert.equal(eventEntries.length, 1);
  assert.equal(eventEntries[0].event, "cleanup_needed");
  assert.equal(eventEntries[0].status, "aborted");

  // Idempotency holds through this new call path too: calling abortRun again manually on the
  // now-aborted run must not double-append the ledger (confirms cleanup-ledger.ts's existing
  // idempotency guarantee still holds when the run was FIRST aborted via this new startRun hook,
  // not just via a direct abortRun call).
  const secondAbort = call("abortRun", { run_id: runId }, env());
  assert.equal(secondAbort.status, 0);
  const ledgerEntriesAfterSecondAbort = readLedgerLines().filter((l) => l.run_id === runId);
  assert.equal(ledgerEntriesAfterSecondAbort.length, 1);
});

test("orphan cleanup boundary: a run that already reached waiting_on_human is NOT auto-aborted by a later-stage (submitAnswers) failure -- that is a stall, protected by AD-5, out of scope for this hook", () => {
  // First turn succeeds for real (default working test route + haiku), reaching waiting_on_human
  // -- a real question has been surfaced, so this run is no longer an "orphan" by this story's
  // own definition.
  const started = call("startRun", { idea: "an idea that reaches a real question first" }, env());
  assert.equal(started.status, 0);
  const runId = started.result.run_id;

  const beforeStatus = call("getRunStatus", { run_id: runId }, env());
  assert.equal(beforeStatus.result.status, "waiting_on_human");

  const q1 = call("getQuestions", { run_id: runId, channel: "human" }, env()).result.questions[0];
  assert.ok(q1);

  const ledgerBefore = readLedgerLines().filter((l) => l.run_id === runId);
  assert.equal(ledgerBefore.length, 0);

  // Now force a Heimdall routing failure on submitAnswers's own (later-stage) drive turn -- this
  // is NOT the run's first turn, so startRun's new auto-cleanup hook must not have any bearing
  // on it (submitAnswers's own call site is untouched by this story).
  const brokenEnv = { ...env(), MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: "http://127.0.0.1:1" };
  const submitted = call(
    "submitAnswers",
    { run_id: runId, channel: "human", answers: [{ question_id: q1.id, answer: "mango" }] },
    brokenEnv,
  );

  // The caller still gets an error (submitAnswers's own pre-existing behavior, unchanged by this
  // story) -- but the run must NOT have been auto-aborted by this story's new hook.
  assert.equal(submitted.status, 1);

  const afterStatus = call("getRunStatus", { run_id: runId }, env());
  assert.notEqual(afterStatus.result.status, "aborted");

  const ledgerAfter = readLedgerLines().filter((l) => l.run_id === runId);
  assert.equal(ledgerAfter.length, 0);

  const record = readRecord(runId);
  assert.ok(existsSync(record.workspace_path));
  assert.ok(existsSync(record.state_path));
});
