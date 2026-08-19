// target-repo-allowlist.test.ts — target-repo-allowlist story (harden-run-id-and-target-repo-
// boundaries epic). Spawns real bin/minerva.ts subprocesses per AD-1 (no mocking); real temp git
// repos, real filesystem/git state checks. No real `claude -p` calls are needed here: every
// "passed the gate" assertion below distinguishes itself from the allowlist-rejection error by
// checking the run either (a) fails downstream for a DIFFERENT, pre-existing reason (target_repo
// does not exist as a literal path -- the existsSync check in run-manager's
// allocateWorktreeWorkspace), or (b) actually creates a real worktree before a deliberately broken
// Heimdall route (MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL pointed at a closed port, same technique
// kickoff-engine.test.ts's orphan-cleanup tests use) turns the LATER driver-turn step into a fast,
// deterministic UPSTREAM_ERROR -- never a real API call, never a VALIDATION_FAILED allowlist miss.
//
// MINERVA_ALLOWED_TARGET_REPOS is optional (comma-separated owner/repo slugs and/or absolute local
// paths). Unset -> startRun's behavior must be byte-identical to before this story. Set -> startRun
// must check the resolved target_repo against the list BEFORE any worktree/clone operation,
// rejecting with VALIDATION_FAILED on a miss. Comparison reuses normalizeTargetRepoValue()'s
// existing slug/path classification (src/target-repo-signal.ts) -- exact match only, no globs.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call } from "./test-cli.ts";

let minervaHome: string;
let seedRepo: string;
// A real local git repo (with a `dev` branch) used as the worktree/allowlist target in the
// "proceeds normally, all the way to a real worktree" tests.
let existingRepo: string;
// A SEPARATE real local git repo used only by the "rejected call leaves the repo untouched" test,
// so its before/after git state can be asserted with nothing else ever touching it.
let guardedRepo: string;

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

function env() {
  return {
    MINERVA_HOME: minervaHome,
    MINERVA_SEED_REPO: seedRepo,
  };
}

// Deliberately unreachable Heimdall route -- forces a fast, deterministic HeimdallRouteError ->
// UPSTREAM_ERROR on the FIRST drive turn, i.e. strictly AFTER allocateRun() has already durably
// created the run's workspace/worktree (see kickoff-engine.test.ts's own orphan-cleanup tests for
// the same technique). No real `claude` process is ever spawned. This lets a test prove "the
// allowlist gate passed and a real worktree got created" without any real API cost.
function brokenHeimdallEnv() {
  return { ...env(), MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: "http://127.0.0.1:1" };
}

function listRunIds(): string[] {
  const dir = join(minervaHome, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-allowlist-"));
  seedRepo = makeRepo("minerva-allowlist-seed-repo-");
  existingRepo = makeRepo("minerva-allowlist-existing-repo-");
  guardedRepo = makeRepo("minerva-allowlist-guarded-repo-");
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
  rmSync(existingRepo, { recursive: true, force: true });
  rmSync(guardedRepo, { recursive: true, force: true });
});

// --- AC1: unset env -> completely unchanged behavior -----------------------------------------

