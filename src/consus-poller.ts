// Consus poller — queries Consus for the status of parked (posted, not-yet-answered) run
// questions and extracts the human's answer once Consus reports one as answered.
//
// Poll-based by design, not webhook (minerva-auto-resume epic, "Poll vs Webhook" design
// decision): a Minerva instance must not need inbound network access to learn a parked question
// has been answered. Consistent with AD-1 (fresh-subprocess-per-call, no daemon --
// docs/architecture.md "No Autonomous Progress"): pollConsusAnswers below does ONE poll pass and
// returns -- it never loops or advances a run itself. An external caller (cron/launchd/whatever
// drives "the polling interval") re-invokes it, and feeds each answered entry to
// resumeFromConsusAnswer/resumeAnsweredConsusDecision (consus-resume.ts) to actually resume --
// that wiring is the resume-run-execution story's job, not this one's.

import { listRuns, readRunRecord, type Channel, type Question } from "./run-manager.ts";
import { extractAnswerFromItem } from "./consus-resume.ts";

const DEFAULT_POLL_TIMEOUT_MS = 750;

export interface ParkedConsusQuestion {
  run_id: string;
  question: Question;
}

export interface ConsusQuestionPollResult {
  status: string; // "answered" is the one status this module acts on; anything else means "still open"
  item: unknown;
  error?: string; // set (status: "error") on a network failure or non-2xx response
}

export interface PolledAnswer {
  run_id: string;
  question_id: string;
  consus_question_id: string;
  channel: Channel;
  answer: string | string[];
}

export interface PollError {
  run_id: string;
  question_id: string;
  consus_question_id: string;
  error: string;
}

function pollTimeoutMs(): number {
  const raw = process.env.MINERVA_CONSUS_POLL_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_POLL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_TIMEOUT_MS;
}

function consusUrl(): string {
  return process.env.CONSUS_URL || "http://localhost:8722";
}

// Every run-question mapping still awaiting a Consus answer: status "pending" (not yet answered
// locally) AND already posted to Consus -- carries a consus_question_id (store-parked-mapping
// story). A question never posted (Consus was unreachable at post time, or Consus posting is
// disabled) has no consus_question_id and is correctly skipped: there is nothing to poll for.
// Optionally scoped to a single run_id.
export function findParkedConsusQuestions(runId?: string): ParkedConsusQuestion[] {
  const { runs } = listRuns({}) as { runs: Array<{ run_id: string }> };
  const ids = runId ? runs.filter((r) => r.run_id === runId).map((r) => r.run_id) : runs.map((r) => r.run_id);

  const mappings: ParkedConsusQuestion[] = [];
  for (const id of ids) {
    let questions: Question[];
    try {
      questions = readRunRecord(id).questions;
    } catch {
      continue; // run record vanished/unreadable between listRuns and readRunRecord -- skip it
    }
    for (const question of questions) {
      if (question.status === "pending" && typeof question.consus_question_id === "string" && question.consus_question_id.length > 0) {
        mappings.push({ run_id: id, question });
      }
    }
  }
  return mappings;
}

// Query Consus for one question's current state. Never throws -- a network failure or malformed
// response comes back as a status:"error" sentinel (mirrors postQuestionToConsusDecisionApi's own
// best-effort shape in consus-decisions.ts), so polling many mappings in one pass isn't tripped up
// by a single unreachable/broken one.
export async function fetchConsusQuestionStatus(consusQuestionId: string): Promise<ConsusQuestionPollResult> {
  const url = `${consusUrl()}/api/questions/${encodeURIComponent(consusQuestionId)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), pollTimeoutMs());
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { status: "error", item: null, error: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    const status = data && typeof (data as any).status === "string" ? (data as any).status : "unknown";
    return { status, item: data };
  } catch (e) {
    return { status: "error", item: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
}

// One poll pass over every parked run-question mapping (optionally scoped to params.run_id).
// Queries Consus for each mapping's latest status; for any Consus reports "answered", extracts the
// human's answer (extractAnswerFromItem -- the same item-shape parser resumeAnsweredConsusDecision
// already uses for a pushed item, since a poll response and a push payload carry the identical
// Consus item shape). Read-only: does not submit anything back to the run or mutate run state.
export async function pollConsusAnswers(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const runId = typeof params.run_id === "string" ? params.run_id : undefined;
  const mappings = findParkedConsusQuestions(runId);

  const answered: PolledAnswer[] = [];
  const errors: PollError[] = [];

  for (const { run_id, question } of mappings) {
    const consusQuestionId = question.consus_question_id as string;
    const result = await fetchConsusQuestionStatus(consusQuestionId);

    if (result.status === "error") {
      errors.push({ run_id, question_id: question.id, consus_question_id: consusQuestionId, error: result.error ?? "unknown error" });
      continue;
    }
    if (result.status !== "answered") {
      continue; // still open -- nothing to do this cycle
    }

    const answer = extractAnswerFromItem(result.item, question.id);
    if (answer === null) {
      errors.push({
        run_id,
        question_id: question.id,
        consus_question_id: consusQuestionId,
        error: "Consus reports the question answered, but no answer could be extracted from its response",
      });
      continue;
    }

    answered.push({ run_id, question_id: question.id, consus_question_id: consusQuestionId, channel: question.channel, answer });
  }

  return { polled: mappings.length, answered, errors };
}
