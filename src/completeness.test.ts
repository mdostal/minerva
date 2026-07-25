// completeness.test.ts — completeness-pass story
// Exercises the PRD's own anchored success metric directly (>=3 concurrent runs, zero
// hand-run commands per idea) rather than leaving it as an inference from individual stories'
// tests, plus listRuns accuracy across a real mix of run states.
//
// Error-enum coverage audit (per this story's acceptance criteria -- each of the 5 closed
// codes already has an explicit, dedicated assertion elsewhere in the suite; this is a record
// of that audit, not a duplication of the tests):
//   NOT_FOUND         -- run-manager.test.ts, kickoff-engine.test.ts, output-emitter.test.ts,
//                         cleanup-ledger.test.ts
//   VALIDATION_FAILED -- bin/minerva.test.ts, run-manager.test.ts, kickoff-engine.test.ts,
//                         output-emitter.test.ts, cleanup-ledger.test.ts
//   WRONG_CHANNEL     -- kickoff-engine.test.ts
//   NOT_READY         -- output-emitter.test.ts
//   UNKNOWN_METHOD    -- bin/minerva.test.ts

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-completeness-"));
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
});

test("PRD anchored success metric: >=3 ideas in flight concurrently, each progressing idea->spec independently, zero hand-run commands per idea", () => {
  // "Zero hand-run commands per idea" is proven structurally: every step below goes through
  // bin/minerva's CLI boundary only (startRun / getQuestions / submitAnswers / getOutput) --
  // nothing here shells out to git/claude directly the way a human operator would.
  const ideas = ["a podcast player", "a workout logger", "a plant watering reminder"];
  const runIds = ideas.map((idea) => call("startRun", { idea }, env()).result.run_id);
  assert.equal(new Set(runIds).size, 3); // three genuinely distinct runs

  // Drive all three to completion, each writing its own distinctly-named epic, interleaved
  // (not fully sequential-and-isolated) to actually exercise concurrent-in-flight state.
  const questions = runIds.map((runId) => call("getQuestions", { run_id: runId, channel: "human" }, env()).result.questions[0]);

  runIds.forEach((runId, i) => {
    const epicId = `concurrent-epic-${i}`;
    const finishInstruction =
      `My answer: mango. Now use your Write tool to create the file ` +
      `.pHive/epics/${epicId}/epic.yaml with content 'name: ${epicId}\\ntitle: Epic ${i}\\n'. ` +
      `This completes the plan. Still answer the required schema fields with any placeholder text.`;
    const result = call(
      "submitAnswers",
      { run_id: runId, channel: "human", answers: [{ question_id: questions[i].id, answer: finishInstruction }] },
      env(),
    );
    assert.equal(result.status, 0);
  });

  // Confirm no cross-run interference: each run completed with ITS OWN distinct epic, not
  // another run's.
  runIds.forEach((runId, i) => {
    const status = call("getRunStatus", { run_id: runId }, env());
    assert.equal(status.result.status, "complete");
    const output = call("getOutput", { run_id: runId }, env());
    assert.equal(output.result.epic.epic_id, `concurrent-epic-${i}`);
  });

  // listRuns reflects all three, independently, correctly.
  const listed = call("listRuns", {}, env()).result.runs;
  for (const runId of runIds) {
    const entry = listed.find((r: any) => r.run_id === runId);
    assert.ok(entry);
    assert.equal(entry.status, "complete");
  }
});

test("listRuns is accurate across a real mix of run states (waiting_on_human, complete, aborted)", () => {
  const waitingRunId = call("startRun", { idea: "a habit streak tracker" }, env()).result.run_id;

  const completeRunId = call("startRun", { idea: "a grocery list app" }, env()).result.run_id;
  const q = call("getQuestions", { run_id: completeRunId, channel: "human" }, env()).result.questions[0];
  call(
    "submitAnswers",
    {
      run_id: completeRunId,
      channel: "human",
      answers: [
        {
          question_id: q.id,
          answer:
            "My answer: mango. Write .pHive/epics/grocery-epic/epic.yaml with 'name: grocery-epic\\n'. Done -- still answer the schema fields with placeholders.",
        },
      ],
    },
    env(),
  );

  const abortedRunId = call("startRun", { idea: "a flashcard app" }, env()).result.run_id;
  call("abortRun", { run_id: abortedRunId }, env());

  const listed = call("listRuns", {}, env()).result.runs;
  const byId = Object.fromEntries(listed.map((r: any) => [r.run_id, r.status]));

  assert.equal(byId[waitingRunId], "waiting_on_human");
  assert.equal(byId[completeRunId], "complete");
  assert.equal(byId[abortedRunId], "aborted");
});
