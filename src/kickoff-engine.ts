// Kickoff+Plan Engine — headless claude -p drive/resume plumbing, composed with real question
// extraction + escalation classification (see question-extraction.ts and
// escalation-classification.ts) in one combined --json-schema call. See docs/architecture.md
// "No Autonomous Progress" and AD-2.

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { MinervaError } from "./errors.ts";
import {
  allocateRun,
  readRunRecord,
  updateRunRecord,
  mutateRunRecord,
  isTerminalStatus,
  normalizeQuestionKind,
  recordDriverTurn,
  recordHumanEscalations,
  recordAutoResolution,
  updateRunMetricsDriver,
  abandonedClaimPatch,
  releaseAbandonedResume,
  isLiveResumeClaim,
  newResumeClaim,
  claimOwner,
  type Question,
  type Channel,
  type RunRecord,
  type Park,
  type ParkReason,
  type ResumeClaim,
} from "./run-manager.ts";
import { abortRun } from "./cleanup-ledger.ts";
import { extractClassifiedQuestion } from "./escalation-classification.ts";
import { checkAndMarkComplete } from "./output-emitter.ts";
import {
  SpawnDriver,
  SubagentDriver,
  ForkedHiveDriver,
  TurnTimeoutError,
  isSessionGoneError,
  isEnvelopeHandle,
  laneOf,
  type Driver,
  type DriverInput,
  type DriverResult,
} from "./driver.ts";
import { resolveAgnosticPlanDriver, resolvePlanningRoute, agnosticPlanDriverFromRecord, type AgnosticPlanDriver } from "./agnostic-plan-driver.ts";
import { loadPlanDefaults, resolveDefaultAnswer, drivePromptSuffix, type PlanDefaults } from "./plan-defaults.ts";
import { resolveTargetRepo } from "./repo-resolution.ts";
import { normalizeTargetRepoValue } from "./target-repo-signal.ts";
import {
  PLUGIN_HIVE_TOOL,
  expandInvoke,
  questionsDirOf,
  resolveTool,
  toolForRecord,
  type ToolDescriptor,
} from "./tool-descriptor.ts";

// MINERVA_DRIVER selects the Driver implementation, following MODEL/CLAUDE_TIMEOUT_MS's
// existing env-var-read pattern in driver.ts. Default remains "spawn" -- cheaper, faster,
// already proven in production. Operators opt into "subagent" where orphaning is the active
// pain, or "forked" (forked-driver-integration epic) where even the question-wait step should
// carry zero orphan risk (no live process at all while waiting on a human -- state lives on
// disk as a question envelope); an unrecognized value fails loudly at startup rather than
// silently falling back.
function selectDriver(): Driver {
  const value = process.env.MINERVA_DRIVER ?? "spawn";
  if (value === "spawn") return new SpawnDriver();
  if (value === "subagent") return new SubagentDriver();
  if (value === "forked") return new ForkedHiveDriver();
  throw new MinervaError(
    "VALIDATION_FAILED",
    `Unrecognized MINERVA_DRIVER value "${value}" -- expected "spawn", "subagent", or "forked"`,
  );
}

// `let`, not `const`, so tests can inject a scripted fake Driver (via __setDriverForTest) to
// exercise the auto-answer loop deterministically without spawning a real `claude` process. Every
// engine call reads this binding live, so a swap takes effect immediately. Production code never
// calls the setter -- the real driver from selectDriver() is used unchanged.
let driver: Driver = selectDriver();

// Test-only seam. Not part of the ABI, not reachable via dispatch.ts -- kept minimal and clearly
// named. Returns the previous driver so a test can restore it in an after() hook.
export function __setDriverForTest(d: Driver): Driver {
  const prev = driver;
  driver = d;
  return prev;
}

// Goblin PAN-7572 (turn-timeout-SIGKILLs-long-plans-loses-work): a turn that simply ran longer
// than MINERVA_TURN_TIMEOUT_MS (a large architectural planning turn is the reported case) used
// to propagate straight out of startRun/submitAnswers as an uncaught rejection -- the whole run
// died with no resume, even though the run's own session_id was still perfectly valid to
// --resume against. MINERVA_TURN_RETRY_LIMIT bounds how many additional attempts a genuinely
// timed-out turn (TurnTimeoutError specifically -- never a different failure) gets before
// giving up for real; default 2 (never guess/never silently disable, matching MINERVA_DRIVER's
// own "fail loudly on an invalid value" pattern). 0 disables retrying entirely.
const DEFAULT_TURN_RETRY_LIMIT = 2;
function resolveTurnRetryLimit(): number {
  const raw = process.env.MINERVA_TURN_RETRY_LIMIT;
  if (raw === undefined) return DEFAULT_TURN_RETRY_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `Invalid MINERVA_TURN_RETRY_LIMIT value "${raw}" -- expected a non-negative integer`,
    );
  }
  return parsed;
}
const TURN_RETRY_LIMIT = resolveTurnRetryLimit();

// target-repo-allowlist story (harden-run-id-and-target-repo-boundaries epic): MINERVA_ALLOWED_
// TARGET_REPOS is OPTIONAL and comma-separated (owner/repo slugs and/or absolute local paths --
// the same two shapes target_repo already accepts). Unset (the default) means NO allowlist is
// enforced -- startRun's behavior is completely unchanged, matching this project's "opt-in
// hardening, never a new default restriction" idiom (cf. MINERVA_REPO_MAP/MINERVA_INCUBATOR_REPO
// in repo-resolution.ts). Returns null for "unset" AND for "set but blank/all-whitespace" so both
// mean identically "no restriction" -- never an accidental empty allowlist that rejects everything.
function resolveAllowedTargetRepos(): string[] | null {
  const raw = process.env.MINERVA_ALLOWED_TARGET_REPOS;
  if (raw === undefined) return null;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return entries.length > 0 ? entries : null;
}

