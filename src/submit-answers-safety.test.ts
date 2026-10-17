// submit-answers-safety.test.ts — PANT-903: submitAnswers must never silently drop answers, and a
// failed resumed turn must never strand a run. Driven by a scripted fake Driver (no live API).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRun, submitAnswers, getQuestions, __setDriverForTest } from "./kickoff-engine.ts";
import { readRunRecord } from "./run-manager.ts";
import { MinervaError } from "./errors.ts";
import { createSeedRepo } from "./test-cli.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

let minervaHome: string;
let seedRepo: string;
let savedDriver: Driver | undefined;
let previousSeedRepo: string | undefined;

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-submit-safety-"));
  process.env.MINERVA_HOME = minervaHome;
  seedRepo = createSeedRepo();
  previousSeedRepo = process.env.MINERVA_SEED_REPO;
  process.env.MINERVA_SEED_REPO = seedRepo;
});

after(() => {
  if (savedDriver) __setDriverForTest(savedDriver);
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
  if (previousSeedRepo) process.env.MINERVA_SEED_REPO = previousSeedRepo;
  else delete process.env.MINERVA_SEED_REPO;
});

// Every turn surfaces a human question, except the turns listed in `failOn`, which throw (a
// non-timeout error, so runTurnResumable does not retry it).
class FlakyDriver implements Driver {
  turns = 0;
  prompts: string[] = [];
  constructor(private readonly failOn: Set<number>) {}
  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.turns++;
    this.prompts.push(input.prompt);
    if (this.failOn.has(this.turns)) throw new Error(`injected failure on turn ${this.turns}`);
    return {
      session_id: "sess",
      raw_result: JSON.stringify({
        question: `What is the product strategy (turn ${this.turns})?`,
        suggested_channel: "human",
        confidence: 0.2,
        reason: "strategic, ambiguous",
        kind: "free-text",
        options: null,
        qid: `strategy-${this.turns}`,
      }),
    };
  }
}

function install(d: Driver): void {
  const prev = __setDriverForTest(d);
  savedDriver = savedDriver ?? prev;
}

async function startParkedRun(): Promise<{ runId: string; questionId: string }> {
  const { run_id } = (await startRun({ idea: "a tiny CLI todo app", defaults: { mode: "off" } })) as { run_id: string };
  const { questions } = getQuestions({ run_id, channel: "human" }) as { questions: { id: string }[] };
  assert.equal(questions.length, 1);
  return { runId: run_id, questionId: questions[0]!.id };
}

test("two answers are rejected with VALIDATION_FAILED and the run record is left unchanged", async () => {
  const d = new FlakyDriver(new Set());
  install(d);
  const { runId, questionId } = await startParkedRun();
  const before = readRunRecord(runId);
  const turnsBefore = d.turns;

  await assert.rejects(
    submitAnswers({
      run_id: runId,
      channel: "human",
      answers: [
        { question_id: questionId, answer: "first" },
        { question_id: questionId, answer: "second" },
      ],
    }),
    (e: unknown) => e instanceof MinervaError && e.code === "VALIDATION_FAILED" && /one answer per call/.test(e.message),
  );

  assert.deepEqual(readRunRecord(runId), before);
  assert.equal(d.turns, turnsBefore, "no turn may be driven for a rejected request");
});

test("a failed resumed turn leaves the question pending and the run waiting_on_human; a retry then succeeds", async () => {
  // Turn 1: startRun's first question. Turn 2: the resumed turn for the answer -- fails.
  // Turn 3: the retried answer succeeds and surfaces the next question.
  const d = new FlakyDriver(new Set([2]));
  install(d);
  const { runId, questionId } = await startParkedRun();

  await assert.rejects(
    submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "mango" }] }),
    /injected failure on turn 2/,
  );

  const stranded = readRunRecord(runId);
  assert.equal(stranded.status, "waiting_on_human");
  assert.equal(stranded.questions.find((q) => q.id === questionId)?.status, "pending");
  const pending = getQuestions({ run_id: runId, channel: "human" }) as { questions: { id: string }[] };
  assert.deepEqual(pending.questions.map((q) => q.id), [questionId]);

  const ok = await submitAnswers({
    run_id: runId,
    channel: "human",
    answers: [{ question_id: questionId, answer: "mango" }],
  });
  assert.deepEqual(ok, { result: {} });
  assert.equal(d.turns, 3);
  assert.equal(d.prompts[2], "mango");

  const after = readRunRecord(runId);
  assert.equal(after.questions.find((q) => q.id === questionId)?.status, "answered");
  assert.equal(after.status, "waiting_on_human");
  assert.equal(after.questions.filter((q) => q.status === "pending").length, 1);
});
