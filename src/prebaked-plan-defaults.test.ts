// prebaked-plan-defaults.test.ts — integration test for the auto-answer LOOP (prebaked-plan-
// defaults epic), driven by a scripted fake Driver instead of a real `claude` process. This is
// the direct proof that a fresh headless run drives itself to completion (or a genuine human
// gate) without hanging -- deterministic, fast, no live API.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRun, getQuestions, __setDriverForTest } from "./kickoff-engine.ts";
import { getRunStatus, readRunRecord } from "./run-manager.ts";
import { getOutput } from "./output-emitter.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

let minervaHome: string;
let savedDriver: Driver;

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-prebaked-"));
  process.env.MINERVA_HOME = minervaHome;
});

after(() => {
  __setDriverForTest(savedDriver);
  rmSync(minervaHome, { recursive: true, force: true });
});

// A scripted driver that emits N single-select agent-channel questions, then (on the completing
// turn) writes a real epic.yaml + a story into the workspace -- exactly the filesystem fact
// checkAndMarkComplete() detects as "the run finished". No live API, fully deterministic.
class ScriptedDriver implements Driver {
  turns = 0;
  constructor(
    private readonly questionsBeforeDone: number,
    private readonly makeResult: (turn: number) => object,
  ) {}
  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.turns++;
    if (this.turns > this.questionsBeforeDone) {
      const epicDir = join(input.cwd, ".pHive", "epics", "demo");
      mkdirSync(join(epicDir, "stories"), { recursive: true });
      writeFileSync(join(epicDir, "epic.yaml"), "id: demo\ntitle: Demo epic\n");
      writeFileSync(join(epicDir, "stories", "s1.yaml"), "id: s1\ntitle: first story\n");
      return {
        session_id: "sess",
        raw_result: JSON.stringify({ question: "(none)", suggested_channel: "human", confidence: 0, reason: "done" }),
      };
    }
    return { session_id: "sess", raw_result: JSON.stringify(this.makeResult(this.turns)) };
  }
}

function singleSelectAgentQuestion(turn: number): object {
  return {
    question: `Pick an option for gate ${turn}`,
    suggested_channel: "agent",
    confidence: 0.9,
    reason: "routine mechanical gate",
    kind: "single-select",
    options: ["Recommended: option A", "option B"],
    qid: `gate-${turn}`,
  };
}

function humanStrategicQuestion(): object {
  return {
    question: "What is the core product strategy?",
    suggested_channel: "human",
    confidence: 0.2,
    reason: "strategic, ambiguous",
    kind: "free-text",
    options: null,
    qid: "strategy",
  };
}

function unmatchedAgentQuestion(): object {
  return {
    question: "Which proprietary deployment target should this use?",
    suggested_channel: "agent",
    confidence: 0.75,
    reason: "initially considered agent-routine",
    kind: "free-text",
    options: null,
    qid: "deployment_target",
  };
}

beforeEach(() => {
  // Capture whatever driver is currently installed the first time, so `after` can restore it.
  savedDriver = savedDriver ?? __setDriverForTest(new ScriptedDriver(0, () => ({})));
});

test("agent mode: a fresh run auto-answers routine gates and drives to completion without hanging", async () => {
  __setDriverForTest(new ScriptedDriver(3, singleSelectAgentQuestion));
  const { run_id } = (await startRun({ idea: "a tiny CLI todo app", defaults: { mode: "agent" } })) as {
    run_id: string;
  };

  // The run must NOT be parked -- it drove itself to completion.
  assert.equal((getRunStatus({ run_id }) as { status: string }).status, "complete");
  assert.equal(readRunRecord(run_id).metrics?.auto_resolutions, 3);

  const out = getOutput({ run_id }) as { epic: { epic_id: string; stories: unknown[] } };
  assert.equal(out.epic.epic_id, "demo");
  assert.equal(out.epic.stories.length, 1);
});

