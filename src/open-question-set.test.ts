// open-question-set.test.ts — PANT-923: a parked run records its whole open question set. A
// ForkedHiveDriver envelope with several questions parks every one of them at once (shared
// set_id, envelope qids, required flags) with no extra dispatch; a prose driver still parks a set
// of 1. Driven through the real ForkedHiveDriver envelope code, with only the live CLI calls
// (dispatchFresh's skill spawn and classify) replaced.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { startRun, submitAnswers, getQuestions, __setDriverForTest } from "./kickoff-engine.ts";
import { readRunRecord, type Question } from "./run-manager.ts";
import { createSeedRepo } from "./test-cli.ts";
import { ForkedHiveDriver, type Driver, type DriverInput, type DriverResult } from "./driver.ts";

let minervaHome: string;
let seedRepo: string;
let savedDriver: Driver | undefined;
let previousSeedRepo: string | undefined;

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-question-set-"));
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

function install(d: Driver): void {
  const prev = __setDriverForTest(d);
  savedDriver = savedDriver ?? prev;
}

interface EnvelopeQuestionSpec {
  qid: string;
  text: string;
  required: boolean;
}

function envelopePath(cwd: string, id: string): string {
  return join(cwd, ".pHive", "questions", `plan-${id}.yaml`);
}

function writeEnvelope(cwd: string, id: string, questions: EnvelopeQuestionSpec[]): void {
  mkdirSync(join(cwd, ".pHive", "questions"), { recursive: true });
  writeFileSync(
    envelopePath(cwd, id),
    stringifyYaml({
      id,
      skill: "plan",
      phase: "survey",
      status: "pending",
      provenance: { raised_by: "plan", raised_at: "2026-09-28T00:00:00Z" },
      deadline: "2026-09-29T00:00:00Z",
      renewal_count: 0,
      questions: questions.map((q) => ({ ...q, kind: "free-text", options: null, answer: null })),
    }),
  );
}

const SURVEY: EnvelopeQuestionSpec[] = [
  { qid: "audience", text: "Who is the audience?", required: true },
  { qid: "tone", text: "Any tone preference?", required: false },
  { qid: "platform", text: "Which platform first?", required: true },
  { qid: "branding", text: "Any branding constraints?", required: false },
  { qid: "launch", text: "When is launch?", required: true },
];

// The real ForkedHiveDriver with its two live CLI calls replaced: each dispatchFresh plays the
// next scripted skill turn (writing the envelope the skill would write), and classify routes
// every question to the human channel without spawning anything.
class ScriptedForkedDriver extends ForkedHiveDriver {
  dispatches = 0;
  inputs: DriverInput[] = [];
  closedEnvelopes: any[] = [];
  constructor(private readonly turns: ((cwd: string) => void)[]) {
    super();
  }
  override async runTurn(input: DriverInput): Promise<DriverResult> {
    this.inputs.push(input);
    return super.runTurn(input);
  }
  protected override async dispatchFresh(cwd: string, skillPrompt: string): Promise<DriverResult> {
    const turn = this.turns[this.dispatches++];
    if (!turn) throw new Error(`unexpected dispatch #${this.dispatches}`);
    turn(cwd);
    return this.surfaceNextQuestion(cwd, skillPrompt);
  }
  protected override async classify() {
    return { suggested_channel: "human" as const, confidence: 0.4, reason: "scripted" };
  }
}

async function startForkedRun(d: ScriptedForkedDriver): Promise<string> {
  install(d);
  const { run_id } = (await startRun({ idea: "a five-question survey", defaults: { mode: "off" } })) as { run_id: string };
  return run_id;
}

function pendingHuman(runId: string): Question[] {
  return (getQuestions({ run_id: runId, channel: "human" }) as { questions: Question[] }).questions;
}

test("a forked park with a 5-question envelope records all 5 as one set, with no extra dispatch", async () => {
  const d = new ScriptedForkedDriver([(cwd) => writeEnvelope(cwd, "env-1", SURVEY)]);
  const runId = await startForkedRun(d);

  assert.equal(d.dispatches, 1, "startRun makes exactly one dispatch");
  const record = readRunRecord(runId);
  assert.equal(record.status, "waiting_on_human");
  const pending = pendingHuman(runId);
  assert.deepEqual(pending.map((q) => q.id), ["q-1", "q-2", "q-3", "q-4", "q-5"]);
  assert.deepEqual(pending.map((q) => q.qid), SURVEY.map((q) => q.qid));
  assert.deepEqual(pending.map((q) => q.text), SURVEY.map((q) => q.text));
  assert.deepEqual(pending.map((q) => q.required), [true, false, true, false, true]);
  assert.ok(pending.every((q) => q.set_id === "env-1"), "every question shares the envelope's set_id");
  assert.ok(pending.every((q) => q.kind === "free-text" && q.channel === "human"));
});

