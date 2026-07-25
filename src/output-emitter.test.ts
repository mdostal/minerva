// output-emitter.test.ts — output-emitter story (REQ-04)
// Spawns real bin/minerva.ts subprocesses, which spawn real `claude -p` subprocesses. Confirms
// completion is detected as a FILESYSTEM fact (an epic.yaml appearing under the workspace's
// .pHive/epics/, exactly what plugin-hive's real /plan skill writes as part of its own normal
// operation -- verified empirically that a headless driven session with bypassPermissions
// genuinely writes real files), not a self-reported "I'm done" signal in the schema-forced
// chat response.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { call } from "./test-cli.ts";

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

test("getOutput validation: missing run_id returns VALIDATION_FAILED; unknown run_id returns NOT_FOUND", () => {
  const noId = call("getOutput", {}, env());
  assert.equal(noId.status, 1);
  assert.equal(noId.error.code, "VALIDATION_FAILED");

  const unknown = call("getOutput", { run_id: "00000000-0000-0000-0000-000000000000" }, env());
  assert.equal(unknown.status, 1);
  assert.equal(unknown.error.code, "NOT_FOUND");
});
