// planning-metrics.test.ts -- internal run metrics for planning performance tracking.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { abortRun } from "./cleanup-ledger.ts";
import { laneOf, type Driver, type DriverInput, type DriverResult, type RuntimeRoute } from "./driver.ts";
import { getQuestions, startRun, submitAnswers, __setDriverForTest } from "./kickoff-engine.ts";
import { readRunRecord, getRunStatus, recordHumanEscalations, type RunMetrics } from "./run-manager.ts";
import { getOutput } from "./output-emitter.ts";
import { createSeedRepo } from "./test-cli.ts";

let minervaHome: string;
let seedRepo: string;
let savedDriver: Driver;
const savedEnv = {
  MINERVA_HOME: process.env.MINERVA_HOME,
  MINERVA_SEED_REPO: process.env.MINERVA_SEED_REPO,
  MINERVA_DRIVER: process.env.MINERVA_DRIVER,
};

class MetricsDriver implements Driver {
  turns = 0;

  constructor(
    private readonly mode: "human-question" | "agent-question" | "complete",
    private readonly route?: RuntimeRoute,
  ) {}

  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.turns++;
    if (this.mode === "complete") {
      const epicDir = join(input.cwd, ".pHive", "epics", "metrics-demo");
      mkdirSync(join(epicDir, "stories"), { recursive: true });
      writeFileSync(join(epicDir, "epic.yaml"), "id: metrics-demo\ntitle: Metrics Demo\n");
      writeFileSync(join(epicDir, "stories", "s1.yaml"), "id: s1\ntitle: Track metrics\n");
      return {
        session_id: "sess",
        raw_result: JSON.stringify({ question: "(none)", suggested_channel: "human", confidence: 0, reason: "done" }),
      };
    }

    const channel = this.mode === "agent-question" ? "agent" : "human";
    return {
      session_id: "sess",
      ...(this.route ? { route: this.route } : {}),
      raw_result: JSON.stringify({
        question: `What ${channel} decision should drive this plan (turn ${this.turns})?`,
        suggested_channel: channel,
        confidence: 0.1,
        reason: "strategic human escalation",
        kind: "free-text",
        options: null,
        qid: "strategy",
      }),
    };
  }
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-metrics-"));
  seedRepo = createSeedRepo("minerva-seed-repo-metrics-");
  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_SEED_REPO = seedRepo;
  process.env.MINERVA_DRIVER = "spawn";
  savedDriver = __setDriverForTest(new MetricsDriver("human-question"));
});

beforeEach(() => {
  __setDriverForTest(new MetricsDriver("human-question"));
});

