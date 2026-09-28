// metrics-summary.test.ts -- getMetrics: cross-run planning KPIs aggregated from fixture run
// records written straight into a throwaway MINERVA_HOME (no drivers, no network).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getMetrics, type MetricsGroup } from "./metrics-summary.ts";
import { dispatch } from "./dispatch.ts";
import type { RunRecord, RunStatus } from "./run-manager.ts";

let minervaHome: string;
const savedHome = process.env.MINERVA_HOME;
let seq = 0;

function writeFixture(
  status: RunStatus,
  metrics: Partial<NonNullable<RunRecord["metrics"]>> | null,
  extra: Partial<RunRecord> = {},
): void {
  const runId = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
  const record: RunRecord = {
    run_id: runId,
    workspace_path: "/nowhere",
    workspace_kind: "worktree",
    state_path: "/nowhere/.pHive",
    status,
    created_at: "2026-09-28T00:00:00.000Z",
    session_id: null,
    questions: [],
    output: null,
    baseline_epic_ids: [],
    ...(metrics
      ? {
          metrics: {
            turns: 0,
            escalations: 0,
            auto_resolutions: 0,
            driver: "spawn",
            started_at: "2026-09-28T00:00:00.000Z",
            ...metrics,
          },
        }
      : {}),
    ...extra,
  };
  const dir = join(minervaHome, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.yaml"), JSON.stringify(record, null, 2));
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-metrics-summary-"));
  process.env.MINERVA_HOME = minervaHome;

  const claude = "claude:claude-sonnet-5";
  const opencode = "opencode:openai/gpt-5";
  // spawn on the claude lane: 3 complete, 1 aborted, 1 parked.
  writeFixture("complete", { lane: claude, turns: 2, escalations: 0, auto_resolutions: 1, elapsed_ms: 1000 });
  writeFixture("complete", { lane: claude, turns: 4, escalations: 1, auto_resolutions: 3, elapsed_ms: 3000 });
  writeFixture("complete", { lane: claude, turns: 6, escalations: 2, auto_resolutions: 5, elapsed_ms: 9000 });
  writeFixture("aborted", { lane: claude, turns: 1, escalations: 0, auto_resolutions: 0, elapsed_ms: 500 });
  writeFixture("waiting_on_human", { lane: claude, turns: 3, escalations: 1, auto_resolutions: 0 });
  // forked on the opencode lane: 1 complete, 1 aborted.
  writeFixture("complete", { driver: "forked", lane: opencode, turns: 10, escalations: 4, auto_resolutions: 2, elapsed_ms: 20000 });
  writeFixture("aborted", { driver: "forked", lane: opencode, turns: 3, escalations: 1, auto_resolutions: 0, elapsed_ms: 700 });
  // Legacy agnostic run recorded before lane capture: lane falls back to plan_runtime:plan_model.
  writeFixture("in_progress", { driver: "opencode", turns: 1 }, { plan_runtime: "opencode", plan_model: "openai/gpt-5" });
  // Record from before lane capture but with a core-api decision: lane falls back to chosen_lane.
  writeFixture("complete", { driver: "subagent", chosen_lane: "claude@ffevents", turns: 2, elapsed_ms: 4000 });
  // Legacy record with no metrics at all: counted by status, contributes no samples.
  writeFixture("in_progress", null);
  // A corrupt record is skipped, not fatal.
  const corrupt = join(minervaHome, "runs", "corrupt");
  mkdirSync(corrupt, { recursive: true });
  writeFileSync(join(corrupt, "run.yaml"), "{not json");
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.MINERVA_HOME;
  else process.env.MINERVA_HOME = savedHome;
});

