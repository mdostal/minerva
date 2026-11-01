// resume-lifecycle.test.ts — PANT-1249 (p2-02): resume without an answer, the mandatory
// session-gone fallback, set atomicity, idempotency and crash-safe write ordering. Driven by a
// scripted fake Driver (no live API), the same harness as submit-answers-safety.test.ts.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  startRun,
  submitAnswers,
  resumeRun,
  parkRun,
  getQuestions,
  __setDriverForTest,
} from "./kickoff-engine.ts";
import { readRunRecord, updateRunRecord, getRunStatus } from "./run-manager.ts";
import { abortRun } from "./cleanup-ledger.ts";
import { MinervaError } from "./errors.ts";
import { createSeedRepo } from "./test-cli.ts";
import { isSessionGoneError, SessionGoneError, TurnTimeoutError, type Driver, type DriverInput, type DriverResult } from "./driver.ts";

let minervaHome: string;
let seedRepo: string;
let savedDriver: Driver | undefined;
let previousSeedRepo: string | undefined;

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-resume-lifecycle-"));
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

function questionResult(turn: number, session = "sess"): DriverResult {
  return {
    session_id: session,
    raw_result: JSON.stringify({
      question: `What is the product strategy (turn ${turn})?`,
      suggested_channel: "human",
      confidence: 0.2,
      reason: "strategic, ambiguous",
      kind: "free-text",
      options: null,
      qid: `strategy-${turn}`,
    }),
  };
}

// Every turn surfaces a human question. `onTurn` may throw to inject a failure, or inspect state.
class ScriptedDriver implements Driver {
  inputs: DriverInput[] = [];
  constructor(private readonly onTurn: (input: DriverInput, turn: number) => void = () => {}) {}
  get turns(): number {
    return this.inputs.length;
  }
  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.inputs.push(input);
    this.onTurn(input, this.turns);
    return questionResult(this.turns);
  }
}

const SESSION_GONE = "claude exited with code 1: No conversation found with session ID: sess";

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

const NOW = "2026-10-31T18:00:00.000Z";

// The epoch of the run's open park, as a caller reads it from getRunStatus.
function openEpoch(runId: string): number {
  return readRunRecord(runId).park!.epoch;
}

// --- resume without an answer ---------------------------------------------------------------

test("a run parked awaiting-time resumes with cause time and no answers: exactly one turn, and it advances", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId, questionId } = await startParkedRun();
  await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "go" }] });
  const pendingId = readRunRecord(runId).questions.find((q) => q.status === "pending")!.id;
  // A time park replaces the open question park (p3-01 owns when this happens); here it is set
  // directly so the resume path is exercised on its own.
  updateRunRecord(runId, {
    questions: readRunRecord(runId).questions.map((q) => (q.id === pendingId ? { ...q, status: "superseded" as const } : q)),
  });
  parkRun(runId, { kind: "awaiting-time", not_before: NOW, renewals: 0 });
  const parked = readRunRecord(runId);
  assert.equal(parked.park?.reason.kind, "awaiting-time");
  const turnsBefore = d.turns;

  const res = await resumeRun({ run_id: runId, cause: "time", evidence: { observed_at: NOW }, park_epoch: openEpoch(runId) });

  assert.equal(res.outcome, "resumed");
  assert.equal(res.park_epoch, parked.park!.epoch);
  assert.equal(d.turns, turnsBefore + 1, "exactly one turn");
  const resumed = d.inputs.at(-1)!;
  assert.equal(resumed.sessionId, "sess", "a live session is resumed, not rebuilt");
  assert.match(resumed.prompt, /time/);
  assert.equal(resumed.qid, undefined, "a non-answer resume never names a qid");
  const after = readRunRecord(runId);
  assert.equal(after.status, "waiting_on_human");
  assert.equal(after.park?.reason.kind, "awaiting-answer", "the run advanced to its next park");
  assert.ok(after.park!.epoch > parked.park!.epoch);
});

