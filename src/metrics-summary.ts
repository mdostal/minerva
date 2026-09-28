// metrics-summary.ts — getMetrics: a cross-run planning-KPI summary built only from the local run
// records under MINERVA_HOME (standalone-first, no network). The per-run numbers themselves are
// owned by run-manager.ts (RunMetrics); this module only reads and aggregates them, grouped by
// driver and by route lane, so plan-quality comparisons across runs use one consistent shape.

import { readAllRunRecords, type RunRecord, type RunStatus } from "./run-manager.ts";

const STATUSES: RunStatus[] = ["in_progress", "waiting_on_human", "complete", "aborted"];

// Group key for records that predate a field (no metrics at all, or no captured lane).
export const UNKNOWN_GROUP = "unknown";

export interface Distribution {
  median: number | null;
  p90: number | null;
}

export interface MetricsGroup {
  runs: number;
  by_status: Record<RunStatus, number>;
  // complete / (complete + aborted). In-flight runs are excluded so a run still being planned
  // doesn't count as a failure. null when no run in the group has finished yet.
  completion_rate: number | null;
  turns: Distribution;
  escalations: Distribution;
  auto_resolutions: Distribution;
  // Wall-clock from run start to finalization, over COMPLETE runs only (an aborted run never
  // produced a spec).
  time_to_spec_ms: Distribution;
}

// Nearest-rank percentile over an ascending-sorted sample: the smallest value with at least p% of
// the sample at or below it. Always returns an observed value, never an interpolated one.
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

function distribution(values: number[]): Distribution {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return { median: percentile(sorted, 50), p90: percentile(sorted, 90) };
}

export function summarizeRuns(records: RunRecord[]): MetricsGroup {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<RunStatus, number>;
  for (const r of records) {
    if (r.status in byStatus) byStatus[r.status]++;
  }
  const finished = byStatus.complete + byStatus.aborted;
  const withMetrics = records.filter((r) => r.metrics);
  return {
    runs: records.length,
    by_status: byStatus,
    completion_rate: finished === 0 ? null : byStatus.complete / finished,
    turns: distribution(withMetrics.map((r) => r.metrics!.turns)),
    escalations: distribution(withMetrics.map((r) => r.metrics!.escalations)),
    auto_resolutions: distribution(withMetrics.map((r) => r.metrics!.auto_resolutions ?? 0)),
    time_to_spec_ms: distribution(
      withMetrics
        .filter((r) => r.status === "complete" && typeof r.metrics!.elapsed_ms === "number")
        .map((r) => r.metrics!.elapsed_ms!),
    ),
  };
}

function driverKey(r: RunRecord): string {
  return r.metrics?.driver ?? UNKNOWN_GROUP;
}

// Runs recorded before lane capture fall back to the agnostic planner's frozen runtime+model when
// present -- the same "<cli>:<model>" shape laneOf() produces.
function laneKey(r: RunRecord): string {
  if (r.metrics?.lane) return r.metrics.lane;
  if (r.plan_runtime && r.plan_model) return `${r.plan_runtime}:${r.plan_model}`;
  return UNKNOWN_GROUP;
}

function groupBy(records: RunRecord[], key: (r: RunRecord) => string): Record<string, MetricsGroup> {
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const k = key(r);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return Object.fromEntries([...groups.keys()].sort().map((k) => [k, summarizeRuns(groups.get(k)!)]));
}

export function getMetrics(_params: Record<string, unknown>): Record<string, unknown> {
  const { records, skipped } = readAllRunRecords();
  return {
    generated_at: new Date().toISOString(),
    skipped_records: skipped,
    overall: summarizeRuns(records),
    by_driver: groupBy(records, driverKey),
    by_lane: groupBy(records, laneKey),
  };
}