test("getMetrics aggregates per driver", () => {
  const res = getMetrics({}) as { by_driver: Record<string, MetricsGroup>; skipped_records: number };
  assert.deepEqual(Object.keys(res.by_driver), ["forked", "opencode", "spawn", "subagent", "unknown"]);
  assert.equal(res.skipped_records, 1);

  const spawn = res.by_driver.spawn!;
  assert.equal(spawn.runs, 5);
  assert.deepEqual(spawn.by_status, { in_progress: 0, waiting_on_human: 1, complete: 3, aborted: 1 });
  assert.equal(spawn.completion_rate, 0.75);
  // turns [1,2,3,4,6]: nearest-rank median = 3rd, p90 = 5th.
  assert.deepEqual(spawn.turns, { median: 3, p90: 6 });
  assert.deepEqual(spawn.escalations, { median: 1, p90: 2 });
  assert.deepEqual(spawn.auto_resolutions, { median: 1, p90: 5 });
  // time-to-spec over complete runs only: [1000,3000,9000]; the aborted run's 500 is excluded.
  assert.deepEqual(spawn.time_to_spec_ms, { median: 3000, p90: 9000 });

  const forked = res.by_driver.forked!;
  assert.equal(forked.runs, 2);
  assert.equal(forked.completion_rate, 0.5);
  assert.deepEqual(forked.turns, { median: 3, p90: 10 });
  assert.deepEqual(forked.escalations, { median: 1, p90: 4 });
  assert.deepEqual(forked.time_to_spec_ms, { median: 20000, p90: 20000 });

  const unknown = res.by_driver.unknown!;
  assert.equal(unknown.runs, 1);
  assert.equal(unknown.completion_rate, null);
  assert.deepEqual(unknown.turns, { median: null, p90: null });
});

test("getMetrics aggregates per route lane, falling back to the frozen plan runtime for legacy runs", () => {
  const res = getMetrics({}) as { by_lane: Record<string, MetricsGroup> };
  assert.deepEqual(Object.keys(res.by_lane), ["claude:claude-sonnet-5", "claude@ffevents", "opencode:openai/gpt-5", "unknown"]);
  assert.equal(res.by_lane["claude@ffevents"]!.runs, 1);

  const claude = res.by_lane["claude:claude-sonnet-5"]!;
  assert.equal(claude.runs, 5);
  assert.equal(claude.completion_rate, 0.75);
  assert.deepEqual(claude.time_to_spec_ms, { median: 3000, p90: 9000 });

  const opencode = res.by_lane["opencode:openai/gpt-5"]!;
  assert.equal(opencode.runs, 3);
  assert.deepEqual(opencode.by_status, { in_progress: 1, waiting_on_human: 0, complete: 1, aborted: 1 });
  assert.equal(opencode.completion_rate, 0.5);
  // turns [1,3,10]
  assert.deepEqual(opencode.turns, { median: 3, p90: 10 });

  assert.equal(res.by_lane.unknown!.runs, 1);
});

test("getMetrics reports an overall summary and is reachable through the ABI", async () => {
  const response = await dispatch({ method: "getMetrics", params: {} });
  assert.ok("result" in response);
  const overall = (response.result as { overall: MetricsGroup }).overall;
  assert.equal(overall.runs, 10);
  assert.deepEqual(overall.by_status, { in_progress: 2, waiting_on_human: 1, complete: 5, aborted: 2 });
  assert.equal(overall.completion_rate, 5 / 7);
  // [1000,3000,4000,9000,20000]
  assert.deepEqual(overall.time_to_spec_ms, { median: 4000, p90: 20000 });
});

test("getMetrics over an empty MINERVA_HOME returns zeroed groups, not an error", () => {
  const saved = process.env.MINERVA_HOME;
  process.env.MINERVA_HOME = mkdtempSync(join(tmpdir(), "minerva-home-metrics-empty-"));
  try {
    const res = getMetrics({}) as { overall: MetricsGroup; by_driver: object; by_lane: object };
    assert.equal(res.overall.runs, 0);
    assert.equal(res.overall.completion_rate, null);
    assert.deepEqual(res.by_driver, {});
    assert.deepEqual(res.by_lane, {});
  } finally {
    rmSync(process.env.MINERVA_HOME!, { recursive: true, force: true });
    process.env.MINERVA_HOME = saved;
  }
});