// Exact-match only (no globs -- v1 scope, see this story's design_decisions). Reuses
// normalizeTargetRepoValue()'s existing slug/path classification rather than inventing a new
// comparison shape: a slug/URL target_repo is compared by its normalized slug, so a bare
// "owner/repo" slug, an ssh URL, and an https URL for the same GitHub repo all match the same
// allowlist entry. A target_repo with no derivable slug (a bare local path whose checkout has no
// readable origin remote) falls back to an exact string match against the allowlist entry's raw
// (trimmed) value -- covers local-path allowlist entries verbatim.
function isTargetRepoAllowed(targetRepo: string, allowed: string[]): boolean {
  const targetSlug = normalizeTargetRepoValue(targetRepo).slug;
  const targetTrimmed = targetRepo.trim();
  return allowed.some((entry) => {
    const entryTrimmed = entry.trim();
    if (entryTrimmed === targetTrimmed) return true;
    if (!targetSlug) return false;
    // allowlist-skip-local-path-slug-derivation story: an entry that is clearly a local filesystem
    // path (starts with "/" or "~") can never match by slug -- deriving one would require a real
    // `git -C <entry> remote get-url origin` shell-out (normalizeTargetRepoValue's local-path
    // branch, target-repo-signal.ts) against a checkout that has nothing to do with the target_repo
    // actually being validated. The exact-string check just above already covers local-path entries
    // correctly, so skip slug derivation entirely here -- pure dead-work removal, not a behavior
    // change (a non-matching local path was never going to slug-match anyway).
    if (entryTrimmed.startsWith("/") || entryTrimmed.startsWith("~")) return false;
    const entrySlug = normalizeTargetRepoValue(entry).slug;
    return entrySlug !== null && entrySlug === targetSlug;
  });
}

