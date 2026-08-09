// output-emitter.test.ts — output-emitter story (REQ-04)
// Spawns real bin/minerva.ts subprocesses, which spawn real `claude -p` subprocesses. Confirms
// completion is detected as a FILESYSTEM fact (an epic.yaml appearing under the workspace's
// .pHive/epics/, exactly what plugin-hive's real /plan skill writes as part of its own normal
// operation -- verified empirically that a headless driven session with bypassPermissions
// genuinely writes real files), not a self-reported "I'm done" signal in the schema-forced
// chat response.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call } from "./test-cli.ts";
import { findCompletedEpic, findCompletedEpics, ensureEpicNotGitIgnored, commitAndPushPlan, checkAndMarkComplete } from "./output-emitter.ts";
import { allocateRun, readRunRecord } from "./run-manager.ts";
import { parse as parseYaml } from "yaml";

let minervaHome: string;

const TEST_DRIVE_PROMPT =
  "You are running headlessly for idea '{idea}'. You need one piece of information from the " +
  "human operator: their favorite fruit. Ask exactly one clear question in your final " +
  "response, then stop and wait -- do not guess, do not proceed further this turn.";

function env() {
  return {
    MINERVA_HOME: minervaHome,
    MINERVA_DRIVE_MODEL: "claude-haiku-4-5-20251001",
    MINERVA_TEST_DRIVE_PROMPT: TEST_DRIVE_PROMPT,
  };
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-output-"));
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
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

// Real regression (2026-07-26): a live Minerva run against a real target_repo (Heimdall)
// whose `dev` branch already had 3 prior, already-shipped epics under .pHive/epics/ produced
// a genuinely NEW epic (hdl-routing) via the driven kickoff session, but findCompletedEpic's
// readdirSync-then-return-the-first-match logic had no concept of "pre-existing vs. newly
// written by this run" -- it alphabetically picked a stale, already-merged epic
// (hdl-actuation) inherited from the base branch and reported THAT as the run's output,
// completely ignoring the real new work sitting right next to it on disk. Fixed by having
// run-manager.ts snapshot the epic ids that already exist at workspace-allocation time
// (baseline_epic_ids on the RunRecord) and passing that snapshot into findCompletedEpic so
// only genuinely new epics are ever considered.
test("findCompletedEpic ignores an epic dir listed in baselineIds, proving the real hdl-routing/hdl-actuation regression is fixed", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-baseline-epic-"));

  // Pre-existing epic, inherited from the base branch (matches hdl-actuation's real shape in
  // the regression this test is named for) -- has a real epic.yaml + stories, so the OLD logic
  // would happily treat it as "this run's output".
  const preExistingDir = join(workspacePath, ".pHive", "epics", "pre-existing-epic");
  mkdirSync(join(preExistingDir, "stories"), { recursive: true });
  writeFileSync(join(preExistingDir, "epic.yaml"), "name: pre-existing-epic\n");
  writeFileSync(join(preExistingDir, "stories", "story-1.yaml"), "id: story-1\n");

  // Genuinely new epic, written by this run -- must be the one reported.
  const newDir = join(workspacePath, ".pHive", "epics", "new-epic");
  mkdirSync(join(newDir, "stories"), { recursive: true });
  writeFileSync(join(newDir, "epic.yaml"), "name: new-epic\n");
  writeFileSync(join(newDir, "stories", "story-1.yaml"), "id: story-1\n");

  const found = findCompletedEpic(workspacePath, new Set(["pre-existing-epic"]));
  assert.ok(found, "expected the genuinely new epic to be found");
  assert.equal(found?.epic_id, "new-epic");

  rmSync(workspacePath, { recursive: true, force: true });
});

test("findCompletedEpic with no baselineIds argument is unchanged from before this fix -- backward compatible default", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-no-baseline-"));
  const dir = join(workspacePath, ".pHive", "epics", "only-epic");
  mkdirSync(join(dir, "stories"), { recursive: true });
  writeFileSync(join(dir, "epic.yaml"), "name: only-epic\n");

  const found = findCompletedEpic(workspacePath);
  assert.ok(found);
  assert.equal(found?.epic_id, "only-epic");

  rmSync(workspacePath, { recursive: true, force: true });
});

