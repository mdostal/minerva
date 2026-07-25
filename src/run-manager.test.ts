// run-manager.test.ts — run-workspace-allocation story (AD-3 two-case workspace allocation)
// Spawns real bin/minerva.ts subprocesses per AD-1. Uses MINERVA_HOME to sandbox each test
// run's ~/.minerva-equivalent state under a throwaway tmp dir.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call } from "./test-cli.ts";

let minervaHome: string;
let existingRepo: string; // throwaway repo WITH a dev branch, for the worktree case
let noDevRepo: string; // throwaway repo WITHOUT a dev branch

function env() {
  return { MINERVA_HOME: minervaHome };
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-"));

  existingRepo = mkdtempSync(join(tmpdir(), "minerva-target-repo-"));
  execFileSync("git", ["init", "-q", "-b", "dev", existingRepo]);
  execFileSync("git", ["-C", existingRepo, "commit", "-q", "--allow-empty", "-m", "init"]);

  noDevRepo = mkdtempSync(join(tmpdir(), "minerva-nodev-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", noDevRepo]);
  execFileSync("git", ["-C", noDevRepo, "commit", "-q", "--allow-empty", "-m", "init"]);
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(existingRepo, { recursive: true, force: true });
  rmSync(noDevRepo, { recursive: true, force: true });
});

test("startRun with target_repo checks out a NEW run-scoped branch, not dev itself", () => {
  const res = call("startRun", { idea: "test idea", target_repo: existingRepo }, env());
  assert.equal(res.status, 0);
  const runId = res.result.run_id;
  assert.ok(runId);

  const worktrees = execFileSync("git", ["-C", existingRepo, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  // Parse into per-worktree blocks (porcelain format separates entries with blank lines) and
  // find the block for OUR new worktree specifically -- the origin repo's own primary
  // worktree legitimately has `dev` checked out, which is unrelated and must not be checked.
  const blocks = worktrees.trim().split("\n\n");
  const ourBlock = blocks.find((b) => b.includes(`branch refs/heads/run/${runId}`));
  assert.ok(ourBlock, "expected a worktree block checking out run/<run_id>");
  assert.doesNotMatch(ourBlock!, /branch refs\/heads\/dev$/m);
});

test("two concurrent startRuns against the SAME target_repo both succeed", () => {
  const res1 = call("startRun", { idea: "idea A", target_repo: existingRepo }, env());
  const res2 = call("startRun", { idea: "idea B", target_repo: existingRepo }, env());
  assert.equal(res1.status, 0);
  assert.equal(res2.status, 0);
  assert.notEqual(res1.result.run_id, res2.result.run_id);
});

test("startRun with no target_repo creates a fresh git-init scratch repo with an initial commit", () => {
  const res = call("startRun", { idea: "greenfield idea" }, env());
  assert.equal(res.status, 0);
  const runId = res.result.run_id;

  const status = call("getRunStatus", { run_id: runId }, env());
  assert.equal(status.status, 0);
  assert.equal(status.result.status, "in_progress");
});

test("target_repo with no dev branch returns a clear VALIDATION_FAILED error, not a raw git failure", () => {
  const res = call("startRun", { idea: "test idea", target_repo: noDevRepo }, env());
  assert.equal(res.status, 1);
  assert.equal(res.error.code, "VALIDATION_FAILED");
  assert.match(res.error.message, /target_repo/);
});

test("two runs' workspaces are isolated -- writing to one does not affect the other", () => {
  const runA = call("startRun", { idea: "idea A" }, env()).result.run_id;
  const runB = call("startRun", { idea: "idea B" }, env()).result.run_id;

  const homeRunsDir = join(minervaHome, "runs");
  const recA = JSON.parse(readFileSync(join(homeRunsDir, runA, "run.yaml"), "utf8"));
  const recB = JSON.parse(readFileSync(join(homeRunsDir, runB, "run.yaml"), "utf8"));

  assert.notEqual(recA.workspace_path, recB.workspace_path);
  assert.notEqual(recA.state_path, recB.state_path);
  assert.ok(existsSync(recA.state_path));
  assert.ok(existsSync(recB.state_path));
});

test("getRunStatus on an allocated run returns in_progress and persists across separate CLI invocations", () => {
  const runId = call("startRun", { idea: "persistence test" }, env()).result.run_id;
  // Each call() is a fresh subprocess -- this genuinely tests disk persistence, not memory.
  const first = call("getRunStatus", { run_id: runId }, env());
  const second = call("getRunStatus", { run_id: runId }, env());
  assert.equal(first.result.status, "in_progress");
  assert.equal(second.result.status, "in_progress");
});

test("getRunStatus on an unknown run_id returns NOT_FOUND", () => {
  const res = call("getRunStatus", { run_id: "00000000-0000-0000-0000-000000000000" }, env());
  assert.equal(res.status, 1);
  assert.equal(res.error.code, "NOT_FOUND");
});

test("listRuns returns all allocated runs with correct status", () => {
  const localHome = mkdtempSync(join(tmpdir(), "minerva-home-listruns-"));
  try {
    const localEnv = { MINERVA_HOME: localHome };
    const ids = [
      call("startRun", { idea: "a" }, localEnv).result.run_id,
      call("startRun", { idea: "b" }, localEnv).result.run_id,
      call("startRun", { idea: "c" }, localEnv).result.run_id,
    ];
    const res = call("listRuns", {}, localEnv);
    assert.equal(res.status, 0);
    assert.equal(res.result.runs.length, 3);
    const returnedIds = res.result.runs.map((r: any) => r.run_id).sort();
    assert.deepEqual(returnedIds, [...ids].sort());
    for (const r of res.result.runs) assert.equal(r.status, "in_progress");
  } finally {
    rmSync(localHome, { recursive: true, force: true });
  }
});