// Every driver.runTurn() call in this file goes through here instead of calling it directly.
// A TurnTimeoutError means the turn was killed only because it ran long, not because it failed
// -- the SAME input (crucially, the same sessionId) is still a valid thing to try again: for a
// non-null sessionId that's a real --resume against the live conversation; for the very first
// turn (sessionId: null) it's a fresh restart, still strictly better than losing the run
// outright. Any other error (malformed output, non-zero exit, genuine crash) is never retried
// here -- it propagates immediately, unchanged, exactly as before this fix.
async function runTurnResumable(d: Driver, input: DriverInput): Promise<DriverResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TURN_RETRY_LIMIT; attempt++) {
    try {
      return await d.runTurn(input);
    } catch (e) {
      if (!(e instanceof TurnTimeoutError)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

// Resolve the driver for a given run. When runner-agnostic planning was selected at startRun
// (Heimdall routed planning to a non-Claude runtime, and its runtime+model were frozen onto the
// run record), rebuild the matching AgnosticPlanDriver so EVERY turn of this run — initial
// decompose, auto-answered gates, and human-answered resumes — uses the same runtime and its
// live opencode session. Otherwise (the common/default case, and the bulletproof fallback when
// the ported CLI has since gone missing) fall back to the module `driver` — byte-identical to
// the pre-agnostic behavior. A test-injected driver (__setDriverForTest) always wins, since
// resolveAgnosticPlanDriver never fires in test mode so plan_runtime is never set there.
function driverForRecord(record: Pick<RunRecord, "plan_runtime" | "plan_model">): Driver {
  if (record.plan_runtime && record.plan_model && record.plan_runtime.toLowerCase() !== "claude") {
    const agnostic = agnosticPlanDriverFromRecord(record.plan_runtime, record.plan_model);
    if (agnostic) return agnostic;
  }
  return driver;
}

// The DriverInput fields a run's tool descriptor contributes to every turn: where the tool
// surfaces question envelopes. Omitted for the plugin-hive default's own dir and for tools whose
// questions come from the turn response, so a default run's inputs are unchanged.
function toolTurnInput(record: Pick<RunRecord, "tool" | "tool_id">): Pick<DriverInput, "questions_dir"> {
  const dir = questionsDirOf(toolForRecord(record));
  return dir && dir !== questionsDirOf(PLUGIN_HIVE_TOOL) ? { questions_dir: dir } : {};
}

// The forked driver reads questions ONLY from on-disk envelopes, so it cannot drive a tool whose
// questions come back in the turn response. Fail loudly at startRun rather than park forever.
function assertDriverSupportsTool(tool: ToolDescriptor): void {
  if (tool.question_source.kind === "response" && driver instanceof ForkedHiveDriver) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `tool "${tool.id}" has question_source "response", which MINERVA_DRIVER=forked cannot read -- ` +
        `use an "envelope-dir" question_source or another driver`,
    );
  }
}

// Build the initial headless drive prompt. This must PLAN (decompose), never IMPLEMENT: it
// drives plugin-hive's `/plugin-hive:plan` DECOMPOSE skill, which writes an epic +
// dependency-tracked stories into `.pHive/epics/<id>/` -- the filesystem fact
// checkAndMarkComplete keys completion off. The previous `/plugin-hive:kickoff` prompt, under
// the auto-answer loop, drove kickoff's build path: it wrote+committed the feature itself and
// never emitted an epic manifest, so findCompletedEpics stayed empty, the run never marked
// complete, and it parked at waiting_on_human (epic_count:0) -- the plan->commit->push->file
// seam downstream never fired. Headless-safe flags: `--skip-sign-off` drops the user-facing
// sign-off gates; `--lite` drops the collaborative review gate + structured outline (keeps the
// design-discussion artifact). Any residual routine gate is still auto-answered by the
// pre-baked-defaults loop.
//
// That command is the plugin-hive tool descriptor's `invoke` (tool-descriptor.ts), the default
// value of startRun's `tool` parameter; a caller-supplied descriptor brings its own invoke string.
// MINERVA_DRIVE_PROMPT (real config; its original test-seam name MINERVA_TEST_DRIVE_PROMPT still
// works) overrides the default descriptor's invoke -- the automated suite uses it to swap in a
// cheap synthetic prompt. The spawn/resume MECHANISM is identical either way -- only prompt
// content differs.
function buildDrivePrompt(idea: string, defaults: PlanDefaults, tool: ToolDescriptor): string {
  const base = expandInvoke(tool.invoke, idea);
  // Append any operator-configured suffix (e.g. an explicit "skip the sign-off gate"
  // instruction). Empty string when unset -> prompt is byte-identical to before.
  return base + drivePromptSuffix(defaults);
}

// Called after every drive/resume call. Checks completion (a filesystem fact -- see
// output-emitter.ts) BEFORE parsing the schema-forced chat response for a question. The
// combined --json-schema always requires a "question" field, so a turn where plugin-hive's own
// skill has actually finished and written its epic.yaml would otherwise still be forced to
// emit SOME filler question text -- the filesystem check routes around that entirely, ignoring
// whatever the schema-forced response said once completion is detected.
//
// `settle` (PANT-1249) is what a resumed turn commits about itself -- the question it answered,
// the new session_id, the released claim -- written in the SAME locked write that parks the next
// question, so there is no moment where a question is marked answered but nothing is parked and
// nothing holds a claim (the crash window that used to wedge a run in_progress).
export interface TurnSettlement {
  answered?: string;
  patch?: Partial<RunRecord>;
}

export async function recordTurn(runId: string, rawResult: string, settle: TurnSettlement = {}): Promise<void> {
  const settled = (record: RunRecord): Partial<RunRecord> & { questions: Question[] } => ({
    ...settle.patch,
    questions: settle.answered
      ? record.questions.map((q) => (q.id === settle.answered ? { ...q, status: "answered" as const } : q))
      : record.questions,
  });
  if (checkAndMarkComplete(runId)) {
    // Run is terminal (complete or aborted) -- no pending question to append, ever. Optional
    // leftovers of an envelope set can no longer be answered either.
    mutateRunRecord(runId, (record) => {
      const base = settled(record);
      const questions = supersedeClosedSets(base.questions, undefined);
      if (!settle.patch && !settle.answered && questions === record.questions && !record.park) return null;
      return { ...base, questions, park: null };
    });
    return;
  }
  const set = extractQuestionSet(rawResult);
  // Built from the freshest record under the run lock (PANT-904): an abortRun that landed while
  // this turn was in flight wins -- the run stays aborted and no question is parked on it.
  mutateRunRecord(runId, (current) => {
    const base = settled(current);
    if (isTerminalStatus(current.status)) return settle.patch || settle.answered ? { ...base, park: null } : null;
    const record: RunRecord = { ...current, ...base };
    if (set) {
      // PANT-923: the driver surfaced a whole open question set (ForkedHiveDriver's pending
      // envelope). Park every question of it at once. After a sibling is answered the driver
      // re-surfaces the rest of the same set, so a qid already pending in this set is kept as is
      // (its channel may have been escalated since) rather than parked twice.
      const kept = supersedeClosedSets(record.questions, set.set_id);
      const alreadyPending = new Set(
        kept.filter((q) => q.status === "pending" && q.set_id === set.set_id && q.qid).map((q) => q.qid),
      );
      const added: Question[] = [];
      for (const entry of set.entries) {
        if (entry.shape.qid !== undefined && alreadyPending.has(entry.shape.qid)) continue;
        added.push({
          ...buildQuestion(`q-${kept.length + added.length + 1}`, entry.classified, entry.shape),
          set_id: set.set_id,
          required: entry.required,
        });
      }
      return parkOnQuestions(record, base, [...kept, ...added]);
    }
    const id = `q-${record.questions.length + 1}`;
    // Prose drivers park one question per turn (the one-question guard in
    // question-extraction.ts): a set of 1 whose set_id is its own id.
    const question: Question = {
      ...buildQuestion(id, extractClassifiedQuestion(rawResult), extractQuestionShape(rawResult)),
      set_id: id,
    };
    return parkOnQuestions(record, base, [...supersedeClosedSets(record.questions, id), question]);
  });
}

// The patch that parks a run awaiting an answer to its pending questions, opening a new park
// epoch. `record` already carries the turn's settlement (its new session_id).
function parkOnQuestions(record: RunRecord, base: Partial<RunRecord>, questions: Question[]): Partial<RunRecord> {
  const pending = questions.filter((q) => q.status === "pending").map((q) => q.id);
  const patch: Partial<RunRecord> = { ...base, status: "waiting_on_human", questions };
  if (pending.length === 0) return patch;
  return { ...patch, ...openPark(record, { kind: "awaiting-answer", question_id: pending[0]!, open_qids: pending }) };
}

function resumeMethodOf(sessionId: string | null): Park["resume"] {
  if (!sessionId || isEnvelopeHandle(sessionId)) return { method: "state" };
  return { method: "session", session_id: sessionId };
}

function openPark(record: RunRecord, reason: ParkReason): Pick<RunRecord, "park" | "park_epoch"> {
  const epoch = (record.park_epoch ?? 0) + 1;
  return {
    park_epoch: epoch,
    park: { epoch, reason, parked_at: new Date().toISOString(), host: hostname(), resume: resumeMethodOf(record.session_id) },
  };
}

// Park a running run on time or a signal (PANT-1249). The callers that decide WHEN to wait on
// time or a signal are later stories (p3-01, p3-02); this only records the park so resumeRun can
// resume it. The run reads waiting_on_human like any other park; its reason tells the kinds apart.
export function parkRun(runId: string, reason: Exclude<ParkReason, { kind: "awaiting-answer" }>): Park {
  const { record } = mutateRunRecord(runId, (current) => {
    if (isTerminalStatus(current.status)) {
      throw new MinervaError("VALIDATION_FAILED", `Run ${runId} is ${current.status}; a finished run cannot park`);
    }
    return { status: "waiting_on_human", ...openPark(current, reason) };
  });
  return record.park!;
}

function buildQuestion(
  id: string,
  classified: ReturnType<typeof extractClassifiedQuestion>,
  shape: Partial<Pick<Question, "kind" | "options" | "qid">>,
): Question {
  return {
    id,
    text: classified.text,
    suggested_channel: classified.suggested_channel,
    confidence: classified.confidence,
    reason: classified.reason,
    // Enforced channel defaults to the classifier's suggestion (v1: no Vesta/Delphi override
    // exists yet -- see AD-2). WRONG_CHANNEL guards this field, never suggested_channel.
    channel: classified.suggested_channel,
    status: "pending",
    // Structured envelope fields (kind/options/qid) carried through when the driver supplies
    // them (ForkedHiveDriver's envelope-sourced questions do; SpawnDriver/SubagentDriver's prose
    // questions don't). Additive -- undefined for prose questions, which then resolve via the
    // free-text default path. These are what let the auto-answer loop pick a real option for a
    // single/multi-select gate instead of only ever answering free-text.
    ...shape,
  };
}

// An envelope set closes once every required question is answered, and the driver then moves
// on. Its optional questions still pending at that point can never be answered, so they are
// marked superseded when a turn surfaces a different set (or the run ends). Only envelope-set
// questions (those carrying `required`) are touched: a prose question is always answered before
// the next turn runs. Returns the input array unchanged when nothing was superseded.
function supersedeClosedSets(questions: Question[], currentSetId: string | undefined): Question[] {
  const stale = (q: Question) => q.status === "pending" && q.required !== undefined && q.set_id !== currentSetId;
  if (!questions.some(stale)) return questions;
  return questions.map((q) => (stale(q) ? { ...q, status: "superseded" as const } : q));
}

interface QuestionSetEntry {
  classified: ReturnType<typeof extractClassifiedQuestion>;
  shape: Partial<Pick<Question, "kind" | "options" | "qid">>;
  required: boolean;
}

// Parse the open question set a driver may return in raw_result (ForkedHiveDriver:
// `{set_id, questions: [{text, kind, options, qid, required, suggested_channel, confidence,
// reason}]}`). Null when absent or malformed, so the caller falls back to the single-question
// path exactly as before. Each entry goes through the same parsers as a single question.
function extractQuestionSet(rawResult: string): { set_id: string; entries: QuestionSetEntry[] } | null {
  let parsed: any;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.set_id !== "string" || !Array.isArray(parsed.questions)) {
    return null;
  }
  const entries: QuestionSetEntry[] = [];
  for (const q of parsed.questions) {
    if (!q || typeof q !== "object" || typeof q.text !== "string" || q.text.trim().length === 0) continue;
    const entryJson = JSON.stringify({ ...q, question: q.text });
    entries.push({
      classified: extractClassifiedQuestion(entryJson),
      shape: extractQuestionShape(entryJson),
      required: q.required === true,
    });
  }
  return entries.length > 0 ? { set_id: parsed.set_id, entries } : null;
}

