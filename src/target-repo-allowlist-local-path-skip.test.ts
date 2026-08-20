// target-repo-allowlist-local-path-skip.test.ts — allowlist-skip-local-path-slug-derivation story
// (driver-telemetry-and-allowlist-fix epic, triage t-011). isTargetRepoAllowed() (src/kickoff-
// engine.ts) must NOT shell out to `git -C <path> remote get-url origin`
// (normalizeTargetRepoValue()'s local-path branch, src/target-repo-signal.ts:57-72) for a
// local-path allowlist entry that doesn't already exact-string-match the target_repo being
// checked -- that subprocess call is dead work (deriving a slug from an unrelated CONFIGURED path
// has nothing to do with the target actually being validated) and makes the allowlist outcome
// depend on live filesystem/git state of other configured paths.
//
// Same no-mocking, real-subprocess convention as target-repo-allowlist.test.ts (spawns the real
// bin/minerva.ts CLI, out-of-process, via test-cli.ts's call()). To PROVE "no git subprocess call
// happened" from outside that child process -- not just infer it from the boolean allow/reject
// result -- this file puts a thin logging shim named `git` at the front of PATH: every invocation
// (of any git command, by anything downstream) gets appended to a log file before being forwarded,
// unmodified, to the real git binary. Behavior is completely unchanged; only observable. Asserting
// a specific local path never appears in that log is a real, verifiable mechanism, not a mock.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call } from "./test-cli.ts";

let minervaHome: string;
let seedRepo: string;
let realGitPath: string;
let shimDir: string;
let gitCallLog: string;

// A real local git repo (with a `dev` branch) used as BOTH a local-path allowlist entry AND the
// matching target_repo, for the "exact match still works" case (AC2).
let exactMatchRepo: string;

function makeRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

function env() {
  return { MINERVA_HOME: minervaHome, MINERVA_SEED_REPO: seedRepo };
}

// Deliberately unreachable Heimdall route -- forces a fast, deterministic HeimdallRouteError ->
// UPSTREAM_ERROR on the FIRST drive turn, strictly AFTER allocateRun() has already durably created
// the run's workspace/worktree. Same technique target-repo-allowlist.test.ts uses to prove "passed
// the gate" without any real API cost.
function brokenHeimdallEnv() {
  return { ...env(), MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: "http://127.0.0.1:1" };
}

function listRunIds(): string[] {
  const dir = join(minervaHome, "runs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir);
}

// Env overlay that puts the logging `git` shim ahead of the real git on PATH, pointed at a fresh,
// per-test log file.
function withGitShim(extraEnv: Record<string, string>): Record<string, string> {
  return {
    ...extraEnv,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
    MINERVA_TEST_GIT_LOG: gitCallLog,
  };
}

function gitCallsMentioning(needle: string): string[] {
  const log = existsSync(gitCallLog) ? readFileSync(gitCallLog, "utf8") : "";
  return log.split("\n").filter((line) => line.includes(needle));
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-allowlist-localpath-"));
  seedRepo = makeRepo("minerva-allowlist-localpath-seed-repo-");
  exactMatchRepo = makeRepo("minerva-allowlist-localpath-exact-repo-");

  realGitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

  shimDir = mkdtempSync(join(tmpdir(), "minerva-git-shim-"));
  const shimPath = join(shimDir, "git");
  writeFileSync(
    shimPath,
    `#!/bin/sh\n` +
      `if [ -n "$MINERVA_TEST_GIT_LOG" ]; then printf '%s\\n' "$*" >> "$MINERVA_TEST_GIT_LOG"; fi\n` +
      `exec "${realGitPath}" "$@"\n`,
  );
  chmodSync(shimPath, 0o755);
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
  rmSync(exactMatchRepo, { recursive: true, force: true });
  rmSync(shimDir, { recursive: true, force: true });
});

beforeEach(() => {
  gitCallLog = join(mkdtempSync(join(tmpdir(), "minerva-git-log-")), "git-calls.log");
});

// --- AC1: local-path entry that does NOT match the target -- unchanged rejection, zero git calls -

