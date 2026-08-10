// Run Manager — run lifecycle + AD-3 two-case isolated workspace allocation.
// See docs/architecture.md AD-3 (revised: run-scoped branch cut from dev, not dev itself,
// so concurrent runs against the same target_repo don't collide).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { MinervaError } from "./errors.ts";
import type { PlanDefaults } from "./plan-defaults.ts";

export type WorkspaceKind = "worktree" | "fresh_init";
export type RunStatus = "in_progress" | "waiting_on_human" | "awaiting-consus" | "complete" | "aborted";
export type Channel = "agent" | "human";

// Closed to exactly the three values the headless-question-protocol's envelope schema
// documents (forked-driver-integration epic). The gateway itself does not enforce this enum in
// code -- normalizeQuestionKind() below is the defensive boundary that guarantees Minerva's own
// internal Question type never carries anything outside this set.
export type QuestionKind = "single-select" | "multi-select" | "free-text";

// Never throws, never guesses a channel-like value -- any value outside the three documented
// kinds defaults to "free-text" (the least-structured, always-safe interpretation). Confirmed
// necessary empirically: the gateway's own code does not validate `kind`, so a malformed or
// unexpected value reaching this boundary is a real, expected input shape, not a hypothetical.
export function normalizeQuestionKind(raw: unknown): QuestionKind {
  if (raw === "single-select" || raw === "multi-select" || raw === "free-text") {
    return raw;
  }
  return "free-text";
}

export interface Question {
  id: string;
  text: string;
  suggested_channel: Channel;
  confidence: number;
  reason: string;
  channel: Channel;
  status: "pending" | "answered";
  // Optional -- only present for Driver implementations whose upstream source carries this
  // shape (currently: ForkedHiveDriver's envelope-sourced questions, per the
  // headless-question-protocol's question-envelope-schema.md). SpawnDriver/SubagentDriver never
  // set these fields; every existing code path that constructs a Question without them is
  // unaffected -- this extension is strictly additive.
  kind?: QuestionKind;
  options?: string[] | null;
  // The envelope's own qid (question-envelope-schema.md), distinct from this Question's own
  // `id` (Minerva's internally-generated id, e.g. "q-1"). Carried through so ForkedHiveDriver's
  // answer-write-back step can address the correct question within a multi-question envelope
  // without re-deriving the mapping.
  qid?: string;
  consus_question_id?: string;
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
  // Bug fix (2026-07-26, real regression): epic ids that already existed under
  // .pHive/epics/ at workspace-allocation time, BEFORE any kickoff turn ran. A worktree
  // workspace forks off the target repo's `dev` branch, which can (and, on a mature repo, will)
  // already have prior, already-shipped epics committed on it -- output-emitter.ts's completion
  // detection must never mistake one of THOSE for this run's own output. Always [] for
  // fresh_init workspaces (a brand-new scratch repo has no epics at all yet). See
  // output-emitter.ts's findCompletedEpic for how this is consumed.
  baseline_epic_ids: string[];
  // The original idea brief that started the run. Persisted so the pre-baked-defaults
  // auto-answer loop (kickoff-engine.ts) can interpolate `{idea}` into a free-text default
  // answer on any turn, not just at startRun. Optional so run records written before this field
  // existed still parse.
  idea?: string;
  // The effective pre-baked plan-defaults config for this run (prebaked-plan-defaults epic),
  // resolved once at startRun from built-in + env + per-run layers and frozen for the run's
  // life, so every subsequent auto-answer turn uses the same config the run started with.
  // Optional/absent => the auto-answer loop falls back to loadPlanDefaults() (mode: off), i.e.
  // fully backwards-compatible "park every question" behavior.
  defaults?: PlanDefaults;
  // The resolved local target repo this run's worktree was cut from (PAN-6745). Present only for
  // worktree workspaces (absent for fresh_init). Persisted for logging + so the completion
  // commit+push step (output-emitter.commitAndPushPlan) has the repo on hand. Optional so records
  // written before this field existed still parse.
  target_repo?: string;
  // How target_repo was resolved (repo-resolution.ts): "explicit" | "god" | "incubator". Absent
  // for fresh_init (resolution returned "none"). Diagnostic only.
  repo_source?: string;
  // Result of the post-planning auto-commit+push of the plan into target_repo (PAN-6745), written
  // once when the run transitions to complete. Absent until then, and for fresh_init runs where
  // there is nothing to push. Opaque here; output-emitter owns the shape (PlanPushResult).
  plan_push?: unknown;
  // Runner-agnostic planning (agnostic-plan-driver.ts). When Heimdall routes planning to a
  // non-Claude runtime, these carry the resolved runtime + model so EVERY turn (initial
  // decompose, auto-answered gates, human-answered resumes) reconstructs the same
  // AgnosticPlanDriver and continues the same runtime session. Absent => the built-in claude
  // SpawnDriver drives the run (fully backwards-compatible). Persisted so a run's runtime never
  // changes mid-flight even across process restarts.