// Best-effort parse of the structured envelope fields a driver may embed alongside the question
// text in its raw_result JSON (ForkedHiveDriver does; see its surfaceNextQuestion). Never throws
// -- a non-JSON or field-less raw_result (the SpawnDriver/SubagentDriver prose case) yields an
// empty object, leaving the Question free-text-shaped exactly as before.
function extractQuestionShape(rawResult: string): Partial<Pick<Question, "kind" | "options" | "qid">> {
  let parsed: any;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const shape: Partial<Pick<Question, "kind" | "options" | "qid">> = {};
  if (parsed.kind !== undefined) shape.kind = normalizeQuestionKind(parsed.kind);
  if (Array.isArray(parsed.options) && parsed.options.every((o: unknown) => typeof o === "string")) {
    shape.options = parsed.options as string[];
  } else if (parsed.options === null) {
    shape.options = null;
  }
  if (typeof parsed.qid === "string") shape.qid = parsed.qid;
  return shape;
}

// The pre-baked-defaults auto-answer loop (prebaked-plan-defaults epic). Called after every
// drive/resume turn. While the current run has a pending question for which the run's frozen
// plan-defaults config resolves a pre-decided answer, it supplies that answer through the SAME
// mark-answered + re-drive path submitAnswers uses -- there is no separate "autonomous progress"
// mechanism, just an operator's pre-decided answers delivered without a live human keystroke.
//
// It STOPS (leaving the run parked as waiting_on_human, exactly as before) the moment it hits a
// question with no resolvable default -- a genuine strategic gate that still needs a human
// (AD-5 preserved) -- or the run completes, or the max_auto_answers guardrail trips. This is the
// whole reason a fresh headless idea-build no longer hangs on the first routine gate: those
// gates now get answered from the config instead of waiting forever for a submitAnswers call.
async function autoAnswerLoop(runId: string): Promise<void> {
  const initial = readRunRecord(runId);
  const defaults: PlanDefaults = initial.defaults ?? loadPlanDefaults();
  if (defaults.mode === "off") return; // feature disabled -- classic park-every-question behavior

  let answered = 0;
  while (answered < defaults.max_auto_answers) {
    const record = readRunRecord(runId);
    if (record.status === "complete" || record.status === "aborted") return;

    const pending = record.questions.find((q) => q.status === "pending");
    if (!pending) return; // nothing to answer (shouldn't happen while waiting_on_human, but safe)

    const answer = resolveDefaultAnswer(pending, defaults, record.idea ?? "");
    if (answer === null) {
      // An agent-routed question without a matching default is no longer useful on the agent
      // queue: the driver cannot answer it, so escalate it to the human queue and leave it parked.
      if (pending.channel === "agent") {
        const escalatedQuestions = record.questions.map((q) =>
          q.id === pending.id ? { ...q, channel: "human" as const } : q,
        );
        updateRunRecord(runId, { questions: escalatedQuestions, status: "waiting_on_human" });
      }
      return;
    }

    // Delivered through the SAME claim -> turn -> settle path submitAnswers uses (its own "No
    // Autonomous Progress" advancement path). The pre-baked answer is the operator's, supplied
    // ahead of time. A run whose session is gone is rebuilt from state, as for a human answer.
    const delivered = await resumeWithAnswer(runId, pending.id, pending.channel, answer);
    if (delivered.outcome !== "resumed") return;
    recordAutoResolution(runId);
    answered++;
  }
  // Guardrail tripped: leave whatever recordTurn last set (waiting_on_human or complete). Bounded,
  // never an infinite loop -- a pathological run parks for a human rather than spinning forever.
}

