export type ErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "WRONG_CHANNEL"
  | "NOT_READY"
  | "UNKNOWN_METHOD"
  // add-upstream-error-code: a recognized, correctly-dispatched method whose handler failed
  // against an internal/upstream dependency (e.g. a HeimdallRouteError from driver.ts) is not the
  // same failure as "no such method" -- see dispatch.ts's handler-catch branch. Open Question 6
  // (design-discussion.md): whether downstream Pantheon consumers that pattern-match on the
  // previous 5-value union need advance notice of this 6th value is unresolved and out of this
  // story's scope.
  | "UPSTREAM_ERROR";

export class MinervaError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
