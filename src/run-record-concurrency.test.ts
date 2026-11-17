// run-record-concurrency.test.ts — PANT-904: run.yaml writes are atomic, read-modify-writes are
// serialized by a per-run lock, and terminal statuses are sticky. Every ABI call is its own
// process, so the races here are exercised with real child processes (AD-1), not mocks.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { call } from "./test-cli.ts";
import { readRunRecord, updateRunRecord, type RunRecord } from "./run-manager.ts";
import { recordTurn } from "./kickoff-engine.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(__dirname, "run-record-harness.ts");
const TSX = join(__dirname, "..", "node_modules", ".bin", "tsx");

let minervaHome: string;
let prevHome: string | undefined;

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-"));
  prevHome = process.env.MINERVA_HOME;
  process.env.MINERVA_HOME = minervaHome;
});

after(() => {
  if (prevHome === undefined) delete process.env.MINERVA_HOME;
  else process.env.MINERVA_HOME = prevHome;
  rmSync(minervaHome, { recursive: true, force: true });
});

function runDir(runId: string): string {
  return join(minervaHome, "runs", runId);
}

// Seeds a run record directly on disk -- these tests are about the record, not workspace
// allocation (run-manager.test.ts covers that with real git repos).
function seedRun(overrides: Partial<RunRecord> = {}): string {
  const runId = randomUUID();
  const workspace = join(runDir(runId), "workspace");
  mkdirSync(workspace, { recursive: true });
  const record: RunRecord = {
    run_id: runId,
    workspace_path: workspace,
    workspace_kind: "worktree",
    state_path: join(workspace, ".pHive"),
    status: "in_progress",
    created_at: new Date().toISOString(),
    session_id: "sess-1",
    questions: [],
    output: null,
    baseline_epic_ids: [],
    ...overrides,
  };
  writeFileSync(join(runDir(runId), "run.yaml"), JSON.stringify(record, null, 2));
  return runId;
}

function runHarness(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; signal: string | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(TSX, [HARNESS, ...args], {
      env: { ...process.env, MINERVA_HOME: minervaHome, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

test("N concurrent child processes patching different fields of one run lose no field", async () => {
  const runId = seedRun();
  const CHILDREN = 6;
  const ITERATIONS = 40;
  const results = await Promise.all(
    Array.from({ length: CHILDREN }, (_, i) => runHarness(["patch", runId, `field_${i}`, String(ITERATIONS)])),
  );
  for (const r of results) assert.equal(r.code, 0, r.stderr);

  const record = readRunRecord(runId) as unknown as Record<string, unknown>;
  for (let i = 0; i < CHILDREN; i++) {
    assert.equal(record[`field_${i}`], ITERATIONS, `field_${i} lost an update`);
  }
  // The pre-existing fields survived every concurrent patch too.
  assert.equal(record.status, "in_progress");
  assert.equal(record.session_id, "sess-1");
  // No lock or temp file left behind.
  assert.deepEqual(readdirSync(runDir(runId)).sort(), ["run.yaml", "workspace"]);
});

test("an abort that lands while a turn is in flight stays aborted after the turn records", async () => {
  const runId = seedRun();
  // The turn process has read the record and its driver is mid-turn...
  const atTurnStart = readRunRecord(runId);
  assert.equal(atTurnStart.status, "in_progress");

  // ...when abortRun arrives through the real ABI, in its own process.
  const abort = call("abortRun", { run_id: runId });
  assert.equal(abort.status, 0, JSON.stringify(abort));
  assert.equal(readRunRecord(runId).status, "aborted");

  // The turn finishes and records exactly as submitAnswers/driveStart do.
  updateRunRecord(runId, { session_id: "sess-2" });
  await recordTurn(runId, JSON.stringify({ question: "Which database should we use?" }));

  const after = readRunRecord(runId);
  assert.equal(after.status, "aborted");
  assert.deepEqual(after.questions, [], "no question may be parked on an aborted run");
  assert.equal(after.session_id, "sess-2", "non-status fields still apply");

  // Exactly one terminal transition -> exactly one ledger record.
  const ledger = readFileSync(join(minervaHome, "cleanup-ledger.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((r) => r.run_id === runId);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, "aborted");
});

test("terminal statuses are sticky: a later patch cannot move a run out of complete or aborted", () => {
  for (const terminal of ["complete", "aborted"] as const) {
    const runId = seedRun({ status: terminal });
    for (const next of ["in_progress", "waiting_on_human", terminal === "complete" ? "aborted" : "complete"] as const) {
      const returned = updateRunRecord(runId, { status: next });
      assert.equal(returned.status, terminal);
      assert.equal(readRunRecord(runId).status, terminal);
    }
  }
});

test("a crash between the temp write and the rename leaves the previous record readable", async () => {
  const runId = seedRun();
  const before = readFileSync(join(runDir(runId), "run.yaml"), "utf8");

  const r = await runHarness(["update", runId, JSON.stringify({ session_id: "never-lands" })], {
    MINERVA_TEST_CRASH_BEFORE_RENAME: "1",
  });
  // tsx relays the child's SIGKILL either as the signal itself or as exit status 128+9.
  assert.ok(r.signal === "SIGKILL" || r.code === 137, `harness should have died at the crash seam (${r.code}/${r.signal}): ${r.stderr}`);

  // The previous record is intact and parses; the half-finished write never became visible.
  assert.equal(readFileSync(join(runDir(runId), "run.yaml"), "utf8"), before);
  const record = readRunRecord(runId);
  assert.equal(record.session_id, "sess-1");

  // The crash left the lock behind; once it is stale the next writer breaks it and proceeds.
  const lock = join(runDir(runId), "run.lock");
  assert.ok(existsSync(lock), "crashed writer should have died holding the lock");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(updateRunRecord(runId, { session_id: "sess-3" }).session_id, "sess-3");
  assert.equal(readRunRecord(runId).session_id, "sess-3");
  assert.ok(!existsSync(lock));
});

test("a live lock held by another writer is waited on, not broken", async () => {
  const runId = seedRun();
  const lock = join(runDir(runId), "run.lock");
  writeFileSync(lock, "other-holder");
  // Release it shortly, from outside the waiting process.
  const releaser = spawn(process.execPath, ["-e", `setTimeout(() => require("fs").unlinkSync(${JSON.stringify(lock)}), 300)`]);
  const released = new Promise((resolve) => releaser.on("close", resolve));
  const r = await runHarness(["update", runId, JSON.stringify({ session_id: "after-wait" })]);
  await released;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readRunRecord(runId).session_id, "after-wait");
});