export async function startRun(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const idea = params.idea;
  if (typeof idea !== "string" || idea.length === 0) {
    throw new MinervaError("VALIDATION_FAILED", "startRun requires a non-empty string `idea`");
  }
  const explicitRepo = typeof params.target_repo === "string" ? params.target_repo : undefined;

  // The planning tool this run drives (tool-descriptor.ts). Omitted => plugin-hive, today's
  // behavior. Validated before anything is allocated; frozen onto the run record by allocateRun so
  // every continuation turn resolves the same tool.
  const tool = resolveTool(params.tool);
  assertDriverSupportsTool(tool);

  // Resolve a REAL build-target repo for this seed (PAN-6745 autonomy unlock). An explicit
  // target_repo wins; otherwise god-scoped work maps to that god's repo, and greenfield work
  // falls back to a configured incubator repo. Only when nothing at all is configured does this
  // return undefined, preserving the legacy fresh_init behavior. Resolving a real repo is what
  // lets the finished plan be committed + pushed somewhere a build agent can check it out, instead
  // of being stranded in a throwaway fresh_init scratch that is never pushed anywhere.
  const resolved = resolveTargetRepo({ explicit: explicitRepo, idea });
  const targetRepo = resolved.repo;

  // target-repo-allowlist story: gate the resolved target_repo against MINERVA_ALLOWED_TARGET_
  // REPOS, when configured, BEFORE any worktree/clone operation (allocateRun below is the first
  // such operation). No-op when the env var is unset (resolveAllowedTargetRepos returns null) or
  // when nothing resolved a target_repo at all (nothing to gate).
  if (targetRepo) {
    const allowedTargetRepos = resolveAllowedTargetRepos();
    if (allowedTargetRepos && !isTargetRepoAllowed(targetRepo, allowedTargetRepos)) {
      throw new MinervaError(
        "VALIDATION_FAILED",
        `target_repo "${targetRepo}" is not in the configured MINERVA_ALLOWED_TARGET_REPOS allowlist`,
      );
    }
  }

  // Resolve the effective pre-baked-defaults config once, here, from built-in + env + the
  // per-run `defaults` override, and freeze it onto the run record (prebaked-plan-defaults epic).
  // Every subsequent auto-answer turn uses this same frozen config.
  const defaults = loadPlanDefaults(params.defaults);

  const { run_id: runId } = allocateRun(idea, targetRepo, defaults, resolved.source, tool);

  // Runner-agnostic planning (agnostic-plan-driver.ts): ask Heimdall which runtime should serve
  // planning. When it routes to a non-Claude runtime AND the ported entrypoint + opencode are
  // present, freeze that runtime+model onto the run record so driverForRecord() drives every turn
  // through the ported `/plugin-hive:plan` DECOMPOSE flow on that runtime. resolveAgnosticPlanDriver
  // returns null on ANY doubt (feature off, test mode, Heimdall down, claude route, missing
  // CLI/opencode) — in which case this is a no-op and the built-in claude driver runs, so planning
  // never breaks on an unavailable route or port.
  // The agnostic route only serves the stock plugin-hive invocation; any other tool, or a
  // configured drive-prompt override, keeps the built-in driver.
  const stockPluginHive = tool.id === PLUGIN_HIVE_TOOL.id && tool.invoke === PLUGIN_HIVE_TOOL.invoke;
  const planDriver = stockPluginHive ? await resolveAgnosticPlanDriver() : null;
  if (planDriver) {
    updateRunRecord(runId, { plan_runtime: planDriver.runtime, plan_model: planDriver.model });
    updateRunMetricsDriver(runId, planDriver.runtime);
  }

  // On the agnostic path the driver's first turn wants the bare idea (the ported CLI wraps it in
  // the DECOMPOSE contract); the claude path keeps the native `/plugin-hive:plan …` slash command.
  // Persisted so a run whose session is later gone can be rebuilt from it (PANT-1249).
  const drivePrompt = planDriver ? idea : buildDrivePrompt(idea, defaults, tool);
  const record = updateRunRecord(runId, { drive_prompt: drivePrompt });
  const driver = driverForRecord(record);

  // auto-cleanup-orphaned-runs-on-first-turn-failure: allocateRun() above already durably wrote
  // this run's record (status "in_progress") and its workspace/worktree, BEFORE this very first
  // drive turn is attempted. If this turn throws (any error -- e.g. the HeimdallRouteError the
  // fix-heimdall-route-fail-fast-with-fallback story now throws when routing fails with no
  // operator fallback configured), the run would otherwise be left permanently stuck at
  // "in_progress" with no ledger entry -- an orphan. This run has not yet reached
  // "waiting_on_human" -- no question has ever been surfaced -- so it has no human-facing state
  // to preserve, and auto-terminating it here is not the kind of autonomous forward-advancement
  // "No Autonomous Progress" / AD-5's stall invariant guard against: it happens synchronously,
  // inside this same failed startRun() call, not on a later autonomous tick (see this story's
  // spec / design-discussion.md §3d). abortRun()/recordCleanup() (cleanup-ledger.ts) is the
  // existing, idempotent, AD-4-compliant mechanism (record + signal only, never deletes
  // workspace_path/state_path) -- reused here unmodified. The original error is always re-thrown
  // after cleanup so the caller still learns the run failed, never silence. This hook must NEVER
  // be applied to any later-turn failure (e.g. inside submitAnswers, after waiting_on_human has
  // been reached) -- that is a stall, explicitly protected by AD-5 and out of scope here.
  let sessionId: string;
  let rawResult: string;
  let routeDecision: DriverResult["route_decision"];
  let route: DriverResult["route"];
  try {
    ({ session_id: sessionId, raw_result: rawResult, route_decision: routeDecision, route } = await runTurnResumable(driver, {
      cwd: record.workspace_path,
      sessionId: null,
      prompt: drivePrompt,
      ...toolTurnInput(record),
    }));
  } catch (err) {
    abortRun({ run_id: runId });
    throw err;
  }
  recordDriverTurn(runId, routeDecision, laneOf(route));

  // Persisted after EVERY turn, not just here at start -- see driver.ts's Driver contract note.
  updateRunRecord(runId, { session_id: sessionId });
  await recordTurn(runId, rawResult);

  // Auto-answer any routine gate questions from the pre-baked defaults so a fresh headless run
  // drives itself forward instead of hanging on the first gate. No-op when mode is "off".
  await autoAnswerLoop(runId);
  recordHumanEscalations(runId);

  return { run_id: runId };
}

