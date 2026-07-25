// types.test.ts — lock-core-types story (swappable-driver epic)
//
// Fast, deterministic, live-API-free tests that pin the stable contract every Driver
// implementation (SpawnDriver, SubagentDriver, and later ForkedHiveDriver) must satisfy. This
// is the FIXED POINT referenced by docs/minerva-next-tests-and-driver-paths.md: no test in this
// file spawns a real `claude` process. Where a behavior is already covered by an existing
// live-API integration test (e.g. escalation-classification.test.ts's malformed-JSON/clamp
// fixtures, cleanup-ledger.test.ts's CLI-driven ledger checks), this file does not restate it --
// it adds the direct, fast layer underneath, using functions imported directly rather than the
// bin/minerva.ts subprocess boundary, and exercising code paths those integration tests can't
// reach without a live call (e.g. validation failures that throw before ever spawning claude).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MinervaError, type ErrorCode } from "./errors.ts";
import { dispatch } from "./dispatch.ts";
import { allocateRun, updateRunRecord, readRunRecord, type Channel, type RunStatus } from "./run-manager.ts";
import { getQuestions, submitAnswers } from "./kickoff-engine.ts";
import { checkAndMarkComplete } from "./output-emitter.ts";
import { abortRun, type CleanupLedgerRecord } from "./cleanup-ledger.ts";

let minervaHome: string;

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-types-"));
  process.env.MINERVA_HOME = minervaHome;
});

after(() => {
  delete process.env.MINERVA_HOME;
  rmSync(minervaHome, { recursive: true, force: true });
});

function ledgerLines(): CleanupLedgerRecord[] {
  const path = join(minervaHome, "cleanup-ledger.jsonl");
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// --- Channel: exhaustive, not sampled -----------------------------------------------------

test("Channel is closed to exactly agent|human -- exhaustive switch compiles", () => {
  function assertExhaustive(c: Channel): "agent" | "human" {
    switch (c) {
      case "agent":
      case "human":
        return c;
      default: {
        const _exhaustive: never = c;
        throw new Error(`unreachable channel: ${_exhaustive}`);
      }
    }
  }
  assert.equal(assertExhaustive("agent"), "agent");
  assert.equal(assertExhaustive("human"), "human");
});

test("getQuestions rejects every non-agent/human channel value before ever touching a run record", () => {
  for (const bad of ["robot", "", 123, null, undefined, {}, ["agent"]]) {
    assert.throws(
      () => getQuestions({ run_id: "00000000-0000-0000-0000-000000000000", channel: bad as any }),
      (e) => e instanceof MinervaError && e.code === "VALIDATION_FAILED",
      `expected VALIDATION_FAILED for channel=${JSON.stringify(bad)}`,
    );
  }
});

test("getQuestions accepts agent/human and proceeds past channel validation (NOT_FOUND, not VALIDATION_FAILED)", () => {
  for (const good of ["agent", "human"] as const) {
    assert.throws(
      () => getQuestions({ run_id: "00000000-0000-0000-0000-000000000000", channel: good }),
      (e) => e instanceof MinervaError && e.code === "NOT_FOUND",
    );
  }
});

// --- ClassifiedQuestion -------------------------------------------------------------------
// Safe-default fallback and confidence clamp are already pinned by
// escalation-classification.test.ts's fixture-based tests -- not restated here.

// --- ABI envelope: one-in, one-out -------------------------------------------------------

test("dispatch: valid method (capabilities) returns exactly a {result} envelope", async () => {
  const res = await dispatch({ method: "capabilities" });
  assert.ok("result" in res);
  assert.equal((res as any).result.abi_version, "1.0.0");
});

test("dispatch: unknown method returns exactly an {error: UNKNOWN_METHOD} envelope", async () => {
  const res = await dispatch({ method: "doesNotExist" });
  assert.ok("error" in res);
  assert.equal((res as any).error.code, "UNKNOWN_METHOD");
});

test("dispatch: malformed envelope (no method, or not an object) returns {error: VALIDATION_FAILED}", async () => {
  for (const bad of [{}, null, "startRun", 42, { params: {} }]) {
    const res = await dispatch(bad);
    assert.ok("error" in res, `expected error for ${JSON.stringify(bad)}`);
    assert.equal((res as any).error.code, "VALIDATION_FAILED");
  }
});

test("dispatch: a handler's thrown MinervaError maps 1:1 to {error} with the same code -- never swallowed into UNKNOWN_METHOD", async () => {
  const res = await dispatch({ method: "getRunStatus", params: { run_id: "00000000-0000-0000-0000-000000000000" } });
  assert.ok("error" in res);
  assert.equal((res as any).error.code, "NOT_FOUND");
});

// --- submitAnswers: keyed on question_id, not id -----------------------------------------

test("submitAnswers regression-locks the answers[] key as question_id -- payloads keyed on `id` are rejected as malformed", async () => {
  const { run_id: runId } = allocateRun("regression check", undefined);
  await assert.rejects(
    () => submitAnswers({ run_id: runId, channel: "human", answers: [{ id: "q-1", answer: "foo" }] }),
    (e) => e instanceof MinervaError && e.code === "VALIDATION_FAILED",
  );
});

test("submitAnswers accepts the correctly-keyed question_id shape past the shape check (fails later, on NOT_FOUND, not on shape)", async () => {
  const { run_id: runId } = allocateRun("regression check 2", undefined);
  await assert.rejects(
    () => submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: "q-1", answer: "foo" }] }),
    (e) => e instanceof MinervaError && e.code === "NOT_FOUND",
  );
});

