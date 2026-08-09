// output-emitter.test.ts — output-emitter story (REQ-04)
// Spawns real bin/minerva.ts subprocesses, which spawn real `claude -p` subprocesses. Confirms
// completion is detected as a FILESYSTEM fact (an epic.yaml appearing under the workspace's
// .pHive/epics/, exactly what plugin-hive's real /plan skill writes as part of its own normal
// operation -- verified empirically that a headless driven session with bypassPermissions
// genuinely writes real files), not a self-reported "I'm done" signal in the schema-forced
// chat response.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call, createSeedRepo } from "./test-cli.ts";
import { findCompletedEpic, commitPlan, pushPlan } from "./output-emitter.ts";

let minervaHome: string;
let seedRepo: string;

const TEST_DRIVE_PROMPT =
  "You are running headlessly for idea '{idea}'. You need one piece of information from the " +
  "human operator: their favorite fruit. Ask exactly one clear question in your final " +
  "response, then stop and wait -- do not guess, do not proceed further this turn.";

function env() {
  return {
    MINERVA_HOME: minervaHome,
    MINERVA_SEED_REPO: seedRepo,
    MINERVA_DRIVE_MODEL: "claude-haiku-4-5-20251001",
    MINERVA_TEST_DRIVE_PROMPT: TEST_DRIVE_PROMPT,
  };
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-output-"));
  seedRepo = createSeedRepo();
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
});

test("getOutput on an incomplete run returns NOT_READY, never a partial artifact", () => {
  const runId = call("startRun", { idea: "a weather app" }, env()).result.run_id;
  const output = call("getOutput", { run_id: runId }, env());
  assert.equal(output.status, 1);
  assert.equal(output.error.code, "NOT_READY");
});

test("a run that writes epic.yaml + story files is detected as complete and served via getOutput", () => {
  const runId = call("startRun", { idea: "a recipe organizer" }, env()).result.run_id;
  const q1 = call("getQuestions", { run_id: runId, channel: "human" }, env()).result.questions[0];

  // Simulate plugin-hive's real /plan skill finishing: it writes epic.yaml + story YAMLs
  // directly to the workspace using its own Write tool access (confirmed this really happens
  // headlessly with --permission-mode bypassPermissions). The schema still forces a "question"
  // field in the response even though there's nothing left to ask -- recordTurn must ignore
  // that and detect completion from the filesystem instead.
  const finishInstruction =
    "My answer: mango. Now use your Write tool to create the file " +
    ".pHive/epics/recipe-organizer/epic.yaml with this exact content:\n" +
    "name: recipe-organizer\ntitle: Recipe Organizer\nstories:\n  - id: story-1\n" +
    "Also create .pHive/epics/recipe-organizer/stories/story-1.yaml with this exact content:\n" +
    "id: story-1\ntitle: Build the recipe list view\n" +
    "This completes the plan -- there is nothing further to ask. Still answer the required " +
    "schema fields with any placeholder text since the schema requires them.";

  const submitted = call(
    "submitAnswers",
    { run_id: runId, channel: "human", answers: [{ question_id: q1.id, answer: finishInstruction }] },
    env(),
  );
  assert.equal(submitted.status, 0);

  const status = call("getRunStatus", { run_id: runId }, env());
  assert.equal(status.result.status, "complete");

  // No pending question should exist on either channel once complete.
  const human = call("getQuestions", { run_id: runId, channel: "human" }, env());
  const agent = call("getQuestions", { run_id: runId, channel: "agent" }, env());
  assert.equal(human.result.questions.length, 0);
  assert.equal(agent.result.questions.length, 0);

  const output = call("getOutput", { run_id: runId }, env());
  assert.equal(output.status, 0);
  assert.equal(output.result.epic.epic_id, "recipe-organizer");
  assert.match(output.result.epic.epic_yaml, /name: recipe-organizer/);
  assert.equal(output.result.epic.stories.length, 1);
  assert.equal(output.result.epic.stories[0].id, "story-1");
  assert.match(output.result.epic.stories[0].content, /Build the recipe list view/);

  // PAN-6746: checkAndMarkComplete must auto-commit the epic dir into the workspace's own git
  // history -- no manual commit step should be required before a build agent can read the plan.
  const runRecord = JSON.parse(readFileSync(join(minervaHome, "runs", runId, "run.yaml"), "utf8"));
  const log = execFileSync(
    "git",
    ["-C", runRecord.workspace_path, "log", "--oneline", "-1", "--", ".pHive/epics/recipe-organizer"],
    { encoding: "utf8" },
  );
  assert.match(log, /chore\(plan\): commit epic plan for recipe-organizer/);
  const statusAfter = execFileSync(
    "git",
    ["-C", runRecord.workspace_path, "status", "--porcelain", "--", ".pHive/epics/recipe-organizer"],
    { encoding: "utf8" },
  );
  assert.equal(statusAfter.trim(), "", "epic dir should be fully committed, nothing left pending");
});