test("a run parked awaiting-signal resumes only with cause signal and the matching signal_key", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId } = await startParkedRun();
  updateRunRecord(runId, { questions: readRunRecord(runId).questions.map((q) => ({ ...q, status: "superseded" as const })) });
  parkRun(runId, { kind: "awaiting-signal", signal_key: "ci-green" });
  const turnsBefore = d.turns;

  const wrongCause = await resumeRun({ run_id: runId, cause: "time", evidence: { observed_at: NOW }, park_epoch: openEpoch(runId) });
  assert.equal(wrongCause.outcome, "refused");
  const wrongKey = await resumeRun({ run_id: runId, cause: "signal", evidence: { observed_at: NOW, signal_key: "deploy" }, park_epoch: openEpoch(runId) });
  assert.equal(wrongKey.outcome, "refused");
  assert.equal(d.turns, turnsBefore, "a refused resume drives no turn");

  const ok = await resumeRun({ run_id: runId, cause: "signal", evidence: { observed_at: NOW, signal_key: "ci-green" }, park_epoch: openEpoch(runId) });
  assert.equal(ok.outcome, "resumed");
  assert.equal(d.turns, turnsBefore + 1);
});

test("a cause resume of a run waiting on an answer is refused and drives nothing", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId } = await startParkedRun();
  const before = readRunRecord(runId);

  const res = await resumeRun({ run_id: runId, cause: "time", evidence: { observed_at: NOW }, park_epoch: openEpoch(runId) });

  assert.equal(res.outcome, "refused");
  assert.ok(Array.isArray(res.problems) && (res.problems as string[]).length > 0);
  assert.deepEqual(readRunRecord(runId), before);
});

test("resumeRun validates its cause, evidence and required park_epoch", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId } = await startParkedRun();
  for (const params of [
    { run_id: runId, evidence: { observed_at: NOW } },
    { run_id: runId, cause: "answer", evidence: { observed_at: NOW } },
    { run_id: runId, cause: "time" },
    { run_id: runId, cause: "time", evidence: { observed_at: 7 } },
    { run_id: runId, cause: "time", evidence: { observed_at: NOW } },
    { run_id: runId, cause: "time", evidence: { observed_at: NOW }, park_epoch: -1 },
  ]) {
    await assert.rejects(resumeRun(params), (e: unknown) => e instanceof MinervaError && e.code === "VALIDATION_FAILED");
  }
});

// --- idempotency -----------------------------------------------------------------------------

test("a duplicate resume returns already_resumed and drives no second turn", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId } = await startParkedRun();
  updateRunRecord(runId, { questions: readRunRecord(runId).questions.map((q) => ({ ...q, status: "superseded" as const })) });
  parkRun(runId, { kind: "awaiting-time", not_before: NOW, renewals: 0 });
  const epoch = readRunRecord(runId).park!.epoch;

  const first = await resumeRun({ run_id: runId, cause: "time", evidence: { observed_at: NOW }, park_epoch: epoch });
  assert.equal(first.outcome, "resumed");
  const turns = d.turns;

  const again = await resumeRun({ run_id: runId, cause: "time", evidence: { observed_at: NOW }, park_epoch: epoch });
  assert.equal(again.outcome, "already_resumed");
  assert.equal(again.park_epoch, epoch);
  assert.equal(d.turns, turns, "no second turn");
});

test("a duplicate submitAnswers returns already_resumed, not NOT_FOUND, and drives no second turn", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId, questionId } = await startParkedRun();
  const answer = { run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "mango" }] };

  const first = await submitAnswers(answer);
  assert.equal(first.outcome, "resumed");
  const turns = d.turns;

  const again = await submitAnswers(answer);
  assert.equal(again.outcome, "already_resumed");
  assert.equal(d.turns, turns);
});

test("an answer to a run that is no longer parked returns stale_handle and is recorded, not dropped", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId, questionId } = await startParkedRun();
  abortRun({ run_id: runId });
  const turns = d.turns;

  const res = await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "late" }] });

  assert.equal(res.outcome, "stale_handle");
  assert.equal(d.turns, turns);
  const record = readRunRecord(runId);
  assert.equal(record.status, "aborted");
  assert.deepEqual(
    record.stale_answers?.map((a) => [a.question_id, a.answer]),
    [[questionId, "late"]],
  );
});

// --- set atomicity -----------------------------------------------------------------------------

