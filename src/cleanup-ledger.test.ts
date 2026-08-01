// cleanup-ledger.test.ts — cleanup-ledger-events story (AD-4)
// Spawns real bin/minerva.ts subprocesses. Confirms the ledger/event sink appends exactly once
// per terminal transition, workspace/state paths are never deleted, and multiple runs' records
// don't collide.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call, createSeedRepo } from "./test-cli.ts";

let minervaHome: string;
let seedRepo: string;

const TEST_DRIVE_PROMPT =
  "You are running headlessly for idea '{idea}'. Ask exactly one short question ending in " +
  "'?', then stop and wait -- do not guess, do not proceed further this turn.";

function env() {
  return {
    MINERVA_HOME: minervaHome,
    MINERVA_SEED_REPO: seedRepo,
    MINERVA_DRIVE_MODEL: "claude-haiku-4-5-20251001",
    MINERVA_TEST_DRIVE_PROMPT: TEST_DRIVE_PROMPT,
  };
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

// This file's generic "ask any question" test prompt gives the real classifier little concrete
// content to judge, unlike kickoff-engine.test.ts's specific "favorite fruit" prompt (which
// reliably classifies human) -- so the pending question may land on either channel. Check both
// rather than assuming human, to avoid flakiness this story's tests don't actually care about
// (this file is testing ledger/event bookkeeping, not classification).
function getPendingQuestion(runId: string): { question: any; channel: "agent" | "human" } {
  const human = call("getQuestions", { run_id: runId, channel: "human" }, env()).result.questions[0];
  if (human) return { question: human, channel: "human" };
  const agent = call("getQuestions", { run_id: runId, channel: "agent" }, env()).result.questions[0];
  if (agent) return { question: agent, channel: "agent" };
  throw new Error(`no pending question on either channel for run ${runId}`);
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-cleanup-"));
  seedRepo = createSeedRepo();
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
});

test("abortRun on an in-progress run: ledger + event appended once, status becomes aborted, workspace/state untouched", () => {
  const runId = call("startRun", { idea: "a task manager" }, env()).result.run_id;
  const statusBefore = call("getRunStatus", { run_id: runId }, env());
  assert.equal(statusBefore.result.status, "waiting_on_human");

  const record = JSON.parse(readFileSync(join(minervaHome, "runs", runId, "run.yaml"), "utf8"));
  assert.ok(existsSync(record.workspace_path));
  assert.ok(existsSync(record.state_path));

  const aborted = call("abortRun", { run_id: runId }, env());
  assert.equal(aborted.status, 0);

  const statusAfter = call("getRunStatus", { run_id: runId }, env());
  assert.equal(statusAfter.result.status, "aborted");

  // Never deletes -- workspace and state must still be present on disk after abort.
  assert.ok(existsSync(record.workspace_path));
  assert.ok(existsSync(record.state_path));

  const ledgerEntries = readLedgerLines().filter((l) => l.run_id === runId);
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].status, "aborted");
  assert.equal(ledgerEntries[0].workspace_path, record.workspace_path);
  assert.equal(ledgerEntries[0].state_path, record.state_path);
  assert.ok(ledgerEntries[0].closed_at);

  const eventEntries = readEventLines().filter((l) => l.run_id === runId);
  assert.equal(eventEntries.length, 1);
  assert.equal(eventEntries[0].event, "cleanup_needed");
  assert.equal(eventEntries[0].status, "aborted");
});

test("abortRun is idempotent -- calling it twice does not double-append the ledger", () => {
  const runId = call("startRun", { idea: "a to-do list" }, env()).result.run_id;
  call("abortRun", { run_id: runId }, env());
  call("abortRun", { run_id: runId }, env());

  const ledgerEntries = readLedgerLines().filter((l) => l.run_id === runId);
  assert.equal(ledgerEntries.length, 1);
});

test("completion (via output-emitter) also appends exactly one ledger + event record", () => {
  const runId = call("startRun", { idea: "a bug tracker" }, env()).result.run_id;
  const { question: q1, channel } = getPendingQuestion(runId);

  const finishInstruction =
    "My answer: yes. Now use your Write tool to create the file " +
    ".pHive/epics/bug-tracker/epic.yaml with content 'name: bug-tracker\\ntitle: Bug Tracker\\n'. " +
    "This completes the plan. Still answer the required schema fields with any placeholder text.";
  call("submitAnswers", { run_id: runId, channel, answers: [{ question_id: q1.id, answer: finishInstruction }] }, env());

  const status = call("getRunStatus", { run_id: runId }, env());
  assert.equal(status.result.status, "complete");

  const ledgerEntries = readLedgerLines().filter((l) => l.run_id === runId);
  assert.equal(ledgerEntries.length, 1);
  assert.equal(ledgerEntries[0].status, "complete");

  const eventEntries = readEventLines().filter((l) => l.run_id === runId);
  assert.equal(eventEntries.length, 1);
});

test("multiple runs' ledger entries coexist -- not overwritten or merged", () => {
  const runA = call("startRun", { idea: "app A" }, env()).result.run_id;
  const runB = call("startRun", { idea: "app B" }, env()).result.run_id;
  call("abortRun", { run_id: runA }, env());
  call("abortRun", { run_id: runB }, env());

  const entries = readLedgerLines();
  const idsSeen = new Set(entries.map((e) => e.run_id));
  assert.ok(idsSeen.has(runA));
  assert.ok(idsSeen.has(runB));
});

test("abortRun validation: missing run_id returns VALIDATION_FAILED; unknown run_id returns NOT_FOUND", () => {
  const noId = call("abortRun", {}, env());
  assert.equal(noId.status, 1);
  assert.equal(noId.error.code, "VALIDATION_FAILED");

  const unknown = call("abortRun", { run_id: "00000000-0000-0000-0000-000000000000" }, env());
  assert.equal(unknown.status, 1);
  assert.equal(unknown.error.code, "NOT_FOUND");
});
