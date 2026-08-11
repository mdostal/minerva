// planning-metrics.test.ts -- internal run metrics for planning performance tracking.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { abortRun } from "./cleanup-ledger.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";
import { getQuestions, startRun, __setDriverForTest } from "./kickoff-engine.ts";
import { readRunRecord, getRunStatus, type RunMetrics } from "./run-manager.ts";
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

  constructor(private readonly mode: "human-question" | "complete") {}

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

    return {
      session_id: "sess",
      raw_result: JSON.stringify({
        question: "What human decision should drive this plan?",
        suggested_channel: "human",
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
  assert.equal(record.metrics?.escalations, 0);
  assert.equal(record.metrics?.driver, "spawn");
  assert.equal(typeof record.metrics?.started_at, "string");
  assert.ok(Number.isFinite(Date.parse(record.metrics!.started_at)));
  assert.equal(record.metrics?.elapsed_ms, undefined);
  assert.equal(record.metrics?.finalized_at, undefined);
});

test("getQuestions increments human escalation metrics and persists the update", async () => {
  const { run_id: runId } = (await startRun({ idea: "surface escalation" })) as { run_id: string };

  const surfaced = getQuestions({ run_id: runId, channel: "human" }) as { questions: unknown[] };
  assert.equal(surfaced.questions.length, 1);

  const record = readRunRecord(runId);
  assert.equal(record.metrics?.escalations, 1);
});

test("complete runs finalize elapsed metrics", async () => {
  __setDriverForTest(new MetricsDriver("complete"));
  const { run_id: runId } = (await startRun({ idea: "finish planning" })) as { run_id: string };

  const record = readRunRecord(runId);
  assert.equal(record.status, "complete");
  assert.equal(record.metrics?.turns, 1);
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
  assert.equal(res.metrics.escalations, 0);
  assert.equal(res.metrics.driver, "spawn");
  assert.ok(res.metrics.started_at);
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