test("findCompletedEpic also finds an epic written inside a claude --bg auto-created worktree, not just directly under workspace_path", () => {
  // Real finding (wire-driver-selection story): `claude --bg` auto-creates its own git
  // worktree under <cwd>/.claude/worktrees/<random-name>/ whenever cwd is inside a git repo --
  // which Minerva's workspaces always are (AD-3). SubagentDriver-driven runs write their
  // epic.yaml there, not directly under workspace_path, unlike SpawnDriver's `-p` calls.
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-worktree-completion-"));
  const nestedEpicsDir = join(workspacePath, ".claude", "worktrees", "some-worktree-name", ".pHive", "epics", "nested-epic");
  mkdirSync(join(nestedEpicsDir, "stories"), { recursive: true });
  writeFileSync(join(nestedEpicsDir, "epic.yaml"), "name: nested-epic\ntitle: Nested Epic\n");
  writeFileSync(join(nestedEpicsDir, "stories", "story-1.yaml"), "id: story-1\ntitle: A nested story\n");

  const found = findCompletedEpic(workspacePath);
  assert.ok(found, "expected findCompletedEpic to find the epic nested under .claude/worktrees/*");
  assert.equal(found?.epic_id, "nested-epic");
  assert.match(found?.epic_yaml ?? "", /name: nested-epic/);
  assert.equal(found?.stories.length, 1);
  assert.equal(found?.stories[0]?.id, "story-1");

  rmSync(workspacePath, { recursive: true, force: true });
});

test("getOutput validation: missing run_id returns VALIDATION_FAILED; unknown run_id returns NOT_FOUND", () => {
  const noId = call("getOutput", {}, env());
  assert.equal(noId.status, 1);
  assert.equal(noId.error.code, "VALIDATION_FAILED");

  const unknown = call("getOutput", { run_id: "00000000-0000-0000-0000-000000000000" }, env());
  assert.equal(unknown.status, 1);
  assert.equal(unknown.error.code, "NOT_FOUND");
});

// commitPlan story (PAN-6746): unit-level git-mechanics tests against throwaway temp repos,
// mirroring run-manager.test.ts's git-focused tests -- no need to pay for a real claude drive
// to exercise commitPlan's own idempotency/message-format/gitignore behavior in isolation.
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "minerva-commit-plan-repo-"));
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

function writeEpic(repo: string, epicId: string): void {
  const epicDir = join(repo, ".pHive", "epics", epicId);
  mkdirSync(join(epicDir, "stories"), { recursive: true });
  writeFileSync(join(epicDir, "epic.yaml"), `name: ${epicId}\ntitle: Test Epic\n`);
  writeFileSync(join(epicDir, "stories", "story-1.yaml"), "id: story-1\ntitle: A story\n");
}