after(() => {
  __setDriverForTest(savedDriver);
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("startRun initializes persisted metrics and records the first completed driver turn", async () => {
  const { run_id: runId } = (await startRun({ idea: "measure planning" })) as { run_id: string };

  const record = readRunRecord(runId);
  assert.equal(record.metrics?.turns, 1);
  // The first turn parked a human-channel question, which counts as one escalation at creation.
  assert.equal(record.metrics?.escalations, 1);
  assert.equal(record.metrics?.auto_resolutions, 0);
  assert.equal(record.metrics?.driver, "spawn");
  assert.equal(typeof record.metrics?.started_at, "string");
  assert.ok(Number.isFinite(Date.parse(record.metrics!.started_at)));
  assert.equal(record.metrics?.elapsed_ms, undefined);
  assert.equal(record.metrics?.finalized_at, undefined);
});

test("a parked human question counts as one escalation when created, and stamps escalated_at", async () => {
  const { run_id: runId } = (await startRun({ idea: "surface escalation" })) as { run_id: string };

  const record = readRunRecord(runId);
  assert.equal(record.metrics?.escalations, 1);
  assert.equal(record.questions.length, 1);
  assert.equal(record.questions[0]?.channel, "human");
  assert.ok(Number.isFinite(Date.parse(record.questions[0]!.escalated_at!)));
});

test("calling getQuestions(human) five times on one parked question leaves escalations == 1", async () => {
  const { run_id: runId } = (await startRun({ idea: "poll escalation" })) as { run_id: string };

  for (let i = 0; i < 5; i++) {
    const surfaced = getQuestions({ run_id: runId, channel: "human" }) as { questions: unknown[] };
    assert.equal(surfaced.questions.length, 1);
  }

  const record = readRunRecord(runId);
  assert.equal(record.metrics?.escalations, 1);
});

test("each new human question on a later turn is its own escalation", async () => {
  const { run_id: runId } = (await startRun({ idea: "two escalations" })) as { run_id: string };
  const [first] = (getQuestions({ run_id: runId, channel: "human" }) as { questions: Array<{ id: string }> }).questions;

  await submitAnswers({ run_id: runId, channel: "human", answers: [{ question_id: first!.id, answer: "ship it" }] });
  getQuestions({ run_id: runId, channel: "human" });
  getQuestions({ run_id: runId, channel: "human" });

  const record = readRunRecord(runId);
  assert.equal(record.questions.length, 2);
  assert.equal(record.metrics?.escalations, 2);
});

test("an agent question the auto-answer loop escalates to the human queue counts once", async () => {
  __setDriverForTest(new MetricsDriver("agent-question"));
  const { run_id: runId } = (await startRun({
    idea: "agent escalation",
    defaults: { mode: "agent", free_text_default: null },
  })) as { run_id: string };

  let record = readRunRecord(runId);
  assert.equal(record.questions[0]?.suggested_channel, "agent");
  assert.equal(record.questions[0]?.channel, "human");
  assert.equal(record.metrics?.escalations, 1);

  getQuestions({ run_id: runId, channel: "human" });
  record = readRunRecord(runId);
  assert.equal(record.metrics?.escalations, 1);
});

test("driver turns that report a route record the run's lane", async () => {
  __setDriverForTest(new MetricsDriver("human-question", { cli: "opencode", model: "openai/gpt-5" }));
  const { run_id: runId } = (await startRun({ idea: "lane capture" })) as { run_id: string };

  assert.equal(readRunRecord(runId).metrics?.lane, "opencode:openai/gpt-5");
});

test("complete runs finalize elapsed metrics", async () => {
  __setDriverForTest(new MetricsDriver("complete"));
  const { run_id: runId } = (await startRun({ idea: "finish planning" })) as { run_id: string };

  const record = readRunRecord(runId);
  assert.equal(record.status, "complete");
  assert.equal(record.metrics?.turns, 1);
  assert.equal(record.metrics?.auto_resolutions, 0);
  assert.equal(typeof record.metrics?.elapsed_ms, "number");
  assert.ok(record.metrics!.elapsed_ms! >= 0);
  assert.equal(typeof record.metrics?.finalized_at, "string");
  assert.ok(Number.isFinite(Date.parse(record.metrics!.finalized_at!)));
});

test("aborted runs finalize elapsed metrics", async () => {
  const { run_id: runId } = (await startRun({ idea: "abort planning" })) as { run_id: string };

  abortRun({ run_id: runId });

  const record = readRunRecord(runId);
  assert.equal(record.status, "aborted");
  assert.equal(typeof record.metrics?.elapsed_ms, "number");
  assert.ok(record.metrics!.elapsed_ms! >= 0);
  assert.equal(typeof record.metrics?.finalized_at, "string");
});

test("getRunStatus surfaces the persisted metrics via the ABI", async () => {
  const { run_id: runId } = (await startRun({ idea: "metrics ABI test" })) as { run_id: string };

  const res = getRunStatus({ run_id: runId }) as { status: string; metrics: RunMetrics };
  assert.equal(res.status, "waiting_on_human");
  assert.ok(res.metrics);
  assert.equal(res.metrics.turns, 1);
  assert.equal(res.metrics.escalations, 1);
  assert.equal(res.metrics.driver, "spawn");
  assert.ok(res.metrics.started_at);
});

test("getRunStatus surfaces the core-api route decision behind the run's turns (PANT-901)", async () => {
  __setDriverForTest({
    async runTurn(input: DriverInput): Promise<DriverResult> {
      const result = await new MetricsDriver("human-question").runTurn(input);
      return {
        ...result,
        route_decision: { decision_id: "dec-123", chosen_lane: "claude@ffevents", experiment_arm: null },
      };
    },
  });
  const { run_id: runId } = (await startRun({ idea: "metrics route decision test" })) as { run_id: string };

  const res = getRunStatus({ run_id: runId }) as { metrics: RunMetrics };
  assert.equal(res.metrics.decision_id, "dec-123");
  assert.equal(res.metrics.chosen_lane, "claude@ffevents");
  assert.equal(res.metrics.experiment_arm, null);
  assert.equal(res.metrics.turns, 1);
});

test("getOutput surfaces the finalized metrics via the ABI", async () => {
  __setDriverForTest(new MetricsDriver("complete"));
  const { run_id: runId } = (await startRun({ idea: "metrics ABI test complete" })) as { run_id: string };

  const res = getOutput({ run_id: runId }) as { metrics: RunMetrics };
  assert.ok(res.metrics);
  assert.equal(res.metrics.turns, 1);
  assert.equal(typeof res.metrics.elapsed_ms, "number");
  assert.ok(res.metrics.finalized_at);
});


test("re-running the locked escalation sweep never re-counts an already-stamped question", async () => {
  const { run_id: runId } = (await startRun({ idea: "locked sweep" })) as { run_id: string };
  const stamped = readRunRecord(runId).questions[0]!.escalated_at;

  for (let i = 0; i < 5; i++) {
    recordHumanEscalations(runId);
    getQuestions({ run_id: runId, channel: "human" });
  }

  const record = readRunRecord(runId);
  assert.equal(record.metrics?.escalations, 1);
  assert.equal(record.questions[0]!.escalated_at, stamped);
});

test("laneOf prefers core-api's chosen_lane and falls back to <cli>:<model>", () => {
  assert.equal(laneOf(undefined), undefined);
  assert.equal(laneOf({ cli: "claude", model: "claude-sonnet-5" }), "claude:claude-sonnet-5");
  assert.equal(
    laneOf({
      cli: "claude",
      model: "claude-sonnet-5",
      decision: { decision_id: "d-1", chosen_lane: "claude@ffevents", experiment_arm: null },
    }),
    "claude@ffevents",
  );
  assert.equal(
    laneOf({ cli: "codex", model: "gpt-5", decision: { decision_id: "d-2", chosen_lane: null, experiment_arm: null } }),
    "codex:gpt-5",
  );
});