// --- Status transitions + stall invariant -------------------------------------------------

test("Status is closed to exactly in_progress|waiting_on_human|complete|aborted -- exhaustive switch compiles", () => {
  function assertExhaustive(s: RunStatus): RunStatus {
    switch (s) {
      case "in_progress":
      case "waiting_on_human":
      case "complete":
      case "aborted":
        return s;
      default: {
        const _exhaustive: never = s;
        throw new Error(`unreachable status: ${_exhaustive}`);
      }
    }
  }
  for (const s of ["in_progress", "waiting_on_human", "complete", "aborted"] as const) {
    assert.equal(assertExhaustive(s), s);
  }
});

test("allocateRun starts a run in_progress with no pending questions", () => {
  const { run_id: runId } = allocateRun("fresh run", undefined);
  const record = readRunRecord(runId);
  assert.equal(record.status, "in_progress");
  assert.deepEqual(record.questions, []);
});

test("stall invariant: a rejected submitAnswers call (wrong channel) never advances status or answers the question", async () => {
  const { run_id: runId } = allocateRun("stall check 1", undefined);
  updateRunRecord(runId, {
    status: "waiting_on_human",
    questions: [
      { id: "q-1", text: "Pick a color?", suggested_channel: "human", confidence: 0.9, reason: "test", channel: "human", status: "pending" },
    ],
  });

  await assert.rejects(
    () => submitAnswers({ run_id: runId, channel: "agent", answers: [{ question_id: "q-1", answer: "blue" }] }),
    (e) => e instanceof MinervaError && e.code === "WRONG_CHANNEL",
  );

  const after = readRunRecord(runId);
  assert.equal(after.status, "waiting_on_human");
  assert.equal(after.questions[0]?.status, "pending");
});

test("stall invariant: a rejected submitAnswers call (unknown question_id) never advances status", async () => {
  const { run_id: runId } = allocateRun("stall check 2", undefined);
  updateRunRecord(runId, {
    status: "waiting_on_human",
    questions: [
      { id: "q-1", text: "Pick a color?", suggested_channel: "human", confidence: 0.9, reason: "test", channel: "human", status: "pending" },
    ],
  });

  await assert.rejects(
    () => submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: "q-nonexistent", answer: "blue" }] }),
    (e) => e instanceof MinervaError && e.code === "NOT_FOUND",
  );

  const after = readRunRecord(runId);
  assert.equal(after.status, "waiting_on_human");
  assert.equal(after.questions[0]?.status, "pending");
});

