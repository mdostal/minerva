// Kickoff+Plan Engine — headless claude -p drive/resume plumbing, composed with real question
// extraction + escalation classification (see question-extraction.ts and
// escalation-classification.ts) in one combined --json-schema call. See docs/architecture.md
// "No Autonomous Progress" and AD-2.

import { MinervaError } from "./errors.ts";
import { allocateRun, readRunRecord, updateRunRecord, normalizeQuestionKind, type Question, type Channel, type RunRecord } from "./run-manager.ts";
import { extractClassifiedQuestion } from "./escalation-classification.ts";
import { checkAndMarkComplete } from "./output-emitter.ts";
import { SpawnDriver, SubagentDriver, ForkedHiveDriver, TurnTimeoutError, type Driver, type DriverInput, type DriverResult } from "./driver.ts";
import { postQuestionToConsusDecisionApi } from "./consus-decisions.ts";
import { resolveAgnosticPlanDriver, resolvePlanningRoute, agnosticPlanDriverFromRecord, type AgnosticPlanDriver } from "./agnostic-plan-driver.ts";
import { loadPlanDefaults, resolveDefaultAnswer, drivePromptSuffix, type PlanDefaults } from "./plan-defaults.ts";
import { resolveTargetRepo } from "./repo-resolution.ts";

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
// Test seam: MINERVA_TEST_DRIVE_PROMPT swaps this real skill prompt for a cheap synthetic one so
// the automated suite doesn't drive a full real plan (slow, costly, many gates) on every run.
// The spawn/resume MECHANISM is identical either way -- only prompt content differs.
function buildDrivePrompt(idea: string, defaults: PlanDefaults): string {
  const override = process.env.MINERVA_TEST_DRIVE_PROMPT;
  const base = override
    ? override.replace(/\{idea\}/g, idea)
    : `/plugin-hive:plan ${idea} --skip-sign-off --lite`;
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
export async function recordTurn(runId: string, rawResult: string): Promise<void> {
  if (checkAndMarkComplete(runId)) {
    return; // run is complete -- no pending question to append, ever
  }
  const record = readRunRecord(runId);
  const classified = extractClassifiedQuestion(rawResult);
  const shape = extractQuestionShape(rawResult);
  const question: Question = {
    id: `q-${record.questions.length + 1}`,
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
  updateRunRecord(runId, {
    status: "waiting_on_human",
    questions: [...record.questions, question],
  });

  const posted = await postQuestionToConsusDecisionApi(runId, question);
  if (posted.posted) {
    const patch: Partial<import("./run-manager.ts").RunRecord> = { status: "awaiting-consus" };
    if (posted.consus_question_id) {
      const current = readRunRecord(runId);
      const updatedQuestions = current.questions.map((q) =>
        q.id === question.id ? { ...q, consus_question_id: posted.consus_question_id } : q
      );
      patch.questions = updatedQuestions;
    }
    updateRunRecord(runId, patch);
  }
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
    if (answer === null) return; // no pre-baked default -> genuine human gate; leave it parked

    if (!record.session_id) return; // no live session to resume against -- cannot drive further

    // Mark answered + re-drive, mirroring submitAnswers exactly (its own "No Autonomous Progress"
    // advancement path). The pre-baked answer is the operator's, supplied ahead of time.
    const updatedQuestions = record.questions.map((q) =>
      q.id === pending.id ? { ...q, status: "answered" as const } : q,
    );
    updateRunRecord(runId, { questions: updatedQuestions, status: "in_progress" });

    const answerPrompt = Array.isArray(answer) ? answer.join(", ") : answer;
    const { session_id, raw_result } = await runTurnResumable(driverForRecord(record), {
      cwd: record.workspace_path,
      sessionId: record.session_id,
      prompt: answerPrompt,
    });
    updateRunRecord(runId, { session_id });
    recordTurn(runId, raw_result);
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

  // Resolve a REAL build-target repo for this seed (PAN-6745 autonomy unlock). An explicit
  // target_repo wins; otherwise god-scoped work maps to that god's repo, and greenfield work
  // falls back to a configured incubator repo. Only when nothing at all is configured does this
  // return undefined, preserving the legacy fresh_init behavior. Resolving a real repo is what
  // lets the finished plan be committed + pushed somewhere a build agent can check it out, instead
  // of being stranded in a throwaway fresh_init scratch that is never pushed anywhere.
  const resolved = resolveTargetRepo({ explicit: explicitRepo, idea });
  const targetRepo = resolved.repo;

  // Resolve the effective pre-baked-defaults config once, here, from built-in + env + the
  // per-run `defaults` override, and freeze it onto the run record (prebaked-plan-defaults epic).
  // Every subsequent auto-answer turn uses this same frozen config.
  const defaults = loadPlanDefaults(params.defaults);

  const { run_id: runId } = allocateRun(idea, targetRepo, defaults, resolved.source);

  // Runner-agnostic planning (agnostic-plan-driver.ts): ask Heimdall which runtime should serve
  // planning. When it routes to a non-Claude runtime AND the ported entrypoint + opencode are
  // present, freeze that runtime+model onto the run record so driverForRecord() drives every turn
  // through the ported `/plugin-hive:plan` DECOMPOSE flow on that runtime. resolveAgnosticPlanDriver
  // returns null on ANY doubt (feature off, test mode, Heimdall down, claude route, missing
  // CLI/opencode) — in which case this is a no-op and the built-in claude driver runs, so planning
  // never breaks on an unavailable route or port.
  const planDriver = await resolveAgnosticPlanDriver();
  if (planDriver) {
    updateRunRecord(runId, { plan_runtime: planDriver.runtime, plan_model: planDriver.model });
  }

  const record = readRunRecord(runId);
  const driver = driverForRecord(record);

  // On the agnostic path the driver's first turn wants the bare idea (the ported CLI wraps it in
  // the DECOMPOSE contract); the claude path keeps the native `/plugin-hive:plan …` slash command.
  const drivePrompt = planDriver ? idea : buildDrivePrompt(idea, defaults);
  const { session_id: sessionId, raw_result: rawResult } = await runTurnResumable(driver, {
    cwd: record.workspace_path,
    sessionId: null,
    prompt: drivePrompt,
  });

  // Persisted after EVERY turn, not just here at start -- see driver.ts's Driver contract note.
  updateRunRecord(runId, { session_id: sessionId });
  await recordTurn(runId, rawResult);

  // Auto-answer any routine gate questions from the pre-baked defaults so a fresh headless run
  // drives itself forward instead of hanging on the first gate. No-op when mode is "off".
  await autoAnswerLoop(runId);

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
  const record = readRunRecord(runId);
  const questions = record.questions.filter((q) => q.status === "pending" && q.channel === channel);
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

function isAnswerArray(value: unknown): value is Answer[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a) => a && typeof a === "object" && typeof (a as any).question_id === "string" && isValidAnswerValue((a as any).answer),
    )
  );
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

  const record = readRunRecord(runId);
  const firstAnswer = answers[0] as Answer;
  const { question_id: questionId, answer } = firstAnswer;
  const question = record.questions.find((q) => q.id === questionId && q.status === "pending");

  if (!question) {
    throw new MinervaError("NOT_FOUND", `No pending question ${questionId} on run ${runId}`);
  }
  if (question.channel !== channel) {
    throw new MinervaError(
      "WRONG_CHANNEL",
      `Question ${questionId} is on channel "${question.channel}", not "${channel}"`,
    );
  }
  if (!record.session_id) {
    throw new MinervaError("VALIDATION_FAILED", `Run ${runId} has no active drive session to resume`);
  }

  // Mark answered BEFORE resuming -- this is the run's only advancement path (see
  // "No Autonomous Progress" in docs/architecture.md). Nothing else may flip a question's
  // status or re-drive the session.
  const updatedQuestions = record.questions.map((q) => (q.id === questionId ? { ...q, status: "answered" as const } : q));
  updateRunRecord(runId, { questions: updatedQuestions, status: "in_progress" });

  // Driver.runTurn's prompt is always a plain string -- a multi-select answer (string[]) is
  // joined into readable prose for the driven turn, matching how a human would phrase multiple
  // selections in a chat message.
  const answerPrompt = Array.isArray(answer) ? answer.join(", ") : answer;
  const { session_id: newSessionId, raw_result: rawResult } = await runTurnResumable(driverForRecord(record), {
    cwd: record.workspace_path,
    sessionId: record.session_id,
    prompt: answerPrompt,
  });
  // Persisted after EVERY turn -- SpawnDriver's resumed session_id happens to stay constant in
  // practice, but the contract doesn't assume that (SubagentDriver's does change per turn).
  updateRunRecord(runId, { session_id: newSessionId });
  await recordTurn(runId, rawResult);

  // After a human (or agent) answers an escalated question, resume auto-answering any further
  // routine gates from the pre-baked defaults, so answering one strategic question doesn't leave
  // the run stalled on the next mechanical one. No-op when mode is "off".
  await autoAnswerLoop(runId);

  return { result: {} };
}