export function getQuestions(params: Record<string, unknown>): Record<string, unknown> {
  const runId = params.run_id;
  const channel = params.channel;
  if (typeof runId !== "string") {
    throw new MinervaError("VALIDATION_FAILED", "getQuestions requires a string run_id");
  }
  if (channel !== "agent" && channel !== "human") {
    throw new MinervaError("VALIDATION_FAILED", 'getQuestions requires channel "agent" or "human"');
  }
  // Escalations are counted once when a question is parked on the human queue
  // (recordHumanEscalations, after each drive), never per read -- polling must not inflate them.
  // The only write a read can make is releasing a resume claim whose process died (PANT-1249).
  const record = releaseAbandonedResume(runId);
  // A question a live resume is delivering right now is no longer waiting on anyone.
  const delivering = isLiveResumeClaim(record.resuming) ? record.resuming.question_id : undefined;
  const questions = record.questions.filter(
    (q) => q.status === "pending" && q.channel === channel && q.id !== delivering,
  );
  return { questions };
}

interface Answer {
  question_id: string;
  // string for single-select/free-text; string[] for multi-select (question-envelope-schema.md
  // §"Question object fields" -- "Array for multi-select, string otherwise").
  answer: string | string[];
}

function isValidAnswerValue(value: unknown): value is string | string[] {
  return typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"));
}

// Exported for docs-contract.test.ts, which checks the documented submitAnswers example against it.
export function isAnswerArray(value: unknown): value is Answer[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a) => a && typeof a === "object" && typeof (a as any).question_id === "string" && isValidAnswerValue((a as any).answer),
    )
  );
}

// --- Resume (PANT-1249, p2-02) ---------------------------------------------------------------
//
// Every way a parked run moves again -- a human or agent answer (submitAnswers), a pre-baked
// answer (autoAnswerLoop), time passing or a signal arriving (resumeRun) -- goes through one
// path, in this order:
//
//   1. claim: under the run lock, release a claim whose process died, decide the outcome
//      (already_resumed / stale_handle / refused / claimed), else write the claim and set the run
//      in_progress. The question stays pending; nothing is marked delivered yet.
//   2. turn: resume the provider session; when it no longer resolves (or the run never had one),
//      rebuild from state_ref -- the run's worktree -- by re-issuing the original drive prompt.
//   3. settle: one locked write marks the question answered, stores the new session_id,
//      releases the claim and parks the next question (recordTurn's `settle`).
//
// A crash anywhere before 3 leaves the question pending under a dead claim, which the next read
// releases: the run is recoverable, never wedged. A failed turn releases the claim at once.

type ResumeEvidence = { observed_at: string; signal_key?: string; detail?: Record<string, unknown> };

type ResumeItem =
  | { kind: "answer"; question: Question; answer: string | string[] }
  | { kind: "cause"; cause: "time" | "signal"; evidence: ResumeEvidence };

function epochOf(record: RunRecord): number {
  return record.park?.epoch ?? record.park_epoch ?? 0;
}

// Driver.runTurn's prompt is always a plain string -- a multi-select answer (string[]) is joined
// into readable prose, matching how a human would phrase multiple selections in a chat message.
function answerText(answer: string | string[]): string {
  return Array.isArray(answer) ? answer.join(", ") : answer;
}

function causeText(item: Extract<ResumeItem, { kind: "cause" }>): string {
  const what =
    item.cause === "time"
      ? "the time it was waiting for has passed"
      : `the signal it was waiting for${item.evidence.signal_key ? ` (${item.evidence.signal_key})` : ""} has arrived`;
  const detail = item.evidence.detail ? ` Detail: ${JSON.stringify(item.evidence.detail)}.` : "";
  return `This run was parked waiting on ${item.cause}; ${what} (observed at ${item.evidence.observed_at}).${detail} Continue from where you left off.`;
}

// The prompt the run started with. Records written before drive_prompt existed rebuild it from
// the frozen idea, defaults and tool, exactly as startRun built it.
function drivePromptOf(record: RunRecord): string {
  if (record.drive_prompt) return record.drive_prompt;
  const idea = record.idea ?? "";
  if (record.plan_runtime && record.plan_runtime.toLowerCase() !== "claude") return idea;
  return buildDrivePrompt(idea, record.defaults ?? loadPlanDefaults(), toolForRecord(record));
}