  // Runner-agnostic planning (agnostic-plan-driver.ts). When present, these identify the
  // runtime + model chosen for the run's planning turns. Absent keeps the existing claude
  // driver behavior.
  plan_runtime?: string;
  plan_model?: string;
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

export function defaultSeedRepoPath(): string {
  return join(homedir(), "repos", "consus-seeds");
}

function resolveSeedRepo(): string {
  const seedRepo = process.env.MINERVA_SEED_REPO || defaultSeedRepoPath();
  if (!existsSync(seedRepo)) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `Seed repo does not exist: ${seedRepo}. Set MINERVA_SEED_REPO to a local git repo path, or set up the default with: git clone git@github.com:mdostal/consus-seeds.git ${defaultSeedRepoPath()}`,
    );
  }
  return seedRepo;
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

// Bug fix (2026-07-26, real regression): reads whatever epic ids already exist under
// .pHive/epics/ in a freshly-allocated workspace, BEFORE any kickoff turn has run. For a
// worktree workspace this reflects exactly the target repo's `dev` branch state (git worktree
// add checks out dev's tracked tree regardless of .gitignore, which only affects untracked
// files) -- for a fresh_init workspace it's always []. See baseline_epic_ids's own doc comment
// on RunRecord for why this snapshot exists.
function snapshotEpicIds(workspacePath: string): string[] {
  const epicsDir = join(workspacePath, ".pHive", "epics");
  if (!existsSync(epicsDir)) return [];
  return readdirSync(epicsDir);
}

// Workspace + record allocation only -- does NOT drive kickoff+plan. kickoff-engine.ts's
// startRun composes this with driveStart() to produce the full API-contract startRun method.
// `defaults` (prebaked-plan-defaults epic) is the resolved plan-defaults config to freeze onto
// the record; optional so existing callers (and the test suite) that don't pass it are
// unaffected -- an absent defaults means the auto-answer loop stays "off".
export function allocateRun(
  idea: string,
  targetRepo: string | undefined,
  defaults?: PlanDefaults,
  repoSource?: string,
): { run_id: string } {
  const runId = randomUUID();
  const workspacePath = join(runDir(runId), "workspace");
  let workspaceKind: WorkspaceKind;

  if (targetRepo) {
    allocateWorktreeWorkspace(targetRepo, runId, workspacePath);
    workspaceKind = "worktree";
  } else {
    allocateWorktreeWorkspace(resolveSeedRepo(), runId, workspacePath);
    workspaceKind = "worktree";
  }

  const statePath = join(workspacePath, ".pHive");
  mkdirSync(statePath, { recursive: true });

  const baselineEpicIds = snapshotEpicIds(workspacePath);

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
    baseline_epic_ids: baselineEpicIds,
    idea,
    defaults,
    // Persist the resolved repo only for worktree workspaces -- a fresh_init scratch has no real
    // repo to record, and its absence is what output-emitter's push step keys off (PAN-6745).
    ...(workspaceKind === "worktree" && targetRepo ? { target_repo: targetRepo, repo_source: repoSource } : {}),
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