test("AC1a: MINERVA_ALLOWED_TARGET_REPOS unset -- startRun(target_repo=<real local repo>) reaches the driver turn (past allocateRun) and actually creates a worktree", () => {
  const before1 = new Set(listRunIds());
  const res = call("startRun", { idea: "unset-env passthrough", target_repo: existingRepo }, brokenHeimdallEnv());

  // Must NOT be rejected by the allowlist (there is none) -- the failure, if any, must come from
  // strictly later (the broken Heimdall route on the drive turn), never VALIDATION_FAILED.
  assert.equal(res.status, 1);
  assert.equal(res.error.code, "UPSTREAM_ERROR");

  const after1 = listRunIds();
  const newRunIds = after1.filter((id) => !before1.has(id));
  assert.equal(newRunIds.length, 1);
  const runId = newRunIds[0]!;

  const worktrees = execFileSync("git", ["-C", existingRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.match(worktrees, new RegExp(`branch refs/heads/run/${runId}`), "worktree must have been created -- unset env means zero allowlist enforcement");
});

test("AC1b: MINERVA_ALLOWED_TARGET_REPOS unset -- an arbitrary (non-existent-path) target_repo still fails with the PRE-EXISTING 'does not exist' error, never a new allowlist error", () => {
  const res = call("startRun", { idea: "unset-env negative check", target_repo: "totally/unrelated-repo" }, env());
  assert.equal(res.status, 1);
  assert.equal(res.error.code, "VALIDATION_FAILED");
  assert.match(res.error.message, /does not exist/);
  assert.doesNotMatch(res.error.message.toLowerCase(), /allowlist/, "unset env must never enforce any allowlist, accidental or otherwise");
});

// --- AC2: slug match via all 3 input shapes ---------------------------------------------------

test("AC2: an allowed slug's bare-slug, ssh-URL, and https-URL forms all pass the allowlist gate (all normalize to the same slug)", () => {
  const allowlistEnv = { ...env(), MINERVA_ALLOWED_TARGET_REPOS: "acme/widgets,other/other" };
  const shapes = ["acme/widgets", "git@github.com:acme/widgets.git", "https://github.com/acme/widgets"];

  for (const shape of shapes) {
    const res = call("startRun", { idea: `slug shape test: ${shape}`, target_repo: shape }, allowlistEnv);
    // None of these shapes is a literal local filesystem path, so downstream still fails at
    // run-manager's existsSync check -- but that failure PROVES the allowlist gate let it through
    // (a rejected call would carry the allowlist message instead, and would fail BEFORE any
    // run directory is even allocated -- see the AC3 test's "no run created" assertion).
    assert.equal(res.status, 1, `expected shape "${shape}" to pass the gate then fail downstream`);
    assert.equal(res.error.code, "VALIDATION_FAILED");
    assert.match(res.error.message, /does not exist/, `shape "${shape}" should fail at the pre-existing existsSync check, not the allowlist`);
    assert.doesNotMatch(res.error.message.toLowerCase(), /allowlist/, `shape "${shape}" must not be rejected by the allowlist`);
  }
});

// --- AC3: slug miss rejection -------------------------------------------------------------------

test("AC3: a target_repo resolving to a slug NOT in the allowlist is rejected with VALIDATION_FAILED naming target_repo + the allowlist, before any run is allocated", () => {
  const allowlistEnv = { ...env(), MINERVA_ALLOWED_TARGET_REPOS: "acme/widgets" };
  const before1 = new Set(listRunIds());

  const res = call("startRun", { idea: "slug miss", target_repo: "other/other-repo" }, allowlistEnv);

  assert.equal(res.status, 1);
  assert.equal(res.error.code, "VALIDATION_FAILED");
  assert.match(res.error.message, /other\/other-repo/, "message must name the rejected target_repo");
  assert.match(res.error.message.toLowerCase(), /allowlist/, "message must say it's not in the configured allowlist");

  // Rejected BEFORE allocateRun -- no new run directory of any kind.
  const after1 = listRunIds();
  assert.deepEqual(after1, [...before1]);
});

// --- AC4: local-path allowlist entry match ------------------------------------------------------

test("AC4: an allowlist entry that is an absolute local path matches a target_repo resolving to that SAME local path (not just slugs)", () => {
  const before1 = new Set(listRunIds());
  const allowlistEnv = { ...brokenHeimdallEnv(), MINERVA_ALLOWED_TARGET_REPOS: `${existingRepo},acme/widgets` };

  const res = call("startRun", { idea: "local path allowlist match", target_repo: existingRepo }, allowlistEnv);

  // Passed the gate -- failure (if any) comes strictly later, from the deliberately broken
  // Heimdall route, never from the allowlist.
  assert.equal(res.status, 1);
  assert.equal(res.error.code, "UPSTREAM_ERROR");

  const after1 = listRunIds();
  const newRunIds = after1.filter((id) => !before1.has(id));
  assert.equal(newRunIds.length, 1);
  const runId = newRunIds[0]!;

  const worktrees = execFileSync("git", ["-C", existingRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.match(worktrees, new RegExp(`branch refs/heads/run/${runId}`), "a real worktree must have been created for the local-path-matched target_repo");
});

// --- AC5: rejected call leaves the target repo completely untouched ----------------------------

test("AC5: a rejected call creates no worktree and makes no commit/push -- the real target repo's git state is byte-identical before and after", () => {
  const allowlistEnv = { ...env(), MINERVA_ALLOWED_TARGET_REPOS: "acme/widgets,other/other" };

  const headBefore = execFileSync("git", ["-C", guardedRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const branchesBefore = execFileSync("git", ["-C", guardedRepo, "branch", "--list"], { encoding: "utf8" }).trim();
  const worktreesBefore = execFileSync("git", ["-C", guardedRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).trim();
  const logBefore = execFileSync("git", ["-C", guardedRepo, "log", "--all", "--oneline"], { encoding: "utf8" }).trim();
  const before1 = new Set(listRunIds());

  const res = call("startRun", { idea: "rejected -- must not touch the repo", target_repo: guardedRepo }, allowlistEnv);

  assert.equal(res.status, 1);
  assert.equal(res.error.code, "VALIDATION_FAILED");
  assert.match(res.error.message.toLowerCase(), /allowlist/);

  const headAfter = execFileSync("git", ["-C", guardedRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const branchesAfter = execFileSync("git", ["-C", guardedRepo, "branch", "--list"], { encoding: "utf8" }).trim();
  const worktreesAfter = execFileSync("git", ["-C", guardedRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" }).trim();
  const logAfter = execFileSync("git", ["-C", guardedRepo, "log", "--all", "--oneline"], { encoding: "utf8" }).trim();

  assert.equal(headAfter, headBefore, "HEAD must not move -- no commit occurred");
  assert.equal(branchesAfter, branchesBefore, "no new branch (e.g. run/<id>) must have been created");
  assert.equal(worktreesAfter, worktreesBefore, "no worktree must have been added");
  assert.equal(logAfter, logBefore, "no new commit must exist anywhere in the repo");

  // No run allocated at all -- rejection happens before allocateRun ever runs.
  const after1 = listRunIds();
  assert.deepEqual(after1, [...before1]);
});