function isIgnored(repo: string, relPath: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "check-ignore", "-q", relPath], { stdio: "pipe" });
    return true; // exit 0 == ignored
  } catch {
    return false; // exit 1 (or any non-zero) == not ignored
  }
}

// Real regression (2026-07-26): the same live Minerva run found its own newly-written
// hdl-routing epic dir was silently git-ignored the whole time -- the workspace's real
// .gitignore blanket-ignores .pHive/epics/* with a per-epic allowlist that plugin-hive's own
// /plan skill is supposed to add as part of its own step 0b, but that step apparently did not
// run in this headless/ForkedHiveDriver path. The epic sat untracked, invisible to `git
// status`, at real risk of being lost if the run's worktree were ever cleaned up. Fixed with a
// belt-and-suspenders repair Minerva itself performs before ever reporting a run complete,
// since Minerva is the one vouching for the artifact's existence via getOutput.
test("ensureEpicNotGitIgnored patches .gitignore to un-ignore a silently-ignored epic dir", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-gitignore-repair-"));
  execFileSync("git", ["init", "-q", workspacePath]);
  writeFileSync(join(workspacePath, ".gitignore"), ".pHive/epics/*\n");
  execFileSync("git", ["-C", workspacePath, "add", ".gitignore"]);
  execFileSync("git", [
    "-C", workspacePath,
    "-c", "user.email=test@example.com",
    "-c", "user.name=test",
    "commit", "-q", "-m", "init",
  ]);

  const epicDir = join(workspacePath, ".pHive", "epics", "new-epic");
  mkdirSync(epicDir, { recursive: true });
  writeFileSync(join(epicDir, "epic.yaml"), "name: new-epic\n");

  // Sanity check: confirm the bug is genuinely reproduced before the fix runs.
  assert.equal(isIgnored(workspacePath, ".pHive/epics/new-epic"), true, "sanity: epic dir must start out ignored");

  ensureEpicNotGitIgnored(workspacePath, "new-epic");

  assert.equal(isIgnored(workspacePath, ".pHive/epics/new-epic"), false, "epic dir must no longer be ignored after repair");
  const gitignoreContent = readFileSync(join(workspacePath, ".gitignore"), "utf8");
  assert.match(gitignoreContent, /!\.pHive\/epics\/new-epic\/\n!\.pHive\/epics\/new-epic\/\*\*/);

  rmSync(workspacePath, { recursive: true, force: true });
});

test("ensureEpicNotGitIgnored is a no-op when the epic dir is already trackable", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-gitignore-noop-"));
  execFileSync("git", ["init", "-q", workspacePath]);
  // No .gitignore at all -- nothing is ignored.
  const epicDir = join(workspacePath, ".pHive", "epics", "new-epic");
  mkdirSync(epicDir, { recursive: true });
  writeFileSync(join(epicDir, "epic.yaml"), "name: new-epic\n");

  assert.equal(isIgnored(workspacePath, ".pHive/epics/new-epic"), false);
  ensureEpicNotGitIgnored(workspacePath, "new-epic"); // must not throw, must not create a .gitignore unnecessarily
  assert.equal(isIgnored(workspacePath, ".pHive/epics/new-epic"), false);

  rmSync(workspacePath, { recursive: true, force: true });
});