test("a multi-answer set over two pending questions is refused whole: nothing applied, no turn", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId, questionId } = await startParkedRun();
  // A second pending question in the same parked set (an envelope set of two).
  const record = readRunRecord(runId);
  const first = record.questions.find((q) => q.id === questionId)!;
  updateRunRecord(runId, {
    questions: [...record.questions, { ...first, id: "q-2", qid: "scope", text: "What is in scope?" }],
  });
  const before = readRunRecord(runId);
  const turns = d.turns;

  await assert.rejects(
    submitAnswers({
      run_id: runId,
      channel: "human",
      answers: [
        { question_id: questionId, answer: "a" },
        { question_id: "q-2", answer: "b" },
      ],
    }),
    (e: unknown) => e instanceof MinervaError && e.code === "VALIDATION_FAILED",
  );
  assert.deepEqual(readRunRecord(runId), before, "refused whole: no question marked answered");
  assert.equal(d.turns, turns);
});

// --- session-gone fallback ---------------------------------------------------------------------

test("an answer to a run whose session no longer resolves rebuilds from state_ref and completes", async () => {
  const d = new ScriptedDriver((input) => {
    if (input.sessionId !== null) throw new Error(SESSION_GONE);
  });
  install(d);
  const { runId, questionId } = await startParkedRun();
  const drivePrompt = d.inputs[0]!.prompt;
  const turns = d.turns;

  const res = await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "mango" }] });

  assert.equal(res.outcome, "resumed");
  assert.equal(res.resumed_via, "state");
  assert.equal(d.turns, turns + 2, "the session attempt, then the rebuild");
  const rebuild = d.inputs.at(-1)!;
  assert.equal(rebuild.sessionId, null, "the rebuild never reuses the dead session");
  assert.ok(rebuild.prompt.startsWith(drivePrompt), "the rebuild re-issues the original drive prompt");
  assert.match(rebuild.prompt, /mango/, "and carries the answer being delivered");
  assert.equal(rebuild.cwd, readRunRecord(runId).workspace_path);
  const after = readRunRecord(runId);
  assert.equal(after.questions.find((q) => q.id === questionId)?.status, "answered");
  assert.equal(after.status, "waiting_on_human");
  assert.equal(after.session_id, "sess");
});

test("a run with no session_id at all rebuilds from state_ref rather than failing VALIDATION_FAILED", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId, questionId } = await startParkedRun();
  updateRunRecord(runId, { session_id: null });

  const res = await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "kiwi" }] });

  assert.equal(res.outcome, "resumed");
  assert.equal(res.resumed_via, "state");
  assert.equal(d.inputs.at(-1)!.sessionId, null);
  assert.equal(readRunRecord(runId).questions.find((q) => q.id === questionId)?.status, "answered");
});

test("a cause resume whose session is gone also rebuilds", async () => {
  const d = new ScriptedDriver((input, turn) => {
    if (turn > 1 && input.sessionId !== null) throw new Error(SESSION_GONE);
  });
  install(d);
  const { runId } = await startParkedRun();
  updateRunRecord(runId, { questions: readRunRecord(runId).questions.map((q) => ({ ...q, status: "superseded" as const })) });
  parkRun(runId, { kind: "awaiting-time", not_before: NOW, renewals: 0 });

  const res = await resumeRun({ run_id: runId, cause: "time", evidence: { observed_at: NOW }, park_epoch: openEpoch(runId) });

  assert.equal(res.outcome, "resumed");
  assert.equal(res.resumed_via, "state");
  assert.equal(d.inputs.at(-1)!.sessionId, null);
  assert.equal(readRunRecord(runId).status, "waiting_on_human");
});

test("a failure that is not session-gone is not rebuilt: the error surfaces and the question stays answerable", async () => {
  const d = new ScriptedDriver((input, turn) => {
    if (turn === 2) throw new Error("claude exited with code 1: rate limited");
  });
  install(d);
  const { runId, questionId } = await startParkedRun();

  await assert.rejects(
    submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "x" }] }),
    /rate limited/,
  );
  assert.equal(d.turns, 2, "no rebuild for an unrelated failure");
  const record = readRunRecord(runId);
  assert.equal(record.status, "waiting_on_human");
  assert.equal(record.questions.find((q) => q.id === questionId)?.status, "pending");
  assert.equal(record.resuming ?? null, null, "the claim is released");
});

