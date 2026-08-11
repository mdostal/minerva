import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRun, getQuestions, submitAnswers, __setDriverForTest } from "../../src/kickoff-engine.ts";
import { getOutput } from "../../src/output-emitter.ts";
import { readRunRecord } from "../../src/run-manager.ts";
import { encodeEnvelopePointer, type Driver, type DriverInput, type DriverResult } from "../../src/driver.ts";

function createTargetRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "minerva-e2e-target-"));
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "target init"]);
  return repo;
}

class ScriptedForkedDriver implements Driver {
  readonly events: string[] = [];
  private pointer: string | null = null;

  async runTurn(input: DriverInput): Promise<DriverResult> {
    if (input.sessionId === null) {
      this.events.push("route:initial-task");
      assert.match(input.prompt, /route this simulated external task through forked execution/);

      const envelopePath = join(input.cwd, ".pHive", "questions", "forked-e2e.yaml");
      mkdirSync(join(input.cwd, ".pHive", "questions"), { recursive: true });
      writeFileSync(
        envelopePath,
        [
          "id: forked-e2e.yaml",
          "skill: plan",
          "phase: e2e",
          "status: pending",
          "questions:",
          "  - qid: execution_mode",
          "    text: Should Minerva use forked execution for this simulated external task?",
          "    kind: single-select",
          '    options: ["yes", "no"]',
          "    required: true",
          "    answer: null",
          "",
        ].join("\n"),
      );
      this.pointer = encodeEnvelopePointer({
        envelopePath,
        qid: "execution_mode",
        skillPrompt: input.prompt,
      });
      this.events.push("forked:surface-question");

      return {
        session_id: this.pointer,
        raw_result: JSON.stringify({
          question: "Should Minerva use forked execution for this simulated external task?",
          suggested_channel: "human",
          confidence: 0.94,
          reason: "forked driver surfaced the structured envelope gate",
          kind: "single-select",
          options: ["yes", "no"],
          qid: "execution_mode",
        }),
      };
    }

    this.events.push("route:answer");
    assert.equal(input.sessionId, this.pointer);
    assert.equal(input.prompt, "yes");

    const epicDir = join(input.cwd, ".pHive", "epics", "e2e-forked-flow");
    mkdirSync(join(epicDir, "stories"), { recursive: true });
    writeFileSync(
      join(epicDir, "epic.yaml"),
      [
        "name: e2e-forked-flow",
        "title: E2E Forked Flow",
        "status: planned",
        "stories:",
        "  - id: forked-route-and-telemetry",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(epicDir, "stories", "forked-route-and-telemetry.yaml"),
      [
        "id: forked-route-and-telemetry",
        "title: Verify forked routing and telemetry aggregation",
        "status: planned",
        "",
      ].join("\n"),
    );
    this.events.push("forked:aggregate-output");

    return {
      session_id: "forked-hive-driver:no-pending-envelope",
      raw_result: JSON.stringify({
        question: "(no pending question -- run may be complete)",
        suggested_channel: "human",
        confidence: 0,
        reason: "plan artifact written",
      }),
    };
  }
}

test("E2E forked driver flow routes a task, records telemetry, and aggregates final output", async () => {
  const minervaHome = mkdtempSync(join(tmpdir(), "minerva-e2e-home-"));
  const targetRepo = createTargetRepo();
  const driver = new ScriptedForkedDriver();
  const previousDriver = __setDriverForTest(driver);

  const previousEnv = {
    MINERVA_HOME: process.env.MINERVA_HOME,
    MINERVA_DRIVER: process.env.MINERVA_DRIVER,
    MINERVA_TEST_DRIVE_PROMPT: process.env.MINERVA_TEST_DRIVE_PROMPT,
    MINERVA_CONSUS_DECISIONS_URL: process.env.MINERVA_CONSUS_DECISIONS_URL,
  };

  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_DRIVER = "forked";
  process.env.MINERVA_TEST_DRIVE_PROMPT =
    "route this simulated external task through forked execution: {idea}";
  process.env.MINERVA_CONSUS_DECISIONS_URL = "";

  try {
    const started = await startRun({
      idea: "a simulated external build task",
      target_repo: targetRepo,
    });
    const runId = started.run_id as string;
    assert.ok(runId);

    let record = readRunRecord(runId);
    assert.equal(record.status, "waiting_on_human");
    assert.equal(record.metrics?.driver, "forked");
    assert.equal(record.metrics?.turns, 1);
    assert.equal(record.questions.length, 1);
    assert.equal(record.questions[0]?.qid, "execution_mode");
    assert.equal(record.questions[0]?.kind, "single-select");
    assert.deepEqual(record.questions[0]?.options, ["yes", "no"]);

    const human = getQuestions({ run_id: runId, channel: "human" }) as { questions: Array<{ id: string }> };
    assert.equal(human.questions.length, 1);

    record = readRunRecord(runId);
    assert.equal(record.metrics?.escalations, 1);

    await submitAnswers({
      run_id: runId,
      channel: "human",
      answers: [{ question_id: human.questions[0]!.id, answer: "yes" }],
    });

    assert.deepEqual(driver.events, [
      "route:initial-task",
      "forked:surface-question",
      "route:answer",
      "forked:aggregate-output",
    ]);

    record = readRunRecord(runId);
    assert.equal(record.status, "complete");
    assert.equal(record.metrics?.turns, 2);
    assert.equal(record.metrics?.escalations, 1);
    assert.equal(record.metrics?.auto_resolutions, 0);
    assert.equal(typeof record.metrics?.finalized_at, "string");
    assert.equal(record.questions[0]?.status, "answered");

    const output = getOutput({ run_id: runId }) as any;
    assert.equal(output.epic.epic_id, "e2e-forked-flow");
    assert.equal(output.epic.stories.length, 1);
    assert.equal(output.epic.stories[0].id, "forked-route-and-telemetry");
    assert.equal(output.metrics.turns, 2);
  } finally {
    __setDriverForTest(previousDriver);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    rmSync(minervaHome, { recursive: true, force: true });
    rmSync(targetRepo, { recursive: true, force: true });
  }
});
