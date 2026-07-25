// Kickoff+Plan Engine — headless claude -p drive/resume plumbing, composed with real question
// extraction + escalation classification (see question-extraction.ts and
// escalation-classification.ts) in one combined --json-schema call. See docs/architecture.md
// "No Autonomous Progress" and AD-2.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { MinervaError } from "./errors.ts";
import { allocateRun, readRunRecord, updateRunRecord, type Question, type Channel } from "./run-manager.ts";
import { classificationSchemaArgs, extractClassifiedQuestion } from "./escalation-classification.ts";

const MODEL = process.env.MINERVA_DRIVE_MODEL ?? "claude-haiku-4-5-20251001";
const CLAUDE_TIMEOUT_MS = 120_000;

interface ClaudePResult {
  is_error: boolean;
  stop_reason: string;
  session_id: string;
  result: string;
}

// Test seam: swap the real `/plugin-hive:kickoff {idea}` prompt for a cheap synthetic one so
// the automated suite doesn't drive a full real kickoff (slow, costly, many gates) on every
// run. The spawn/resume MECHANISM is identical either way -- only prompt content differs. The
// real prompt is exercised by manual confirmation (see this story's review notes), and by the
// Risk-A spike this engine directly reuses (docs/spike-plugin-hive-drivability-findings.md).
function buildDrivePrompt(idea: string): string {
  const override = process.env.MINERVA_TEST_DRIVE_PROMPT;
  if (override) return override.replace(/\{idea\}/g, idea);
  return `/plugin-hive:kickoff ${idea}`;
}

function spawnClaude(cwd: string, args: string[]): ClaudePResult {
  const out = execFileSync(
    "claude",
    ["-p", "--model", MODEL, "--output-format", "json", "--permission-mode", "bypassPermissions", ...args],
    { encoding: "utf8", timeout: CLAUDE_TIMEOUT_MS, cwd },
  );
  return JSON.parse(out) as ClaudePResult;
}

function appendQuestion(runId: string, rawResult: string): void {
  const record = readRunRecord(runId);
  const classified = extractClassifiedQuestion(rawResult);
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
  };
  updateRunRecord(runId, {
    status: "waiting_on_human",
    questions: [...record.questions, question],
  });
}

export function startRun(params: Record<string, unknown>): Record<string, unknown> {
  const idea = params.idea;
  if (typeof idea !== "string" || idea.length === 0) {
    throw new MinervaError("VALIDATION_FAILED", "startRun requires a non-empty string `idea`");
  }
  const targetRepo = typeof params.target_repo === "string" ? params.target_repo : undefined;

  const { run_id: runId } = allocateRun(idea, targetRepo);
  const record = readRunRecord(runId);

  const sessionId = randomUUID();
  const drivePrompt = buildDrivePrompt(idea);
  const claudeResult = spawnClaude(record.workspace_path, [
    "--session-id",
    sessionId,
    ...classificationSchemaArgs(),
    drivePrompt,
  ]);

  updateRunRecord(runId, { session_id: sessionId });
  appendQuestion(runId, claudeResult.result);

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
  answer: string;
}

function isAnswerArray(value: unknown): value is Answer[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a) => a && typeof a === "object" && typeof (a as any).question_id === "string" && typeof (a as any).answer === "string",
    )
  );
}

export function submitAnswers(params: Record<string, unknown>): Record<string, unknown> {
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

  const claudeResult = spawnClaude(record.workspace_path, [
    "--resume",
    record.session_id,
    ...classificationSchemaArgs(),
    answer,
  ]);
  appendQuestion(runId, claudeResult.result);

  return { result: {} };
}
