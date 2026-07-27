// plan-runner.test.ts — the Auriga-facing headless-plan orchestration (prebaked-plan-defaults
// epic, integration slice). Fake-driver driven, no `claude` and no `multica` process. Proves the
// "plan this idea -> epic+stories" entry drives to completion unattended and hands back the
// decomposed stories a router would file.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __setDriverForTest } from "./kickoff-engine.ts";
import { runHeadlessPlan, storyToIssueFields } from "./plan-runner.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

let minervaHome: string;
let savedDriver: Driver;

// Emits N agent-channel single-select gates, then writes a real epic.yaml + two stories.
class PlanScriptedDriver implements Driver {
  turns = 0;
  constructor(private readonly gates: number) {}
  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.turns++;
    if (this.turns > this.gates) {
      const epicDir = join(input.cwd, ".pHive", "epics", "planned-epic");
      mkdirSync(join(epicDir, "stories"), { recursive: true });
      writeFileSync(join(epicDir, "epic.yaml"), "id: planned-epic\ntitle: Planned epic\n");
      writeFileSync(join(epicDir, "stories", "s1.yaml"), "id: s1\ntitle: First story\ndepends_on: []\n");
      writeFileSync(join(epicDir, "stories", "s2.yaml"), "id: s2\ntitle: Second story\ndepends_on: [s1]\n");
      return { session_id: "sess", raw_result: JSON.stringify({ question: "(none)", suggested_channel: "human", confidence: 0, reason: "done" }) };
    }
    return {
      session_id: "sess",
      raw_result: JSON.stringify({
        question: `Pick for gate ${this.turns}`,
        suggested_channel: "agent",
        confidence: 0.9,
        reason: "routine",
        kind: "single-select",
        options: ["Recommended: A", "B"],
        qid: `gate-${this.turns}`,
      }),
    };
  }
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-planrunner-"));
  process.env.MINERVA_HOME = minervaHome;
  savedDriver = __setDriverForTest(new PlanScriptedDriver(0));
});

after(() => {
  __setDriverForTest(savedDriver);
  rmSync(minervaHome, { recursive: true, force: true });
});

test("runHeadlessPlan: auto mode drives an idea to a complete epic+stories, unattended", async () => {
  __setDriverForTest(new PlanScriptedDriver(2));
  const result = await runHeadlessPlan({ idea: "a small analytics dashboard", mode: "auto" });

  assert.equal(result.status, "complete");
  assert.ok(result.epic);
  assert.equal(result.epic!.epic_id, "planned-epic");
  assert.equal(result.epic!.stories.length, 2);
  assert.equal(result.pending_questions.length, 0);
});

test("runHeadlessPlan: parks (status waiting_on_human, epic null) when a gate has no default", async () => {
  // A human-channel gate + agent mode => parks. Never completes, but must not hang.
  class HumanGate implements Driver {
    async runTurn(): Promise<DriverResult> {
      return {
        session_id: "sess",
        raw_result: JSON.stringify({ question: "Core strategy?", suggested_channel: "human", confidence: 0.1, reason: "strategic", kind: "free-text", options: null }),
      };
    }
  }
  __setDriverForTest(new HumanGate());
  const result = await runHeadlessPlan({ idea: "a marketplace", mode: "agent" });

  assert.equal(result.status, "waiting_on_human");
  assert.equal(result.epic, null);
  assert.equal(result.pending_questions.length, 1);
});

test("storyToIssueFields: derives title from story YAML, keeps full content as description", () => {
  const f = storyToIssueFields({ id: "s1", content: "id: s1\ntitle: Build the API\n" });
  assert.equal(f.title, "[s1] Build the API");
  assert.match(f.description, /Build the API/);
});

test("storyToIssueFields: falls back to the story id when YAML has no title", () => {
  const f = storyToIssueFields({ id: "s9", content: "not: really\n" });
  assert.equal(f.title, "[s9] s9");
});
