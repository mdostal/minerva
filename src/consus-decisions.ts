import type { Question } from "./run-manager.ts";

const DEFAULT_CONSUS_DECISIONS_URL = "http://localhost:8722/api/decisions";
const DEFAULT_POST_TIMEOUT_MS = 750;

export interface ConsusDecisionPostResult {
  posted: boolean;
  url: string;
  status?: number;
  error?: string;
}

function postTimeoutMs(): number {
  const raw = process.env.MINERVA_CONSUS_POST_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_POST_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POST_TIMEOUT_MS;
}

function consusDecisionsUrl(): string {
  const raw = process.env.MINERVA_CONSUS_DECISIONS_URL;
  if (raw !== undefined) return raw;
  return DEFAULT_CONSUS_DECISIONS_URL;
}

export function buildConsusDecisionRequest(runId: string, question: Question): Record<string, unknown> {
  const decisionPayload = {
    version: "dostal:decision-request/v1",
    kind: "minerva_run_question",
    run_id: runId,
    question_id: question.id,
    channel: question.channel,
    title: question.text,
    context: question.reason,
    options: [
      { id: "A", title: "Answer this gate", tradeoffs: "Resume the Minerva run with the provided answer." },
      { id: "B", title: "Escalate or revise", tradeoffs: "Leave the run paused until a better answer is available." },
    ],
    recommended: "A",
  };

  return {
    id: `human_request:${runId}:${question.id}`,
    type: "human_request",
    title: question.text,
    status: "open",
    channel: question.channel,
    decision_payload: decisionPayload,
    question: {
      run_id: runId,
      id: question.id,
      text: question.text,
      channel: question.channel,
      reason: question.reason,
      confidence: question.confidence,
      suggestedChannel: question.suggested_channel,
      status: question.status,
    },
  };
}

export async function postQuestionToConsusDecisionApi(
  runId: string,
  question: Question,
): Promise<ConsusDecisionPostResult> {
  const url = consusDecisionsUrl();
  if (url.trim().length === 0) return { posted: false, url, error: "disabled" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), postTimeoutMs());
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildConsusDecisionRequest(runId, question)),
      signal: controller.signal,
    });
    if (!res.ok) return { posted: false, url, status: res.status, error: `HTTP ${res.status}` };
    return { posted: true, url, status: res.status };
  } catch (e) {
    return { posted: false, url, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timeout);
  }
}