// The degraded path (mandatory in the lifecycle contract): a fresh turn in the run's worktree,
// re-issuing the drive prompt so the planning skill re-reads its own on-disk progress, plus what
// is being delivered. state_ref is file-local, so this works only on the host that parked the run.
function rebuildInput(record: RunRecord, item: ResumeItem): DriverInput {
  if (!existsSync(record.workspace_path)) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `Run ${record.run_id} cannot be rebuilt: its session is gone and its workspace ${record.workspace_path} ` +
        `no longer exists on this host. Its state is file-local, so it can only resume where it parked.`,
    );
  }
  const delivered =
    item.kind === "answer"
      ? `The question "${item.question.text}" has been answered: ${answerText(item.answer)}`
      : causeText(item);
  return {
    cwd: record.workspace_path,
    sessionId: null,
    prompt:
      `${drivePromptOf(record)}\n\nResuming this run from its on-disk state: the earlier session could not ` +
      `be resumed. Your progress so far is in this workspace; continue from it. ${delivered}`,
    ...toolTurnInput(record),
  };
}

// The resume attempt on the run's own session, or null when there is none to use: no session_id
// at all, or a cause resume of a forked run (its envelope pointer only knows how to take an answer).
function sessionInput(record: RunRecord, item: ResumeItem): DriverInput | null {
  if (!record.session_id) return null;
  if (item.kind === "cause" && isEnvelopeHandle(record.session_id)) return null;
  return {
    cwd: record.workspace_path,
    sessionId: record.session_id,
    prompt: item.kind === "answer" ? answerText(item.answer) : causeText(item),
    ...(item.kind === "answer" ? { qid: item.question.qid } : {}),
    ...toolTurnInput(record),
  };
}

function releaseClaim(runId: string, claim: ResumeClaim): void {
  mutateRunRecord(runId, (record) =>
    record.resuming?.pid === claim.pid && record.resuming.started_at === claim.started_at
      ? { resuming: null, status: "waiting_on_human" }
      : null,
  );
}

// Steps 2 and 3, for a run whose claim is already written. Returns how the turn reattached.
async function driveClaimedResume(record: RunRecord, claim: ResumeClaim, item: ResumeItem): Promise<"session" | "state"> {
  const d = driverForRecord(record);
  let result: DriverResult | null = null;
  let resumedVia: "session" | "state" = "state";
  try {
    const viaSession = sessionInput(record, item);
    if (viaSession) {
      try {
        result = await runTurnResumable(d, viaSession);
        resumedVia = isEnvelopeHandle(record.session_id!) ? "state" : "session";
      } catch (err) {
        if (!isSessionGoneError(err)) throw err;
      }
    }
    if (!result) result = await runTurnResumable(d, rebuildInput(record, item));
  } catch (err) {
    // The turn never happened, so nothing was delivered: release the claim and the run is parked
    // again on the same question (PANT-903). The caller still gets the error.
    releaseClaim(record.run_id, claim);
    throw err;
  }
  recordDriverTurn(record.run_id, result.route_decision, laneOf(result.route));
  await recordTurn(record.run_id, result.raw_result, {
    answered: item.kind === "answer" ? item.question.id : undefined,
    patch: { session_id: result.session_id, resuming: null, park: null, last_resumed_epoch: claim.epoch },
  });
  return resumedVia;
}

interface ClaimVerdict {
  result?: Record<string, unknown>;
  claim?: ResumeClaim;
  record?: RunRecord;
}

// Step 1 for an answer, then steps 2 and 3. Shared by submitAnswers and autoAnswerLoop.
async function resumeWithAnswer(
  runId: string,
  questionId: string,
  channel: Channel,
  answer: string | string[],
): Promise<Record<string, unknown>> {
  const verdict: ClaimVerdict = {};
  mutateRunRecord(runId, (current) => {
    const recovery = abandonedClaimPatch(current);
    const record: RunRecord = { ...current, ...recovery };
    const question = record.questions.find((q) => q.id === questionId);
    if (!question) {
      throw new MinervaError("NOT_FOUND", `No question ${questionId} on run ${runId}`);
    }
    if (question.channel !== channel) {
      throw new MinervaError("WRONG_CHANNEL", `Question ${questionId} is on channel "${question.channel}", not "${channel}"`);
    }
    const epoch = epochOf(record);
    if (question.status === "answered") {
      verdict.result = { outcome: "already_resumed", run_id: runId, park_epoch: record.last_resumed_epoch ?? epoch };
      return recovery;
    }
    if (question.status === "superseded" || isTerminalStatus(record.status)) {
      // The park this answer was meant for is gone. Record the answer, never apply or drop it.
      const recorded_at = new Date().toISOString();
      const why = isTerminalStatus(record.status) ? `run is ${record.status}` : "question was superseded";
      verdict.result = { outcome: "stale_handle", run_id: runId, park_epoch: epoch, recorded_at };
      return {
        ...recovery,
        stale_answers: [...(record.stale_answers ?? []), { question_id: questionId, answer, received_at: recorded_at, reason: why }],
      };
    }
    if (isLiveResumeClaim(record.resuming)) {
      verdict.result =
        record.resuming.question_id === questionId
          ? { outcome: "already_resumed", run_id: runId, park_epoch: record.resuming.epoch }
          : { outcome: "claimed", run_id: runId, park_epoch: record.resuming.epoch, claimed_by: claimOwner(record.resuming) };
      return recovery;
    }
    verdict.claim = newResumeClaim(epoch, { question_id: questionId });
    verdict.record = { ...record, resuming: verdict.claim, status: "in_progress" };
    return { ...recovery, resuming: verdict.claim, status: "in_progress" };
  });
  if (verdict.result) return verdict.result;
  const record = verdict.record!;
  const question = record.questions.find((q) => q.id === questionId)!;
  const resumedVia = await driveClaimedResume(record, verdict.claim!, { kind: "answer", question, answer });
  return { outcome: "resumed", run_id: runId, park_epoch: verdict.claim!.epoch, resumed_via: resumedVia };
}

