export type ErrorCode =
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "WRONG_CHANNEL"
  | "NOT_READY"
  | "UNKNOWN_METHOD";

export class MinervaError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
