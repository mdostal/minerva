// e2e-auto-resume.test.ts (minerva-auto-resume epic, e2e-verification story; rewritten to drop
// its former external-decision-service transport) -- drives runHeadlessPlan through a REAL
// `mode: "off"` park -> human-answers-via-submitAnswers -> resume-to-completion cycle. What this
// actually proves, independent of any transport: a headless plan run that parks on a genuine
// human gate (waiting_on_human) can be resumed with a real answer, injected into the resumed
// turn, and driven to completion -- the underlying pause/resume capability. See
// docs/architecture.md "No Autonomous Progress" and AD-2.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __setDriverForTest, submitAnswers } from "./kickoff-engine.ts";
import { runHeadlessPlan } from "./plan-runner.ts";
import { getRunStatus } from "./run-manager.ts";
import { getOutput } from "./output-emitter.ts";
import { createSeedRepo } from "./test-cli.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

let minervaHome: string;
let seedRepo: string;
let savedDriver: Driver;

// Turn 1: an unresolvable human-channel gate (mode "off" never auto-answers, so this always
// parks). Turn 2 (the resumed turn): asserts the human's answer arrived as the driven prompt,
// then completes the plan -- proving the resumed run actually executes using the answer, not
// just that state flipped.
class ParkThenUseAnswerDriver implements Driver {
  turns = 0;
  resumedPrompt: string | null = null;
  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.turns++;
    if (this.turns === 1) {
      return {
        session_id: "sess-1",
        raw_result: JSON.stringify({
          question: "What theme should the app default to?",
          suggested_channel: "human",
          confidence: 0.2,
          reason: "product decision, no safe default",
          kind: "free-text",
          options: null,
        }),
      };
    }
    this.resumedPrompt = input.prompt;
    const epicDir = join(input.cwd, ".pHive", "epics", "themed-app");
    mkdirSync(join(epicDir, "stories"), { recursive: true });
    writeFileSync(join(epicDir, "epic.yaml"), "id: themed-app\ntitle: Themed app\n");
    writeFileSync(
      join(epicDir, "stories", "apply-theme.yaml"),
      `id: apply-theme\ntitle: Apply theme: ${input.prompt}\ndepends_on: []\n`,
    );
    return {
      session_id: "sess-2",
      raw_result: JSON.stringify({ question: "(none)", suggested_channel: "human", confidence: 0, reason: "done" }),
    };
  }
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-e2e-auto-resume-"));
  seedRepo = createSeedRepo("minerva-seed-repo-e2e-auto-resume-");
  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_SEED_REPO = seedRepo;
  savedDriver = __setDriverForTest(new ParkThenUseAnswerDriver());
});

after(() => {
  __setDriverForTest(savedDriver);
  delete process.env.MINERVA_HOME;
  delete process.env.MINERVA_SEED_REPO;
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
});

test("real mode=off run: parks to waiting_on_human without silent failure, then resumes to completion once submitAnswers supplies the human's answer", async () => {
  const driver = new ParkThenUseAnswerDriver();
  __setDriverForTest(driver);

  const parked = await runHeadlessPlan({
    idea: "a themed note-taking app",
    mode: "off",
    ticketId: "e2e-verification-ticket",
  });

  // The plan must park, not fail silently or hang -- exactly one pending question, on the human
  // channel, with no epic produced yet.
  assert.equal(parked.status, "waiting_on_human", "the run must park on the unresolvable gate, not complete or error");
  assert.equal(parked.pending_questions.length, 1);
  const question = parked.pending_questions[0];
  assert.ok(question);
  assert.equal(question!.text, "What theme should the app default to?");
  assert.equal(question!.channel, "human");
  assert.equal(question!.status, "pending");
  assert.equal(parked.epic, null);
  assert.equal(getRunStatus({ run_id: parked.run_id }).status, "waiting_on_human");

  // Resume via the SAME provider-neutral path any caller (human UI, agent, CLI) uses --
  // submitAnswers -- no external decision-routing transport involved.
  await submitAnswers({
    run_id: parked.run_id,
    channel: "human",
    answers: [{ question_id: question!.id, answer: "solarized dark" }],
  });

  const after = getRunStatus({ run_id: parked.run_id }) as { status: string };
  assert.equal(after.status, "complete", "the run must resume to completion, not stay parked");
  assert.equal(driver.turns, 2, "the resumed turn must actually re-drive the plan engine");
  assert.equal(driver.resumedPrompt, "solarized dark", "the human's answer must be injected into the resumed turn");

  const output = getOutput({ run_id: parked.run_id }) as { epic: { epic_id: string } | null };
  assert.ok(output.epic);
  assert.equal(output.epic!.epic_id, "themed-app");
});