test("mode off (default): a fresh run still parks on the first gate (backwards-compatible)", async () => {
  const driver = new ScriptedDriver(3, singleSelectAgentQuestion);
  __setDriverForTest(driver);
  const { run_id } = (await startRun({ idea: "a note app" })) as { run_id: string };

  assert.equal((getRunStatus({ run_id }) as { status: string }).status, "waiting_on_human");
  assert.equal(driver.turns, 1); // only the initial drive turn ran -- no auto-answering
});

test("agent mode: parks on a genuine human strategic gate (AD-5 preserved), does not loop forever", async () => {
  const driver = new ScriptedDriver(3, humanStrategicQuestion);
  __setDriverForTest(driver);
  const { run_id } = (await startRun({ idea: "a marketplace", defaults: { mode: "agent" } })) as { run_id: string };

  assert.equal((getRunStatus({ run_id }) as { status: string }).status, "waiting_on_human");
  assert.equal(driver.turns, 1); // stopped at the human gate, no auto-answer attempted past it
});

test("agent mode: an agent-channel question without a matching default is escalated to human", async () => {
  const driver = new ScriptedDriver(3, unmatchedAgentQuestion);
  __setDriverForTest(driver);
  const { run_id } = (await startRun({
    idea: "a deployment planner",
    defaults: { mode: "agent", free_text_default: null },
  })) as { run_id: string };

  assert.equal((getRunStatus({ run_id }) as { status: string }).status, "waiting_on_human");
  assert.equal(driver.turns, 1);
  assert.equal((getQuestions({ run_id, channel: "agent" }) as { questions: unknown[] }).questions.length, 0);

  const human = getQuestions({ run_id, channel: "human" }) as { questions: Array<{ channel: string; suggested_channel: string; qid: string }> };
  assert.equal(human.questions.length, 1);
  assert.equal(human.questions[0]!.channel, "human");
  assert.equal(human.questions[0]!.suggested_channel, "agent");
  assert.equal(human.questions[0]!.qid, "deployment_target");
  assert.equal(readRunRecord(run_id).metrics?.auto_resolutions, 0);
});

test("agent mode: a human-channel question ignores matching defaults and remains human-visible", async () => {
  const driver = new ScriptedDriver(2, humanStrategicQuestion);
  __setDriverForTest(driver);
  const { run_id } = (await startRun({
    idea: "a marketplace",
    defaults: { mode: "agent", answers: [{ qid: "strategy", answer: "choose B2B" }] },
  })) as { run_id: string };

  assert.equal((getRunStatus({ run_id }) as { status: string }).status, "waiting_on_human");
  assert.equal(driver.turns, 1);
  assert.equal((getQuestions({ run_id, channel: "agent" }) as { questions: unknown[] }).questions.length, 0);

  const human = getQuestions({ run_id, channel: "human" }) as { questions: Array<{ channel: string; qid: string }> };
  assert.equal(human.questions.length, 1);
  assert.equal(human.questions[0]!.channel, "human");
  assert.equal(human.questions[0]!.qid, "strategy");
  assert.equal(readRunRecord(run_id).metrics?.auto_resolutions, 0);
});

test("auto mode: answers even the human-channel gate (via free-text default) and completes", async () => {
  __setDriverForTest(new ScriptedDriver(2, humanStrategicQuestion));
  const { run_id } = (await startRun({ idea: "a marketplace", defaults: { mode: "auto" } })) as { run_id: string };

  assert.equal((getRunStatus({ run_id }) as { status: string }).status, "complete");
});

test("max_auto_answers guardrail stops the loop instead of spinning forever", async () => {
  // Never completes (questionsBeforeDone huge), so only the guardrail can stop it.
  const driver = new ScriptedDriver(9999, singleSelectAgentQuestion);
  __setDriverForTest(driver);
  const { run_id } = (await startRun({
    idea: "an endless idea",
    defaults: { mode: "agent", max_auto_answers: 3 },
  })) as { run_id: string };

  // 1 initial drive + 3 auto-answers = 4 turns, then the guardrail trips and the run parks.
  assert.equal((getRunStatus({ run_id }) as { status: string }).status, "waiting_on_human");
  assert.equal(driver.turns, 4);
});
