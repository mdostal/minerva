import { MinervaError, type ErrorCode } from "./errors.ts";
import { HeimdallRouteError } from "./driver.ts";
import { capabilities } from "./capabilities.ts";
import { getRunStatus, listRuns } from "./run-manager.ts";
import { startRun, getQuestions, submitAnswers } from "./kickoff-engine.ts";
import { getOutput } from "./output-emitter.ts";
import { abortRun } from "./cleanup-ledger.ts";
import { resumeFromConsusAnswer, resumeAnsweredConsusDecision } from "./consus-resume.ts";
import { pollConsusAnswers } from "./consus-poller.ts";
import { pollAndResumeConsusAnswers } from "./consus-auto-resume.ts";

export interface Envelope {
  method: string;
  params?: Record<string, unknown>;
}

export type Handler = (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type Response =
  | { result: Record<string, unknown> }
  | { error: { code: ErrorCode; message: string; retry_after_ms: null } };

// Method registry — full API contract per docs/architecture.md. Anything not registered falls
// through to UNKNOWN_METHOD.
const handlers: Record<string, Handler> = {
  capabilities,
  startRun,
  getRunStatus,
  listRuns,
  getQuestions,
  submitAnswers,
  getOutput,
  abortRun,
  resumeFromConsusAnswer,
  resumeAnsweredConsusDecision,
  pollConsusAnswers,
  pollAndResumeConsusAnswers,
};

function isValidEnvelope(req: unknown): req is Envelope {
  return (
    typeof req === "object" &&
    req !== null &&
    typeof (req as Record<string, unknown>).method === "string"
  );
}

export async function dispatch(req: unknown): Promise<Response> {
  if (!isValidEnvelope(req)) {
    return {
      error: {
        code: "VALIDATION_FAILED",
        message: "Request must be {method: string, params?: object}",
        retry_after_ms: null,
      },
    };
  }

  const handler = handlers[req.method];
  if (!handler) {
    return {
      error: {
        code: "UNKNOWN_METHOD",
        message: `Unknown method: ${req.method}`,
        retry_after_ms: null,
      },
    };
  }

  try {
    const result = await handler(req.params ?? {});
    return { result };
  } catch (e) {
    if (e instanceof MinervaError) {
      return { error: { code: e.code, message: e.message, retry_after_ms: null } };
    }
    // add-upstream-error-code: a HeimdallRouteError means the method WAS correctly dispatched --
    // its handler failed against an internal/upstream dependency (Heimdall routing), not because
    // the method doesn't exist. Map it to its own code instead of the blanket UNKNOWN_METHOD
    // below, which is reserved for genuinely-uncaught, unexpected exceptions (conservative blast
    // radius -- see the genuine "no such method" branch above, which this does not touch).
    if (e instanceof HeimdallRouteError) {
      return { error: { code: "UPSTREAM_ERROR", message: e.message, retry_after_ms: null } };
    }
    return {
      error: {
        code: "UNKNOWN_METHOD",
        message: e instanceof Error ? e.message : String(e),
        retry_after_ms: null,
      },
    };
  }
}
