// Run Manager — run lifecycle + AD-3 two-case isolated workspace allocation.
// See docs/architecture.md AD-3 (revised: run-scoped branch cut from dev, not dev itself,
// so concurrent runs against the same target_repo don't collide).

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { MinervaError } from "./errors.ts";
import type { PlanDefaults } from "./plan-defaults.ts";
import type { RouteDecision } from "./driver.ts";

export type WorkspaceKind = "worktree" | "fresh_init";
export type RunStatus = "in_progress" | "waiting_on_human" | "complete" | "aborted";
export type Channel = "agent" | "human";

// Closed to exactly the three values the headless-question-protocol's envelope schema
// documents (forked-driver-integration epic). The gateway itself does not enforce this enum in
// code -- normalizeQuestionKind() below is the defensive boundary that guarantees Minerva's own
// internal Question type never carries anything outside this set.
export type QuestionKind = "single-select" | "multi-select" | "free-text";

export interface RunMetrics {
  turns: number;
  escalations: number;
  auto_resolutions: number;
  driver: string;
  started_at: string;
  elapsed_ms?: number;
  finalized_at?: string;
  // Latest core-api routing decision behind this run's turns (PANT-901), so a decision can be
  // joined to the run's outcome. Absent until a routed turn has run.
  decision_id?: string;
  chosen_lane?: string | null;
  experiment_arm?: string | null;
}

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
  // "superseded" (PANT-923): an optional question of an envelope question set that was still
  // unanswered when the set closed (every required sibling answered, so the driver moved on).
  // It can no longer be answered, so it leaves the pending view without claiming an answer.
  status: "pending" | "answered" | "superseded";
  // Open question set (PANT-923): every question Minerva can know without driving another turn
  // shares one set_id. ForkedHiveDriver's envelope questions use the envelope id; a prose
  // driver's single question is a set of 1 whose set_id is its own id. Optional so run records
  // written before this field existed still parse.
  set_id?: string;
  // Whether the envelope marks this question required (its answer gates the set's closure).
  // Only envelope-sourced questions carry it; prose questions leave it undefined.
  required?: boolean;
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
  metrics?: RunMetrics;
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