test("getQuestions never resurfaces an already-answered question on either channel", () => {
  const { run_id: runId } = allocateRun("answered filter check", undefined);
  updateRunRecord(runId, {
    questions: [
      { id: "q-1", text: "Answered one", suggested_channel: "human", confidence: 0.9, reason: "test", channel: "human", status: "answered" },
      { id: "q-2", text: "Pending one", suggested_channel: "human", confidence: 0.9, reason: "test", channel: "human", status: "pending" },
    ],
  });

  const human = getQuestions({ run_id: runId, channel: "human" });
  const ids = (human.questions as any[]).map((q) => q.id);
  assert.deepEqual(ids, ["q-2"]);
});

// --- Closed error enum ---------------------------------------------------------------------

test("ErrorCode is closed to exactly these five values -- exhaustive switch compiles", () => {
  const ALL_CODES: ErrorCode[] = ["NOT_FOUND", "VALIDATION_FAILED", "WRONG_CHANNEL", "NOT_READY", "UNKNOWN_METHOD"];

  function assertExhaustive(code: ErrorCode): ErrorCode {
    switch (code) {
      case "NOT_FOUND":
      case "VALIDATION_FAILED":
      case "WRONG_CHANNEL":
      case "NOT_READY":
      case "UNKNOWN_METHOD":
        return code;
      default: {
        const _exhaustive: never = code;
        throw new Error(`unreachable code: ${_exhaustive}`);
      }
    }
  }

  for (const c of ALL_CODES) assert.equal(assertExhaustive(c), c);

  const err = new MinervaError("NOT_FOUND", "test");
  assert.ok(ALL_CODES.includes(err.code));
});

// --- Cleanup ledger (AD-4): record shape, both terminal variants, never a delete path ------

test("CleanupLedgerRecord has exactly the AD-4 fields, no more, no less -- on the aborted path", () => {
  const { run_id: runId } = allocateRun("ledger shape aborted", undefined);
  const before = readRunRecord(runId);

  abortRun({ run_id: runId });

  const entries = ledgerLines().filter((l) => l.run_id === runId);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), ["closed_at", "run_id", "state_path", "status", "workspace_path"].sort());
  assert.equal(entry.status, "aborted");

  // Never deletes -- record only, per AD-4.
  assert.ok(existsSync(before.workspace_path));
  assert.ok(existsSync(before.state_path));
});

test("CleanupLedgerRecord has exactly the AD-4 fields on the completion path too, via checkAndMarkComplete", () => {
  const { run_id: runId } = allocateRun("ledger shape complete", undefined);
  const record = readRunRecord(runId);

  const epicDir = join(record.workspace_path, ".pHive", "epics", "test-epic");
  mkdirSync(epicDir, { recursive: true });
  writeFileSync(join(epicDir, "epic.yaml"), "name: test-epic\ntitle: Test Epic\n");

  const completed = checkAndMarkComplete(runId);
  assert.equal(completed, true);

  const entries = ledgerLines().filter((l) => l.run_id === runId);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.ok(entry);
  assert.deepEqual(Object.keys(entry).sort(), ["closed_at", "run_id", "state_path", "status", "workspace_path"].sort());
  assert.equal(entry.status, "complete");
});

test("abortRun is idempotent on an already-terminal run -- no double ledger record", () => {
  const { run_id: runId } = allocateRun("idempotent abort", undefined);
  updateRunRecord(runId, { status: "complete" });

  abortRun({ run_id: runId });
  abortRun({ run_id: runId });

  const entries = ledgerLines().filter((l) => l.run_id === runId);
  assert.equal(entries.length, 0); // already-terminal short-circuits before recordCleanup ever runs
});
