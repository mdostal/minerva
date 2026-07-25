import { MinervaError, type ErrorCode } from "./errors.ts";
import { capabilities } from "./capabilities.ts";
import { startRun, getRunStatus, listRuns } from "./run-manager.ts";

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

// Method registry — later stories (kickoff-engine-plumbing, question-extraction,
// escalation-classification, output-emitter, cleanup-ledger-events) each add their own
// method(s) here. Anything not registered falls through to UNKNOWN_METHOD.
const handlers: Record<string, Handler> = {
  capabilities,
  startRun,
  getRunStatus,
  listRuns,
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
    return {
      error: {
        code: "UNKNOWN_METHOD",
        message: e instanceof Error ? e.message : String(e),
        retry_after_ms: null,
      },
    };
  }
}
