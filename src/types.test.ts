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
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { MinervaError, type ErrorCode } from "./errors.ts";
import { dispatch } from "./dispatch.ts";
import {
  allocateRun,
  defaultSeedRepoPath,
  updateRunRecord,
  readRunRecord,
  normalizeQuestionKind,
  type Channel,
  type RunStatus,
  type Question,
  type QuestionKind,
} from "./run-manager.ts";
import { getQuestions, submitAnswers } from "./kickoff-engine.ts";
import { checkAndMarkComplete } from "./output-emitter.ts";
import { abortRun, type CleanupLedgerRecord } from "./cleanup-ledger.ts";

let minervaHome: string;
let seedRepo: string;

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-types-"));
  seedRepo = mkdtempSync(join(tmpdir(), "minerva-seed-repo-types-"));
  execFileSync("git", ["init", "-q", "-b", "dev", seedRepo]);
  execFileSync("git", ["-C", seedRepo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", seedRepo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", seedRepo, "commit", "-q", "--allow-empty", "-m", "seed init"]);
  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_SEED_REPO = seedRepo;
});

after(() => {
  delete process.env.MINERVA_HOME;
  delete process.env.MINERVA_SEED_REPO;
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
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

test("Status is closed to exactly in_progress|waiting_on_human|awaiting-consus|complete|aborted -- exhaustive switch compiles", () => {
  function assertExhaustive(s: RunStatus): RunStatus {
    switch (s) {
      case "in_progress":
      case "waiting_on_human":
      case "awaiting-consus":
      case "complete":
      case "aborted":
        return s;
      default: {
        const _exhaustive: never = s;
        throw new Error(`unreachable status: ${_exhaustive}`);
      }
    }
  }
  for (const s of ["in_progress", "waiting_on_human", "awaiting-consus", "complete", "aborted"] as const) {
    assert.equal(assertExhaustive(s), s);
  }
});

test("allocateRun starts a run in_progress with no pending questions", () => {
  const { run_id: runId } = allocateRun("fresh run", undefined);
  const record = readRunRecord(runId);
  assert.equal(record.status, "in_progress");
  assert.deepEqual(record.questions, []);
});

test("defaultSeedRepoPath uses ~/repos/consus-seeds when MINERVA_SEED_REPO is unset", () => {
  assert.equal(defaultSeedRepoPath(), join(homedir(), "repos", "consus-seeds"));
});

test("allocateRun with no target_repo uses MINERVA_SEED_REPO as a worktree source", () => {
  const { run_id: runId } = allocateRun("seeded greenfield run", undefined);
  const record = readRunRecord(runId);
  assert.equal(record.workspace_kind, "worktree");
  assert.ok(existsSync(record.workspace_path));

  const worktrees = execFileSync("git", ["-C", seedRepo, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  assert.match(worktrees, new RegExp(`branch refs/heads/run/${runId}`));
});

test("allocateRun with no target_repo fails with setup instructions when the seed repo is missing", () => {
  const previousSeedRepo = process.env.MINERVA_SEED_REPO;
  process.env.MINERVA_SEED_REPO = join(tmpdir(), `minerva-missing-seed-repo-${Date.now()}`);
  try {
    assert.throws(
      () => allocateRun("missing seed repo", undefined),
      (e) =>
        e instanceof MinervaError &&
        e.code === "VALIDATION_FAILED" &&
        /Seed repo does not exist/.test(e.message) &&
        /MINERVA_SEED_REPO/.test(e.message) &&
        /git clone/.test(e.message),
    );
  } finally {
    if (previousSeedRepo) {
      process.env.MINERVA_SEED_REPO = previousSeedRepo;
    } else {
      delete process.env.MINERVA_SEED_REPO;
    }
  }
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

// add-upstream-error-code: closed to six values now -- UPSTREAM_ERROR added for handler-catch
// failures against an internal/upstream dependency (e.g. HeimdallRouteError), distinguishable
// from the genuine "no such method" UNKNOWN_METHOD case. See dispatch.ts.
test("ErrorCode is closed to exactly these six values -- exhaustive switch compiles", () => {
  const ALL_CODES: ErrorCode[] = [
    "NOT_FOUND",
    "VALIDATION_FAILED",
    "WRONG_CHANNEL",
    "NOT_READY",
    "UNKNOWN_METHOD",
    "UPSTREAM_ERROR",
  ];

  function assertExhaustive(code: ErrorCode): ErrorCode {
    switch (code) {
      case "NOT_FOUND":
      case "VALIDATION_FAILED":
      case "WRONG_CHANNEL":
      case "NOT_READY":
      case "UNKNOWN_METHOD":
      case "UPSTREAM_ERROR":
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

// --- Question/Answer type extension (forked-driver-integration epic) ----------------------
// Additive fields for ForkedHiveDriver's structured envelope questions -- kind/options/qid are
// all optional, so SpawnDriver/SubagentDriver's existing free-text-only Question construction
// (which never sets them) remains valid and unaffected. See
// .pHive/epics/forked-driver-integration/stories/question-answer-type-extension.yaml.

test("Question accepts the optional kind/options/qid fields without requiring them", () => {
  // Existing free-text-only shape (SpawnDriver/SubagentDriver's actual usage) -- must still
  // compile and construct with none of the new fields present.
  const plain: Question = {
    id: "q-1",
    text: "What's your favorite fruit?",
    suggested_channel: "human",
    confidence: 0.9,
    reason: "test",
    channel: "human",
    status: "pending",
  };
  assert.equal(plain.kind, undefined);

  // Extended shape (ForkedHiveDriver's envelope-sourced questions).
  const extended: Question = {
    ...plain,
    kind: "single-select",
    options: ["yes", "no"],
    qid: "enable_metrics",
  };
  assert.equal(extended.kind, "single-select");
  assert.deepEqual(extended.options, ["yes", "no"]);
  assert.equal(extended.qid, "enable_metrics");
});

test("QuestionKind is closed to exactly single-select|multi-select|free-text -- exhaustive switch compiles", () => {
  function assertExhaustive(k: QuestionKind): QuestionKind {
    switch (k) {
      case "single-select":
      case "multi-select":
      case "free-text":
        return k;
      default: {
        const _exhaustive: never = k;
        throw new Error(`unreachable kind: ${_exhaustive}`);
      }
    }
  }
  for (const k of ["single-select", "multi-select", "free-text"] as const) {
    assert.equal(assertExhaustive(k), k);
  }
});

test("normalizeQuestionKind passes through the three documented values unchanged", () => {
  assert.equal(normalizeQuestionKind("single-select"), "single-select");
  assert.equal(normalizeQuestionKind("multi-select"), "multi-select");
  assert.equal(normalizeQuestionKind("free-text"), "free-text");
});

test("normalizeQuestionKind defaults any unrecognized value to free-text, never throws", () => {
  // The empirically-observed (pre-fix, self-simulation-artifact) yes-no value, kept as a
  // regression case even though it's no longer expected from a genuine gateway run -- the
  // defensive requirement stands regardless of whether this exact value recurs.
  assert.equal(normalizeQuestionKind("yes-no"), "free-text");
  assert.equal(normalizeQuestionKind(undefined), "free-text");
  assert.equal(normalizeQuestionKind(null), "free-text");
  assert.equal(normalizeQuestionKind(""), "free-text");
  assert.equal(normalizeQuestionKind(42), "free-text");
  assert.equal(normalizeQuestionKind({}), "free-text");
});

test("submitAnswers' Answer type accepts a string[] answer (multi-select), not just a bare string", async () => {
  const { run_id: runId } = allocateRun("multi-select answer check", undefined);
  updateRunRecord(runId, {
    status: "waiting_on_human",
    questions: [
      {
        id: "q-1",
        text: "Pick your favorite fruits",
        suggested_channel: "human",
        confidence: 0.9,
        reason: "test",
        channel: "human",
        status: "pending",
        kind: "multi-select",
        options: ["apple", "mango", "kiwi"],
        qid: "favorite_fruits",
      },
    ],
  });

  // A string[] answer must pass the answers[]-shape check specifically -- confirmed by asserting
  // the rejection is NOT the shape-check's own error message, even though the call still fails
  // downstream (no active drive session in this fast, live-API-free test) for an unrelated
  // reason. This confirms the type extension is honored at the runtime validation layer, not
  // just the TypeScript type declaration.
  await assert.rejects(
    () => submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: "q-1", answer: ["apple", "mango"] }] }),
    (e) =>
      e instanceof MinervaError &&
      !/non-empty answers array/.test(e.message),
  );
});
