// Run Manager — run lifecycle + AD-3 two-case isolated workspace allocation.
// See docs/architecture.md AD-3 (revised: run-scoped branch cut from dev, not dev itself,
// so concurrent runs against the same target_repo don't collide).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { MinervaError } from "./errors.ts";

export type WorkspaceKind = "worktree" | "fresh_init";
export type RunStatus = "in_progress" | "waiting_on_human" | "complete" | "aborted";
export type Channel = "agent" | "human";

export interface Question {
  id: string;
  text: string;
  suggested_channel: Channel;
  confidence: number;
  reason: string;
  channel: Channel;
  status: "pending" | "answered";
}

export interface RunRecord {
  run_id: string;
  workspace_path: string;
  workspace_kind: WorkspaceKind;
  state_path: string;
  status: RunStatus;
  created_at: string;
  session_id: string | null;
  questions: Question[];
  // Opaque from run-manager's perspective -- output-emitter.ts owns the actual shape
  // (CompletedEpic: plugin-hive's own epic.yaml + story YAML content, passed through as-is).
  output: unknown | null;
}

function minervaHome(): string {
  return process.env.MINERVA_HOME ?? join(homedir(), ".minerva");
}

function runsRoot(): string {
  return join(minervaHome(), "runs");
}

function runDir(runId: string): string {
  return join(runsRoot(), runId);
}

function runRecordPath(runId: string): string {
  return join(runDir(runId), "run.yaml");
}

function writeRunRecord(record: RunRecord): void {
  mkdirSync(runDir(record.run_id), { recursive: true });
  writeFileSync(runRecordPath(record.run_id), JSON.stringify(record, null, 2));
}

export function readRunRecord(runId: string): RunRecord {
  const path = runRecordPath(runId);
  if (!existsSync(path)) {
    throw new MinervaError("NOT_FOUND", `No run found with id ${runId}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
}

// Read-modify-write patch helper. Every mutation goes through here so state always round-trips
// through disk (no in-memory state survives between CLI invocations, per the State Store's
// statelessness principle in docs/architecture.md).
export function updateRunRecord(runId: string, patch: Partial<RunRecord>): RunRecord {
  const record = { ...readRunRecord(runId), ...patch };
  writeRunRecord(record);
  return record;
}

function allocateWorktreeWorkspace(targetRepo: string, runId: string, workspacePath: string): void {
  if (!existsSync(targetRepo)) {
    throw new MinervaError("VALIDATION_FAILED", `target_repo does not exist: ${targetRepo}`);
  }
  try {
    execFileSync(
      "git",
      ["-C", targetRepo, "worktree", "add", "-b", `run/${runId}`, workspacePath, "dev"],
      { stdio: "pipe" },
    );
  } catch (e) {
    const stderr = e instanceof Error && "stderr" in e ? String((e as any).stderr) : String(e);
    throw new MinervaError(
      "VALIDATION_FAILED",
      `Failed to allocate worktree for target_repo ${targetRepo}: ${stderr.trim()}`,
    );
  }
}

function allocateFreshInitWorkspace(runId: string, workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  execFileSync("git", ["init", "-q", workspacePath]);
  execFileSync(
    "git",
    ["-C", workspacePath, "commit", "-q", "--allow-empty", "-m", `minerva run ${runId} -- scratch workspace init`],
  );
}

// Workspace + record allocation only -- does NOT drive kickoff+plan. kickoff-engine.ts's
// startRun composes this with driveStart() to produce the full API-contract startRun method.
export function allocateRun(idea: string, targetRepo: string | undefined): { run_id: string } {
  const runId = randomUUID();
  const workspacePath = join(runDir(runId), "workspace");
  let workspaceKind: WorkspaceKind;

  if (targetRepo) {
    allocateWorktreeWorkspace(targetRepo, runId, workspacePath);
    workspaceKind = "worktree";
  } else {
    allocateFreshInitWorkspace(runId, workspacePath);
    workspaceKind = "fresh_init";
  }

  const statePath = join(workspacePath, ".pHive");
  mkdirSync(statePath, { recursive: true });

  writeRunRecord({
    run_id: runId,
    workspace_path: workspacePath,
    workspace_kind: workspaceKind,
    state_path: statePath,
    status: "in_progress",
    created_at: new Date().toISOString(),
    session_id: null,
    questions: [],
    output: null,
  });

  return { run_id: runId };
}

export function getRunStatus(params: Record<string, unknown>): Record<string, unknown> {
  const runId = params.run_id;
  if (typeof runId !== "string") {
    throw new MinervaError("VALIDATION_FAILED", "getRunStatus requires a string run_id");
  }
  const record = readRunRecord(runId);
  return { status: record.status };
}

export function listRuns(_params: Record<string, unknown>): Record<string, unknown> {
  const root = runsRoot();
  if (!existsSync(root)) {
    return { runs: [] };
  }
  const runs = readdirSync(root)
    .filter((id) => existsSync(runRecordPath(id)))
    .map((id) => {
      const record = readRunRecord(id);
      return { run_id: record.run_id, status: record.status, created_at: record.created_at };
    });
  return { runs };
}