test("AC1: a local-path allowlist entry that doesn't match a different-slug target_repo is rejected (unchanged outcome) WITHOUT any git subprocess call for that path", () => {
  const localPathEntry = mkdtempSync(join(tmpdir(), "minerva-allowlist-localpath-unrelated-"));
  try {
    const allowlistEnv = withGitShim({ ...env(), MINERVA_ALLOWED_TARGET_REPOS: localPathEntry });

    const res = call(
      "startRun",
      { idea: "local path entry, unrelated slug target", target_repo: "totally/unrelated-slug" },
      allowlistEnv,
    );

    assert.equal(res.status, 1);
    assert.equal(res.error.code, "VALIDATION_FAILED");
    assert.match(res.error.message.toLowerCase(), /allowlist/, "must still be rejected by the allowlist (unchanged outcome)");

    const matchingCalls = gitCallsMentioning(localPathEntry);
    assert.deepEqual(
      matchingCalls,
      [],
      "no git subprocess should ever have been invoked against the local-path allowlist entry -- the exact-string miss should short-circuit slug derivation entirely",
    );
  } finally {
    rmSync(localPathEntry, { recursive: true, force: true });
  }
});

// --- AC2: local-path entry that IS the target -- still matches via exact-string comparison -------

test("AC2: an allowlist entry that IS the target_repo (same local path) still matches via the pre-existing exact-string comparison", () => {
  const allowlistEnv = { ...brokenHeimdallEnv(), MINERVA_ALLOWED_TARGET_REPOS: `${exactMatchRepo},acme/widgets` };
  const before1 = new Set(listRunIds());

  const res = call(
    "startRun",
    { idea: "exact local path match, unchanged behavior", target_repo: exactMatchRepo },
    allowlistEnv,
  );

  // Passed the gate -- failure (if any) comes strictly later, from the deliberately broken
  // Heimdall route, never from the allowlist.
  assert.equal(res.status, 1);
  assert.equal(res.error.code, "UPSTREAM_ERROR");

  const after1 = listRunIds();
  const newRunIds = after1.filter((id) => !before1.has(id));
  assert.equal(newRunIds.length, 1);
  const runId = newRunIds[0]!;

  const worktrees = execFileSync("git", ["-C", exactMatchRepo, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  assert.match(
    worktrees,
    new RegExp(`branch refs/heads/run/${runId}`),
    "a real worktree must have been created for the exactly-matched local-path target_repo",
  );
});

// --- AC3: mixed local-path + slug entries -- slug entry still matches correctly -------------------

test("AC3: MINERVA_ALLOWED_TARGET_REPOS mixing a local-path entry and a slug entry still matches the slug entry correctly", () => {
  const localPathEntry = mkdtempSync(join(tmpdir(), "minerva-allowlist-localpath-mixed-"));
  try {
    const allowlistEnv = withGitShim({ ...env(), MINERVA_ALLOWED_TARGET_REPOS: `${localPathEntry},acme/widgets` });

    // target_repo is an ssh URL -- textually DIFFERENT from the bare "acme/widgets" allowlist
    // entry -- so this only matches via normalizeTargetRepoValue()'s slug derivation/comparison,
    // never the exact-string branch. Mirrors target-repo-allowlist.test.ts's AC2 slug-shapes case.
    const res = call(
      "startRun",
      { idea: "mixed allowlist, slug target matches", target_repo: "git@github.com:acme/widgets.git" },
      allowlistEnv,
    );

    // acme/widgets is not a literal filesystem path, so a call that PASSED the allowlist gate
    // still fails downstream at run-manager's existsSync check -- the same "passed the gate"
    // signal target-repo-allowlist.test.ts's slug-shapes test (AC2 there) uses.
    assert.equal(res.status, 1);
    assert.equal(res.error.code, "VALIDATION_FAILED");
    assert.match(res.error.message, /does not exist/, "should fail at the pre-existing existsSync check, not the allowlist");
    assert.doesNotMatch(res.error.message.toLowerCase(), /allowlist/, "must not be rejected by the allowlist -- the slug entry must still match");

    const matchingCalls = gitCallsMentioning(localPathEntry);
    assert.deepEqual(
      matchingCalls,
      [],
      "the local-path entry must still be skipped even when a slug entry elsewhere in the list is the one that actually matches",
    );
  } finally {
    rmSync(localPathEntry, { recursive: true, force: true });
  }
});