// UUID-shape guard (validate-run-id-uuid-shape story). Matches any RFC 4122 version (1-5), not
// v4-specifically -- this validates *shape*, not provenance, so it doesn't couple to
// randomUUID()'s current output format, which could change across Node versions. Co-located here
// because it protects runDir()/runRecordPath()'s path-join immediately above, but it must be
// called ONLY from the two ABI boundaries in front of this module -- dispatch.ts's method routing
// and mcp-server.ts's CallToolRequestSchema handler -- and NEVER from run-manager.ts's own
// functions. Internal callers (e.g. output-emitter.test.ts's direct
// commitAndPushPlan({run_id: "x", ...}) call, which never crosses either ABI boundary) must keep
// working with non-UUID placeholder run_ids unmodified. See the story's PLACEMENT CONSTRAINT.
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuidShaped(value: unknown): value is string {
  return typeof value === "string" && UUID_SHAPE_RE.test(value);
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

// Atomic write (PANT-904): the record is written to a temp file in the same directory, fsynced,
// then renamed over run.yaml. rename(2) within one filesystem is atomic, so a reader (or a crash)
// only ever sees the previous complete record or the new complete record -- never a truncated one.
// A crash between the temp write and the rename leaves an orphaned run.yaml.tmp-* file beside an
// intact run.yaml; nothing reads those. MINERVA_TEST_CRASH_BEFORE_RENAME is a test seam that
// SIGKILLs the process at exactly that point.
function writeRunRecord(record: RunRecord): void {
  const dir = runDir(record.run_id);
  mkdirSync(dir, { recursive: true });
  const finalPath = runRecordPath(record.run_id);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, JSON.stringify(record, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (process.env.MINERVA_TEST_CRASH_BEFORE_RENAME === "1") {
    process.kill(process.pid, "SIGKILL");
  }
  renameSync(tmpPath, finalPath);
  // Persist the rename itself. Best-effort: some platforms can't open/fsync a directory.
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // non-fatal
  }
}

export function readRunRecord(runId: string): RunRecord {
  const path = runRecordPath(runId);
  if (!existsSync(path)) {
    throw new MinervaError("NOT_FOUND", `No run found with id ${runId}`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as RunRecord;
}

// Per-run lock (PANT-904). Every ABI call is its own process, so a read-modify-write of run.yaml
// must be serialized across processes, not just within one. The lock is a lockfile created with
// O_EXCL next to run.yaml; its content is a unique token. Critical sections are a synchronous
// read + atomic write (milliseconds), so a lock older than MINERVA_RUN_LOCK_STALE_MS (default 10s)
// belongs to a process that died holding it and is broken.
const DEFAULT_LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 5;

function runLockPath(runId: string): string {
  return join(runDir(runId), "run.lock");
}

function lockStaleMs(): number {
  const raw = Number(process.env.MINERVA_RUN_LOCK_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOCK_STALE_MS;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockToken(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Break a stale lock without clobbering a fresh one another process may have just taken in its
// place: move the lock aside (atomic, only one breaker wins), then check it is still the token we
// judged stale. If it isn't, we moved a live lock -- put it back (link fails if the path was
// retaken meanwhile, which is equally fine: that holder is live either way).
function breakStaleLock(lockPath: string, staleToken: string): void {
  const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return; // already broken or released by someone else
  }
  if (readLockToken(aside) !== staleToken) {
    try {
      linkSync(aside, lockPath);
    } catch {
      // path retaken meanwhile
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // ignore
  }
}

function acquireRunLock(runId: string): () => void {
  const lockPath = runLockPath(runId);
  const token = `${process.pid}:${randomUUID()}`;
  const staleMs = lockStaleMs();
  const deadline = Date.now() + staleMs * 3;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return () => {
        // Only remove the lock if it is still ours (it may have been broken as stale).
        if (readLockToken(lockPath) === token) {
          try {
            unlinkSync(lockPath);
          } catch {
            // ignore
          }
        }
      };
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        throw new MinervaError("NOT_FOUND", `No run found with id ${runId}`);
      }
      if (e?.code !== "EEXIST") throw e;
    }
    try {
      const holder = readLockToken(lockPath);
      if (holder !== null && Date.now() - statSync(lockPath).mtimeMs > staleMs) {
        breakStaleLock(lockPath, holder);
        continue;
      }
    } catch {
      continue; // lock vanished between checks -- retry immediately
    }
    if (Date.now() > deadline) {
      throw new MinervaError("NOT_READY", `Run ${runId} record is locked by another process; try again`);
    }
    sleepSync(LOCK_RETRY_MS);
  }
}

const TERMINAL_STATUSES: readonly RunStatus[] = ["complete", "aborted"];

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// Locked read-modify-write. `mutate` sees the freshest on-disk record and returns the patch to
// apply, or null to leave the record untouched. Terminal statuses are sticky: once a run is
// complete or aborted, no patch moves it out of that status (other fields still apply).
// `changed` reports whether a write happened.
export function mutateRunRecord(
  runId: string,
  mutate: (current: RunRecord) => Partial<RunRecord> | null,
): { record: RunRecord; changed: boolean } {
  if (!existsSync(runRecordPath(runId))) {
    throw new MinervaError("NOT_FOUND", `No run found with id ${runId}`);
  }
  const release = acquireRunLock(runId);
  try {
    const current = readRunRecord(runId);
    const patch = mutate(current);
    if (patch === null) return { record: current, changed: false };
    const record = { ...current, ...patch };
    if (isTerminalStatus(current.status)) record.status = current.status;
    writeRunRecord(record);
    return { record, changed: true };
  } finally {
    release();
  }
}

// Patch helper. Every mutation goes through mutateRunRecord so state always round-trips
// through disk (no in-memory state survives between CLI invocations, per the State Store's
// statelessness principle in docs/architecture.md).
export function updateRunRecord(runId: string, patch: Partial<RunRecord>): RunRecord {
  return mutateRunRecord(runId, () => patch).record;
}

function fallbackMetrics(record: RunRecord): RunMetrics {
  return {
    turns: 0,
    escalations: 0,
    auto_resolutions: 0,
    driver: record.plan_runtime ?? "spawn",
    started_at: record.created_at,
  };
}

function normalizeMetrics(metrics: RunMetrics): RunMetrics {
  return { ...metrics, auto_resolutions: metrics.auto_resolutions ?? 0 };
}

function currentMetrics(record: RunRecord): RunMetrics {
  return normalizeMetrics(record.metrics ?? fallbackMetrics(record));
}

// Metrics counters are incremented inside the lock so concurrent calls never lose a count.
function patchMetrics(runId: string, fn: (metrics: RunMetrics) => RunMetrics | null): RunRecord {
  return mutateRunRecord(runId, (record) => {
    const next = fn(currentMetrics(record));
    return next === null ? null : { metrics: next };
  }).record;
}

export function updateRunMetricsDriver(runId: string, driverName: string): RunRecord {
  return patchMetrics(runId, (metrics) => ({ ...metrics, driver: driverName }));
}

// routeDecision is the core-api decision behind this turn (DriverResult.route_decision), if any.
export function recordDriverTurn(runId: string, routeDecision?: RouteDecision): RunRecord {
  return patchMetrics(runId, (metrics) => ({ ...metrics, ...routeDecision, turns: metrics.turns + 1 }));
}

export function recordHumanEscalation(runId: string): RunRecord {
  return patchMetrics(runId, (metrics) => ({ ...metrics, escalations: metrics.escalations + 1 }));
}

export function recordAutoResolution(runId: string): RunRecord {
  return patchMetrics(runId, (metrics) => ({ ...metrics, auto_resolutions: metrics.auto_resolutions + 1 }));
}

export function finalizeRunMetrics(runId: string): RunRecord {
  return patchMetrics(runId, (metrics) => {
    if (metrics.finalized_at !== undefined && metrics.elapsed_ms !== undefined) return null;
    const finalizedAt = new Date().toISOString();
    const startedMs = Date.parse(metrics.started_at);
    const finalizedMs = Date.parse(finalizedAt);
    const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, finalizedMs - startedMs) : 0;
    return { ...metrics, elapsed_ms: elapsedMs, finalized_at: finalizedAt };
  });
}

function allocateWorktreeWorkspace(targetRepo: string, runId: string, workspacePath: string): void {
  if (!existsSync(targetRepo)) {
    throw new MinervaError("VALIDATION_FAILED", `target_repo does not exist: ${targetRepo}`);
  }
  // Fetch + fast-forward dev before cutting the worktree so dispatched runs start from the
  // freshest available base. Non-fatal: if offline or not a fast-forward (diverged local
  // dev), we proceed with the current local state rather than blocking the run entirely.
  // Without this, a stale local dev branch causes all dispatched runs to see an outdated
  // codebase — confirmed live: a run dispatched 2026-09-07 was 94 commits behind origin/main,
  // causing it to duplicate work that had already been merged by a parallel build agent.
  try {
    execFileSync("git", ["-C", targetRepo, "fetch", "origin", "dev", "--no-tags", "--quiet"], { stdio: "pipe" });
    execFileSync("git", ["-C", targetRepo, "merge", "--ff-only", "origin/dev"], { stdio: "pipe" });
  } catch {
    // non-fatal: proceed with current local dev
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
    metrics: {
      turns: 0,
      escalations: 0,
      auto_resolutions: 0,
      driver: process.env.MINERVA_DRIVER ?? "spawn",
      started_at: new Date().toISOString(),
    },
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
  return { status: record.status, metrics: record.metrics ?? null };
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