export async function submitAnswers(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = params.run_id;
  const channel = params.channel as Channel | undefined;
  const answers = params.answers;

  if (typeof runId !== "string") {
    throw new MinervaError("VALIDATION_FAILED", "submitAnswers requires a string run_id");
  }
  if (channel !== "agent" && channel !== "human") {
    throw new MinervaError("VALIDATION_FAILED", 'submitAnswers requires channel "agent" or "human"');
  }
  if (!isAnswerArray(answers) || answers.length === 0) {
    throw new MinervaError("VALIDATION_FAILED", "submitAnswers requires a non-empty answers array of {question_id, answer}");
  }
  // PANT-903 / PANT-1249: an answer set is accepted whole or refused whole, never truncated. The
  // engine delivers one answer per turn and cannot stage the rest of a set, so a set of more than
  // one is refused whole -- before anything is read or written (staging is PANT-925).
  if (answers.length > 1) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `submitAnswers got ${answers.length} answers; the set is refused whole and nothing was applied. ` +
        `Submit one answer per call (staging a set is PANT-925).`,
    );
  }
  const { question_id: questionId, answer } = answers[0] as Answer;

  const result = await resumeWithAnswer(runId, questionId, channel, answer);
  if (result.outcome === "resumed") {
    // After a human (or agent) answers an escalated question, resume auto-answering any further
    // routine gates from the pre-baked defaults, so answering one strategic question doesn't
    // leave the run stalled on the next mechanical one. No-op when mode is "off".
    await autoAnswerLoop(runId);
    recordHumanEscalations(runId);
  }
  // `result: {}` is kept for callers written against the earlier empty reply.
  return { result: {}, ...result };
}

function isResumeEvidence(value: unknown): value is ResumeEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.observed_at !== "string" || Number.isNaN(Date.parse(e.observed_at))) return false;
  if (e.signal_key !== undefined && (typeof e.signal_key !== "string" || e.signal_key.length === 0)) return false;
  return e.detail === undefined || (typeof e.detail === "object" && e.detail !== null && !Array.isArray(e.detail));
}

// Why a cause does not fit the open park (the contract's resumeFits); empty when it does.
function causeProblems(record: RunRecord, cause: "time" | "signal", evidence: ResumeEvidence): string[] {
  const park = record.park;
  if (!park || record.status !== "waiting_on_human") return [`run ${record.run_id} is not parked (status ${record.status})`];
  const reason = park.reason;
  if (reason.kind === "awaiting-answer") {
    return [`run is parked awaiting an answer to ${reason.question_id}; answer it with submitAnswers`];
  }
  if (reason.kind === "awaiting-time") {
    if (cause !== "time") return [`run is parked awaiting time, not a ${cause}`];
    if (Date.parse(evidence.observed_at) < Date.parse(reason.not_before)) {
      return [`observed_at ${evidence.observed_at} is before the park's not_before ${reason.not_before}`];
    }
    return [];
  }
  if (cause !== "signal") return [`run is parked awaiting signal ${reason.signal_key}, not ${cause}`];
  if (evidence.signal_key !== undefined && evidence.signal_key !== reason.signal_key) {
    return [`signal ${evidence.signal_key} is not the park's signal ${reason.signal_key}`];
  }
  return [];
}

// Resume a run parked on time or a signal, with no answer (PANT-1249). Idempotent on
// (run_id, park_epoch): pass the park_epoch the caller saw, and a repeat returns already_resumed
// without driving a second turn.
export async function resumeRun(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = params.run_id;
  const cause = params.cause;
  const evidence = params.evidence;
  const parkEpoch = params.park_epoch;
  if (typeof runId !== "string") {
    throw new MinervaError("VALIDATION_FAILED", "resumeRun requires a string run_id");
  }
  if (cause !== "time" && cause !== "signal") {
    throw new MinervaError("VALIDATION_FAILED", 'resumeRun requires cause "time" or "signal" (answers go to submitAnswers)');
  }
  if (!isResumeEvidence(evidence)) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      "resumeRun requires evidence {observed_at: ISO timestamp, signal_key?: string, detail?: object}",
    );
  }
  if (parkEpoch !== undefined && (!Number.isInteger(parkEpoch) || (parkEpoch as number) < 0)) {
    throw new MinervaError("VALIDATION_FAILED", "resumeRun park_epoch must be a non-negative integer");
  }

  const verdict: ClaimVerdict = {};
  mutateRunRecord(runId, (current) => {
    const recovery = abandonedClaimPatch(current);
    const record: RunRecord = { ...current, ...recovery };
    const epoch = (parkEpoch as number | undefined) ?? epochOf(record);
    if (parkEpoch !== undefined && (record.last_resumed_epoch ?? 0) >= epoch) {
      verdict.result = { outcome: "already_resumed", run_id: runId, park_epoch: epoch };
      return recovery;
    }
    if (isTerminalStatus(record.status) || (parkEpoch !== undefined && record.park?.epoch !== epoch)) {
      verdict.result = { outcome: "stale_handle", run_id: runId, park_epoch: epoch, recorded_at: new Date().toISOString() };
      return recovery;
    }
    if (isLiveResumeClaim(record.resuming)) {
      verdict.result =
        record.resuming.cause === cause && record.resuming.epoch === epoch
          ? { outcome: "already_resumed", run_id: runId, park_epoch: epoch }
          : { outcome: "claimed", run_id: runId, park_epoch: epoch, claimed_by: claimOwner(record.resuming) };
      return recovery;
    }
    const problems = causeProblems(record, cause, evidence);
    if (problems.length > 0) {
      verdict.result = { outcome: "refused", run_id: runId, park_epoch: epoch, problems };
      return recovery;
    }
    verdict.claim = newResumeClaim(epoch, { cause });
    verdict.record = { ...record, resuming: verdict.claim, status: "in_progress" };
    return { ...recovery, resuming: verdict.claim, status: "in_progress" };
  });
  if (verdict.result) return verdict.result;

  const resumedVia = await driveClaimedResume(verdict.record!, verdict.claim!, { kind: "cause", cause, evidence });
  await autoAnswerLoop(runId);
  recordHumanEscalations(runId);
  return { outcome: "resumed", run_id: runId, park_epoch: verdict.claim!.epoch, resumed_via: resumedVia };
}
