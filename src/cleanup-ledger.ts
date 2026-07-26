// Cleanup Ledger / Event Sink (AD-4) — on run completion or abort, append a durable
// CleanupLedgerRecord to a shared, append-only ledger, and emit a cleanup_needed event
// following this ecosystem's events-sink convention (plugin-hive's own
// `<state_dir>/metrics/events/` JSONL-append pattern). Minerva never deletes workspace_path or
// state_path itself -- record and signal only; an external system is responsible for cleanup.

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { MinervaError } from "./errors.ts";
import { readRunRecord, updateRunRecord, type RunStatus } from "./run-manager.ts";

function minervaHome(): string {
  return process.env.MINERVA_HOME ?? join(homedir(), ".minerva");
}

// Shared across ALL runs (not per-run state) -- an external GC process has one place to read
// from, per AD-4.
function ledgerPath(): string {
  return join(minervaHome(), "cleanup-ledger.jsonl");
}

function eventsPath(): string {
  return join(minervaHome(), "events", "cleanup_needed.jsonl");
}

function appendJsonLine(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(obj) + "\n");
}

export interface CleanupLedgerRecord {
  run_id: string;
  workspace_path: string;
  state_path: string;
  status: "complete" | "aborted";
  closed_at: string;
}

// Called exactly once per run, at the point it transitions to a terminal state (complete or
// aborted). Appends one ledger record and emits one cleanup_needed event -- never deletes
// workspace_path or state_path.
export function recordCleanup(runId: string, closedStatus: "complete" | "aborted"): void {
  const record = readRunRecord(runId);
  const closedAt = new Date().toISOString();
  const ledgerRecord: CleanupLedgerRecord = {
    run_id: record.run_id,
    workspace_path: record.workspace_path,
    state_path: record.state_path,
    status: closedStatus,
    closed_at: closedAt,
  };
  appendJsonLine(ledgerPath(), ledgerRecord);
  appendJsonLine(eventsPath(), { event: "cleanup_needed", ...ledgerRecord, emitted_at: closedAt });
}

const TERMINAL_STATUSES: RunStatus[] = ["complete", "aborted"];

export function abortRun(params: Record<string, unknown>): Record<string, unknown> {
  const runId = params.run_id;
  if (typeof runId !== "string") {
    throw new MinervaError("VALIDATION_FAILED", "abortRun requires a string run_id");
  }
  const record = readRunRecord(runId);

  // Idempotent on an already-terminal run -- do not double-record a ledger entry (the "exactly
  // one CleanupLedgerRecord" acceptance criterion holds even if abortRun is called more than
  // once, or called after the run already completed on its own).
  if (TERMINAL_STATUSES.includes(record.status)) {
    return { result: {} };
  }

  updateRunRecord(runId, { status: "aborted" });
  recordCleanup(runId, "aborted");
  return { result: {} };
}