test("isSessionGoneError recognises a dead --resume from each runtime, and nothing else", () => {
  for (const msg of [
    SESSION_GONE,
    "opencode exited with code 1: Error: Session not found: ses_123",
    "codex exited with code 1: No session found with id 0199",
  ]) {
    assert.equal(isSessionGoneError(new Error(msg)), true, msg);
  }
  assert.equal(isSessionGoneError(new SessionGoneError("gone")), true);
  for (const err of [
    new Error("claude exited with code 1: rate limited"),
    new TurnTimeoutError("slow", 1),
    new MinervaError("NOT_FOUND", "No run found with id x"),
    "no conversation found",
  ]) {
    assert.equal(isSessionGoneError(err), false, String(err));
  }
});

// --- crash-safe write ordering -------------------------------------------------------------------

test("during the resumed turn the question is still pending and a claim is held; a crash there is recoverable", async () => {
  let snapshot: ReturnType<typeof readRunRecord> | undefined;
  let runId = "";
  const d = new ScriptedDriver((_input, turn) => {
    if (turn === 2) snapshot = readRunRecord(runId);
  });
  install(d);
  const started = await startParkedRun();
  runId = started.runId;
  const { questionId } = started;
  await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "first" }] });

  // What the record looked like mid-turn: nothing marked answered before the turn ran.
  assert.ok(snapshot);
  assert.equal(snapshot.questions.find((q) => q.id === questionId)?.status, "pending");
  assert.equal(snapshot.status, "in_progress");
  assert.equal(snapshot.resuming?.question_id, questionId);
  assert.equal(snapshot.resuming?.pid, process.pid);

  // Simulate the process dying mid-turn: put the mid-turn record back, owned by a dead pid.
  const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
  updateRunRecord(runId, { ...snapshot, resuming: { ...snapshot.resuming!, pid: dead } });

  // Not wedged: the question is answerable again and an answer advances the run.
  const pending = getQuestions({ run_id: runId, channel: "human" }) as { questions: { id: string }[] };
  assert.deepEqual(pending.questions.map((q) => q.id), [questionId]);
  assert.equal((getRunStatus({ run_id: runId }) as { status: string }).status, "waiting_on_human");
  const turns = d.turns;
  const res = await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "again" }] });
  assert.equal(res.outcome, "resumed");
  assert.equal(d.turns, turns + 1);
  assert.equal(readRunRecord(runId).questions.find((q) => q.id === questionId)?.status, "answered");
});

test("a resume that arrives while a live claim is delivering the same answer is already_resumed", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId, questionId } = await startParkedRun();
  const epoch = readRunRecord(runId).park!.epoch;
  updateRunRecord(runId, {
    status: "in_progress",
    resuming: { epoch, pid: process.pid, host: (await import("node:os")).hostname(), started_at: NOW, question_id: questionId },
  });
  const turns = d.turns;

  const res = await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "dup" }] });

  assert.equal(res.outcome, "already_resumed");
  assert.equal(d.turns, turns);
});

// --- the park record -------------------------------------------------------------------------------

test("getRunStatus exposes the open park as a pantheon:park-record/v1 with a file-local state_ref", async () => {
  const d = new ScriptedDriver();
  install(d);
  const { runId, questionId } = await startParkedRun();
  const record = readRunRecord(runId);

  const { park } = getRunStatus({ run_id: runId }) as { park: Record<string, any> };

  assert.equal(park.schema, "pantheon:park-record/v1");
  assert.equal(park.integration, "minerva");
  assert.equal(park.run_id, runId);
  assert.equal(park.park_epoch, record.park!.epoch);
  assert.deepEqual(park.reason, { kind: "awaiting-answer", question_id: questionId, open_qids: [questionId] });
  assert.deepEqual(park.open_qids, [questionId]);
  assert.deepEqual(park.state_ref, { kind: "file", path: record.workspace_path });
  assert.deepEqual(park.resume, { method: "session", session_id: "sess" });
  assert.equal(park.workspace.path, record.workspace_path);

  await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: questionId, answer: "go" }] });
  const next = getRunStatus({ run_id: runId }) as { park: Record<string, any> };
  assert.equal(next.park.park_epoch, park.park_epoch + 1, "every park gets a new epoch");
});