test("answering a sibling writes that sibling's qid, re-parks nothing twice, and dispatches only on closure", async () => {
  let answeredEnvelope: any;
  const d = new ScriptedForkedDriver([
    (cwd) => writeEnvelope(cwd, "env-1", SURVEY),
    (cwd) => {
      // The gateway consumes the closed envelope; the skill then raises its next set.
      answeredEnvelope = parseYaml(readFileSync(envelopePath(cwd, "env-1"), "utf8"));
      rmSync(envelopePath(cwd, "env-1"));
      writeEnvelope(cwd, "env-2", [{ qid: "confirm", text: "Ship it?", required: true }]);
    },
  ]);
  const runId = await startForkedRun(d);

  // q-3 is the third question ("platform"), not the one the session pointer names ("audience").
  await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: "q-3", answer: "web" }] });
  assert.equal(d.inputs.at(-1)!.qid, "platform");
  assert.equal(d.dispatches, 1, "a non-closing answer is absorbed with no new dispatch");
  const cwd = readRunRecord(runId).workspace_path;
  const env = parseYaml(readFileSync(envelopePath(cwd, "env-1"), "utf8"));
  assert.deepEqual(
    env.questions.map((q: any) => [q.qid, q.answer]),
    [["audience", null], ["tone", null], ["platform", "web"], ["branding", null], ["launch", null]],
  );
  let record = readRunRecord(runId);
  assert.equal(record.questions.length, 5, "the re-surfaced siblings are not parked a second time");
  assert.deepEqual(pendingHuman(runId).map((q) => q.id), ["q-1", "q-2", "q-4", "q-5"]);

  await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: "q-1", answer: "teachers" }] });
  assert.equal(d.dispatches, 1);
  await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: "q-5", answer: "May" }] });
  assert.equal(d.dispatches, 2, "the last required answer closes the envelope: one dispatch");
  assert.equal(answeredEnvelope.status, "answered");
  assert.deepEqual(
    answeredEnvelope.questions.map((q: any) => [q.qid, q.answer]),
    [["audience", "teachers"], ["tone", null], ["platform", "web"], ["branding", null], ["launch", "May"]],
  );

  record = readRunRecord(runId);
  const byId = Object.fromEntries(record.questions.map((q) => [q.id, q.status]));
  assert.deepEqual(byId, {
    "q-1": "answered",
    "q-2": "superseded",
    "q-3": "answered",
    "q-4": "superseded",
    "q-5": "answered",
    "q-6": "pending",
  });
  const next = pendingHuman(runId);
  assert.deepEqual(next.map((q) => [q.id, q.qid, q.set_id, q.required]), [["q-6", "confirm", "env-2", true]]);
});

// Prose driver: one question per turn, exactly the pre-PANT-923 shape plus set_id.
class ProseDriver implements Driver {
  turns = 0;
  async runTurn(): Promise<DriverResult> {
    this.turns++;
    return {
      session_id: "sess",
      raw_result: JSON.stringify({
        question: `Which database (turn ${this.turns})?`,
        suggested_channel: "human",
        confidence: 0.3,
        reason: "strategic",
      }),
    };
  }
}

test("a prose-driver park is a set of 1 whose set_id is its own id, and nothing else changes", async () => {
  const d = new ProseDriver();
  install(d);
  const { run_id } = (await startRun({ idea: "a tiny CLI todo app", defaults: { mode: "off" } })) as { run_id: string };
  const [parked] = readRunRecord(run_id).questions;
  // escalated_at (PANT-906) is the park-time escalation stamp; its value is a timestamp.
  const { escalated_at, ...q } = parked!;
  assert.ok(Number.isFinite(Date.parse(escalated_at!)));
  assert.deepEqual(q, {
    id: "q-1",
    text: "Which database (turn 1)?",
    suggested_channel: "human",
    confidence: 0.3,
    reason: "strategic",
    channel: "human",
    status: "pending",
    set_id: "q-1",
  });

  await submitAnswers({ run_id, channel: "human", answers: [{ question_id: "q-1", answer: "sqlite" }] });
  const record = readRunRecord(run_id);
  assert.deepEqual(record.questions.map((x) => [x.id, x.status, x.set_id]), [
    ["q-1", "answered", "q-1"],
    ["q-2", "pending", "q-2"],
  ]);
});

test("a run record written before set_id/required existed still loads and can be answered", async () => {
  const d = new ProseDriver();
  install(d);
  const { run_id } = (await startRun({ idea: "a tiny CLI todo app", defaults: { mode: "off" } })) as { run_id: string };
  const path = join(minervaHome, "runs", run_id, "run.yaml");
  assert.ok(existsSync(path));
  const raw = JSON.parse(readFileSync(path, "utf8"));
  for (const q of raw.questions) delete q.set_id;
  writeFileSync(path, JSON.stringify(raw, null, 2));

  const legacy = readRunRecord(run_id);
  assert.equal(legacy.questions[0]!.set_id, undefined);
  assert.deepEqual(pendingHuman(run_id).map((q) => q.id), ["q-1"]);
  await submitAnswers({ run_id, channel: "human", answers: [{ question_id: "q-1", answer: "postgres" }] });
  assert.deepEqual(readRunRecord(run_id).questions.map((x) => [x.id, x.status]), [
    ["q-1", "answered"],
    ["q-2", "pending"],
  ]);
});