test("commitPlan commits an untracked epic dir with a conventional commit message", () => {
  const repo = initRepo();
  try {
    writeEpic(repo, "widget-epic");
    commitPlan(repo, "widget-epic");

    const log = execFileSync("git", ["-C", repo, "log", "--oneline", "-1"], { encoding: "utf8" });
    assert.match(log, /chore\(plan\): commit epic plan for widget-epic/);

    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(status.trim(), "", "working tree should be clean after commitPlan");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// pushPlan story (PAN-6747): unit-level git-mechanics tests, same style as commitPlan's above --
// throwaway temp repos + a throwaway bare repo standing in for a real remote.
function initRepoWithRemote(): { repo: string; remote: string } {
  const repo = initRepo();
  const remote = mkdtempSync(join(tmpdir(), "minerva-push-plan-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "dev", remote]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]);
  return { repo, remote };
}

test("pushPlan pushes the run/<runId> branch to origin when a remote is configured", () => {
  const { repo, remote } = initRepoWithRemote();
  try {
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "run/test-run-1"]);
    writeEpic(repo, "widget-epic");
    commitPlan(repo, "widget-epic");

    pushPlan(repo, "test-run-1");

    const remoteBranches = execFileSync("git", ["-C", remote, "branch", "--list", "run/test-run-1"], {
      encoding: "utf8",
    });
    assert.match(remoteBranches, /run\/test-run-1/);

    const localHead = execFileSync("git", ["-C", repo, "rev-parse", "run/test-run-1"], { encoding: "utf8" }).trim();
    const remoteHead = execFileSync("git", ["-C", remote, "rev-parse", "run/test-run-1"], {
      encoding: "utf8",
    }).trim();
    assert.equal(localHead, remoteHead, "expected origin's run/test-run-1 to match the local branch");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("pushPlan skips without throwing when no remote is configured", () => {
  const repo = initRepo();
  try {
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "run/test-run-2"]);
    writeEpic(repo, "widget-epic");
    commitPlan(repo, "widget-epic");

    assert.doesNotThrow(() => pushPlan(repo, "test-run-2"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pushPlan does not throw when the push itself fails (bad remote url)", () => {
  const repo = initRepo();
  try {
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      join(tmpdir(), "minerva-push-plan-nonexistent-remote"),
    ]);
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "run/test-run-3"]);
    writeEpic(repo, "widget-epic");
    commitPlan(repo, "widget-epic");

    assert.doesNotThrow(() => pushPlan(repo, "test-run-3"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commitPlan is idempotent -- re-running against an already-committed epic dir makes no duplicate commit", () => {
  const repo = initRepo();
  try {
    writeEpic(repo, "widget-epic");
    commitPlan(repo, "widget-epic");
    const afterFirst = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    commitPlan(repo, "widget-epic"); // re-run, e.g. a later checkAndMarkComplete poll
    const afterSecond = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    assert.equal(afterFirst, afterSecond, "expected no new commit on the second run");

    const commitCount = execFileSync("git", ["-C", repo, "rev-list", "--count", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(commitCount, "2"); // init commit + exactly one commitPlan commit
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commitPlan allowlists an epic dir blanket-ignored by the target repo's own .gitignore", () => {
  const repo = initRepo();
  try {
    writeFileSync(join(repo, ".gitignore"), ".pHive/epics/*\n");
    execFileSync("git", ["-C", repo, "add", "--", ".gitignore"], { stdio: "pipe" });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add blanket ignore"], { stdio: "pipe" });

    writeEpic(repo, "widget-epic");

    // Sanity: confirm the epic dir really is ignored before commitPlan touches it. Scoped to
    // the epic's own pathspec -- an unscoped whole-repo `git status` collapses an all-ignored
    // untracked directory to its topmost ancestor (".pHive/") instead of descending into it.
    const ignoredCheck = execFileSync(
      "git",
      ["-C", repo, "status", "--porcelain", "--ignored", "--", ".pHive/epics/widget-epic"],
      { encoding: "utf8" },
    );
    assert.match(ignoredCheck, /!! \.pHive\/epics\/widget-epic/);

    commitPlan(repo, "widget-epic");

    const gitignore = readFileSync(join(repo, ".gitignore"), "utf8");
    assert.match(gitignore, /^!\.pHive\/epics\/widget-epic\/$/m);

    const showFiles = execFileSync("git", ["-C", repo, "show", "--stat", "--oneline", "HEAD"], {
      encoding: "utf8",
    });
    assert.match(showFiles, /widget-epic\/epic\.yaml/);

    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
    assert.equal(status.trim(), "", "working tree should be clean after commitPlan");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