// End-to-end version of the same regression, through the REAL API (startRun -> submitAnswers
// -> getOutput), not just the internal findCompletedEpic function -- proves baseline_epic_ids
// genuinely flows from allocateRun through the run record into completion detection for a real
// target_repo, matching the exact real-world shape of the Heimdall regression (a target_repo
// whose dev branch already has a shipped epic).
test("startRun against a target_repo with a pre-existing epic on dev correctly reports the NEW epic, not the pre-existing one", () => {
  const targetRepo = mkdtempSync(join(tmpdir(), "minerva-target-with-epic-"));
  execFileSync("git", ["init", "-q", "-b", "dev", targetRepo]);
  execFileSync("git", ["-C", targetRepo, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);

  // A real, already-shipped epic already committed on dev -- mirrors hdl-actuation's real shape.
  const preExistingDir = join(targetRepo, ".pHive", "epics", "already-shipped-epic");
  mkdirSync(join(preExistingDir, "stories"), { recursive: true });
  writeFileSync(join(preExistingDir, "epic.yaml"), "name: already-shipped-epic\ntitle: Already Shipped\n");
  writeFileSync(join(preExistingDir, "stories", "story-1.yaml"), "id: story-1\n");
  execFileSync("git", ["-C", targetRepo, "add", "."]);
  execFileSync("git", ["-C", targetRepo, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "add already-shipped-epic"]);

  const runId = call("startRun", { idea: "a genuinely new idea", target_repo: targetRepo }, env()).result.run_id;
  const q1 = call("getQuestions", { run_id: runId, channel: "human" }, env()).result.questions[0];

  const finishInstruction =
    "My answer: mango. Now use your Write tool to create the file " +
    ".pHive/epics/genuinely-new-epic/epic.yaml with this exact content:\n" +
    "name: genuinely-new-epic\ntitle: Genuinely New\nstories:\n  - id: story-1\n" +
    "Also create .pHive/epics/genuinely-new-epic/stories/story-1.yaml with this exact content:\n" +
    "id: story-1\ntitle: A new story\n" +
    "This completes the plan -- there is nothing further to ask. Still answer the required " +
    "schema fields with any placeholder text since the schema requires them.";

  call("submitAnswers", { run_id: runId, channel: "human", answers: [{ question_id: q1.id, answer: finishInstruction }] }, env());

  const output = call("getOutput", { run_id: runId }, env());
  assert.equal(output.status, 0);
  assert.equal(
    output.result.epic.epic_id,
    "genuinely-new-epic",
    "must report the genuinely new epic, not the pre-existing already-shipped-epic inherited from dev",
  );

  rmSync(targetRepo, { recursive: true, force: true });
});

// Real regression (2026-07-27): plugin-hive's real headless /plan run for the Votum seed wrote its
// epics in the FLAT layout -- `.pHive/epics/NN-name.yaml`, one file per epic with an embedded
// `stories:` list -- not the NESTED `<id>/epic.yaml` + `stories/*.yaml` the detector understood.
// findCompletedEpic returned null, the run was never marked complete, and its 34 stories were never
// auto-filed to Multica. These tests pin the FLAT layout (matching the exact on-disk shape of
// ~/.minerva/runs/8f88cba8.../workspace/.pHive/epics/0N-*.yaml).
const FLAT_EPIC_1 =
  "id: domain-model-store\n" +
  "title: Domain Model & Append-Only Store\n" +
  "status: planned\n" +
  "stories:\n" +
  "  - title: \"Define domain model types\"\n" +
  "    id: domain-types\n" +
  "    points: 3\n" +
  "  - title: \"Implement append-only decision store\"\n" +
  "    id: append-only-store\n" +
  "    points: 5\n";
const FLAT_EPIC_2 =
  "id: quorum-engine-rules\n" +
  "title: Quorum & Rule Engine\n" +
  "stories:\n" +
  "  - title: \"Majority rule\"\n" +
  "    id: majority-rule\n" +
  "  - title: \"Supermajority rule\"\n" +
  "    id: supermajority-rule\n" +
  "  - title: \"Quorum floor\"\n" +
  "    id: quorum-floor\n";

test("findCompletedEpics detects a FLAT epic file (.pHive/epics/NN-name.yaml) with embedded stories", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-flat-single-"));
  const epicsDir = join(workspacePath, ".pHive", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(join(epicsDir, "01-domain-model-store.yaml"), FLAT_EPIC_1);

  const epics = findCompletedEpics(workspacePath);
  assert.equal(epics.length, 1, "expected the single flat epic to be detected");
  const e = epics[0]!;
  // epic_id is the file's own `id:` field, not the NN-prefixed file name.
  assert.equal(e.epic_id, "domain-model-store");
  assert.equal(e.entry_name, "01-domain-model-store.yaml");
  assert.equal(e.layout, "flat");
  assert.equal(e.stories.length, 2, "both embedded stories must be extracted");
  assert.equal(e.stories[0]!.id, "domain-types");
  // Each embedded story is re-serialized to standalone YAML so its title is parseable downstream.
  const parsed0 = parseYaml(e.stories[0]!.content) as { title?: string };
  assert.equal(parsed0.title, "Define domain model types");

  // Backward-compat singular accessor returns the same first epic.
  assert.equal(findCompletedEpic(workspacePath)?.epic_id, "domain-model-store");

  rmSync(workspacePath, { recursive: true, force: true });
});

test("findCompletedEpics returns ALL epics of a MULTI-epic flat plan (the 7-epic/34-story reality)", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-flat-multi-"));
  const epicsDir = join(workspacePath, ".pHive", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(join(epicsDir, "01-domain-model-store.yaml"), FLAT_EPIC_1);
  writeFileSync(join(epicsDir, "02-quorum-engine-rules.yaml"), FLAT_EPIC_2);

  const epics = findCompletedEpics(workspacePath);
  assert.equal(epics.length, 2, "a multi-epic plan must yield every epic, not just the first");
  // Numeric-prefixed files sort deterministically: epic 01 first, epic 02 second.
  assert.deepEqual(epics.map((e) => e.epic_id), ["domain-model-store", "quorum-engine-rules"]);
  const totalStories = epics.reduce((n, e) => n + e.stories.length, 0);
  assert.equal(totalStories, 5, "all 2 + 3 embedded stories across both epics must be present");

  // findCompletedEpic (singular) still returns just the first, for legacy callers.
  assert.equal(findCompletedEpic(workspacePath)?.epic_id, "domain-model-store");

  rmSync(workspacePath, { recursive: true, force: true });
});

test("findCompletedEpics mixes FLAT and NESTED epics in one workspace and returns all of them", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-flat-nested-mix-"));
  const epicsDir = join(workspacePath, ".pHive", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(join(epicsDir, "01-domain-model-store.yaml"), FLAT_EPIC_1); // flat
  const nestedDir = join(epicsDir, "legacy-nested");
  mkdirSync(join(nestedDir, "stories"), { recursive: true });
  writeFileSync(join(nestedDir, "epic.yaml"), "name: legacy-nested\n");
  writeFileSync(join(nestedDir, "stories", "s1.yaml"), "id: s1\ntitle: Legacy story\n");

  const epics = findCompletedEpics(workspacePath);
  assert.equal(epics.length, 2);
  const byId = Object.fromEntries(epics.map((e) => [e.epic_id, e]));
  assert.equal(byId["domain-model-store"]!.layout, "flat");
  assert.equal(byId["legacy-nested"]!.layout, "nested");

  rmSync(workspacePath, { recursive: true, force: true });
});

test("findCompletedEpics excludes a FLAT epic whose file name is in baselineIds (inherited, not this run's)", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-flat-baseline-"));
  const epicsDir = join(workspacePath, ".pHive", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(join(epicsDir, "00-pre-existing.yaml"), "id: pre-existing\nstories:\n  - id: x\n    title: X\n");
  writeFileSync(join(epicsDir, "01-domain-model-store.yaml"), FLAT_EPIC_1);

  // baseline keys off the readdirSync entry name (the NN-name.yaml file), exactly as run-manager
  // snapshots it -- so the pre-existing flat epic is skipped and only the new one is returned.
  const epics = findCompletedEpics(workspacePath, new Set(["00-pre-existing.yaml"]));
  assert.equal(epics.length, 1);
  assert.equal(epics[0]!.epic_id, "domain-model-store");

  rmSync(workspacePath, { recursive: true, force: true });
});

test("findCompletedEpics ignores a stray non-epic .yaml under .pHive/epics/ (never false-completes)", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-flat-stray-"));
  const epicsDir = join(workspacePath, ".pHive", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(join(epicsDir, "README.yaml"), "just: some\nunrelated: data\n"); // no stories/id/title
  assert.equal(findCompletedEpics(workspacePath).length, 0);
  rmSync(workspacePath, { recursive: true, force: true });
});

test("ensureEpicNotGitIgnored patches .gitignore for a FLAT epic FILE (single-file allowlist, not a dir subtree)", () => {
  const workspacePath = mkdtempSync(join(tmpdir(), "minerva-flat-gitignore-"));
  execFileSync("git", ["init", "-q", workspacePath]);
  writeFileSync(join(workspacePath, ".gitignore"), ".pHive/epics/*\n");
  execFileSync("git", ["-C", workspacePath, "add", ".gitignore"]);
  execFileSync("git", [
    "-C", workspacePath,
    "-c", "user.email=test@example.com",
    "-c", "user.name=test",
    "commit", "-q", "-m", "init",
  ]);

  const epicsDir = join(workspacePath, ".pHive", "epics");
  mkdirSync(epicsDir, { recursive: true });
  writeFileSync(join(epicsDir, "01-domain-model-store.yaml"), FLAT_EPIC_1);

  assert.equal(isIgnored(workspacePath, ".pHive/epics/01-domain-model-store.yaml"), true, "sanity: flat epic file must start ignored");
  ensureEpicNotGitIgnored(workspacePath, "01-domain-model-store.yaml", "flat");
  assert.equal(isIgnored(workspacePath, ".pHive/epics/01-domain-model-store.yaml"), false, "flat epic file must no longer be ignored after repair");

  const gitignoreContent = readFileSync(join(workspacePath, ".gitignore"), "utf8");
  assert.match(gitignoreContent, /!\.pHive\/epics\/01-domain-model-store\.yaml/);
  // Must NOT add a directory-subtree allowlist for a flat file.
  assert.doesNotMatch(gitignoreContent, /01-domain-model-store\.yaml\/\*\*/);

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

// ---------------------------------------------------------------------------------------------
// PAN-6745 (autonomy unlock): auto-commit + push of the finished plan into the target repo.
// The previously-MANUAL "commit the plan to a real repo by hand" step -- the single seam where
// headless autonomy broke -- is now automated. These tests drive the git code path DIRECTLY (no
// real `claude -p` driver): they fabricate the exact on-disk workspace shape a completed /plan run
// produces, and assert the plan actually lands in a real remote a build agent could check out.
// ---------------------------------------------------------------------------------------------

const FLAT_EPIC_FOR_PUSH =
  "id: greenfield-epic\n" +
  "title: Greenfield Epic\n" +
  "stories:\n" +
  "  - title: \"First greenfield story\"\n" +
  "    id: gf-1\n";

// Build a target repo with a `dev` branch and an `origin` pointing at a local bare repo (stands in
// for GitHub -- push semantics are identical, no network). Returns both paths for cleanup.
function makeRepoWithRemote(): { repo: string; bare: string } {
  const bare = mkdtempSync(join(tmpdir(), "minerva-bare-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "dev", bare]);
  const repo = mkdtempSync(join(tmpdir(), "minerva-target-remote-"));
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", bare]);
  execFileSync("git", ["-C", repo, "push", "-q", "origin", "dev"]);
  return { repo, bare };
}

// True if the bare remote has `branch` and its tip commit message contains `needle`.
function remoteHasCommit(bare: string, branch: string, needle: string): boolean {
  try {
    const msg = execFileSync("git", ["-C", bare, "log", "-1", "--format=%s", branch], { encoding: "utf8" });
    return msg.includes(needle);
  } catch {
    return false;
  }
}

test("commitAndPushPlan commits the plan and pushes the run-scoped branch to origin (the manual step, automated)", () => {
  const { repo, bare } = makeRepoWithRemote();
  const runId = "test-run-commit-push";
  const workspace = mkdtempSync(join(tmpdir(), "minerva-ws-push-"));
  rmSync(workspace, { recursive: true, force: true }); // worktree add needs the path absent
  try {
    // The real worktree the run path cuts: a run/<id> branch off dev, sharing the repo's origin.
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `run/${runId}`, workspace, "dev"]);

    const epicsDir = join(workspace, ".pHive", "epics");
    mkdirSync(epicsDir, { recursive: true });
    writeFileSync(join(epicsDir, "01-greenfield-epic.yaml"), FLAT_EPIC_FOR_PUSH);

    const epics = findCompletedEpics(workspace);
    assert.equal(epics.length, 1, "sanity: the fabricated flat epic must be detected");

    const res = commitAndPushPlan({ run_id: runId, workspace_path: workspace, workspace_kind: "worktree" }, epics);
    assert.equal(res.committed, true, res.reason);
    assert.equal(res.pushed, true, res.reason);
    assert.equal(res.branch, `run/${runId}`);
    assert.ok(remoteHasCommit(bare, `run/${runId}`, `plan(${runId})`), "the bare remote must have the plan commit on run/<id>");
  } finally {
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", workspace], { stdio: "pipe" });
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("commitAndPushPlan is a clean no-op the second time (idempotent, no empty commit)", () => {
  const { repo, bare } = makeRepoWithRemote();
  const runId = "test-run-idempotent";
  const workspace = mkdtempSync(join(tmpdir(), "minerva-ws-idem-"));
  rmSync(workspace, { recursive: true, force: true });
  try {
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", `run/${runId}`, workspace, "dev"]);
    const epicsDir = join(workspace, ".pHive", "epics");
    mkdirSync(epicsDir, { recursive: true });
    writeFileSync(join(epicsDir, "01-greenfield-epic.yaml"), FLAT_EPIC_FOR_PUSH);
    const epics = findCompletedEpics(workspace);

    const first = commitAndPushPlan({ run_id: runId, workspace_path: workspace, workspace_kind: "worktree" }, epics);
    assert.equal(first.committed, true, first.reason);

    // Second call: nothing new staged -> must NOT create an empty commit, must report the no-op.
    const second = commitAndPushPlan({ run_id: runId, workspace_path: workspace, workspace_kind: "worktree" }, epics);
    assert.equal(second.committed, false);
    assert.equal(second.pushed, false);
    assert.match(second.reason, /nothing to commit/);
  } finally {
    execFileSync("git", ["-C", repo, "worktree", "remove", "--force", workspace], { stdio: "pipe" });
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("commitAndPushPlan skips a fresh_init workspace (no remote to push to)", () => {
  const res = commitAndPushPlan(
    { run_id: "x", workspace_path: "/nonexistent-should-not-be-touched", workspace_kind: "fresh_init" },
    [],
  );
  assert.equal(res.committed, false);
  assert.equal(res.pushed, false);
  assert.match(res.reason, /fresh_init/);
});

// End-to-end through the REAL run path (allocateRun -> checkAndMarkComplete), minus only the LLM
// driver: proves a run against a resolved real repo lands its plan committed+pushed on origin. This
// is the greenfield-seed-resolves-to-a-real-repo scenario -- the worktree workspace is exactly what
// resolveTargetRepo now produces for greenfield seeds (incubator repo) instead of fresh_init.
test("checkAndMarkComplete auto-commits+pushes the plan for a worktree run (greenfield -> real repo, end to end)", () => {
  const { repo, bare } = makeRepoWithRemote();
  const home = mkdtempSync(join(tmpdir(), "minerva-home-e2e-push-"));
  const savedHome = process.env.MINERVA_HOME;
  process.env.MINERVA_HOME = home;
  try {
    // allocateRun with a real target repo takes the worktree path (workspace_kind: "worktree") --
    // no driver, no claude call. This is the same allocation resolveTargetRepo now forces for
    // greenfield seeds via the incubator fallback.
    const { run_id: runId } = allocateRun("a greenfield idea", repo, undefined, "incubator");
    const rec = readRunRecord(runId);
    assert.equal(rec.workspace_kind, "worktree", "a resolved repo must take the worktree path, NOT fresh_init");
    assert.equal(rec.target_repo, repo, "the resolved target repo must be persisted on the record");

    // Simulate plugin-hive's /plan writing its flat epic artifact into the workspace.
    const epicsDir = join(rec.workspace_path, ".pHive", "epics");
    mkdirSync(epicsDir, { recursive: true });
    writeFileSync(join(epicsDir, "01-greenfield-epic.yaml"), FLAT_EPIC_FOR_PUSH);

    const complete = checkAndMarkComplete(runId);
    assert.equal(complete, true, "the flat epic must be detected as completion");

    const after = readRunRecord(runId);
    assert.equal(after.status, "complete");
    const push = after.plan_push as { committed: boolean; pushed: boolean; branch: string | null };
    assert.equal(push.committed, true, "the plan must be committed on completion");
    assert.equal(push.pushed, true, "the plan must be pushed to origin on completion");
    assert.ok(
      remoteHasCommit(bare, `run/${runId}`, `plan(${runId})`),
      "the greenfield plan must land in the real remote a build agent checks out",
    );
  } finally {
    if (savedHome === undefined) delete process.env.MINERVA_HOME;
    else process.env.MINERVA_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});
