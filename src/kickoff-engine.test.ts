// kickoff-engine.test.ts — kickoff-engine-plumbing story
// Spawns real bin/minerva.ts subprocesses, which in turn spawn real `claude -p` subprocesses
// (real API calls, kept cheap via MINERVA_DRIVE_MODEL=haiku and MINERVA_TEST_DRIVE_PROMPT --
// same cost-control pattern as docs/spike-plugin-hive-drivability-spike.test.ts).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call } from "./test-cli.ts";

let minervaHome: string;

const TEST_DRIVE_PROMPT =
  "You are running headlessly (no interactive terminal, no AskUserQuestion tool available) " +
  "for idea '{idea}'. You need one piece of information from the human operator before you " +
  "can proceed: their favorite fruit. Ask exactly one clear question in your final text " +
  "response, then stop and wait -- do not guess an answer, do not proceed further this turn.";

function env() {
  return {
    MINERVA_HOME: minervaHome,
    MINERVA_DRIVE_MODEL: "claude-haiku-4-5-20251001",
    MINERVA_TEST_DRIVE_PROMPT: TEST_DRIVE_PROMPT,
  };
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-engine-"));
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
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
