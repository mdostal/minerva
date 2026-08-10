// bin/minerva.test.ts — wire-protocol-skeleton story
// Spawns a real bin/minerva subprocess per AD-1 (no mocking the CLI boundary).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCli, call } from "../src/test-cli.ts";

test("capabilities returns abi_version and exits 0", () => {
  const { stdout, status } = runCli(JSON.stringify({ method: "capabilities", params: {} }));
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed, { result: { abi_version: "1.0.0" } });
});

test("malformed JSON on stdin returns VALIDATION_FAILED and exits 1", () => {
  const { stdout, status } = runCli("not json{{{");
  assert.equal(status, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.error.code, "VALIDATION_FAILED");
});

test("envelope missing a string method returns VALIDATION_FAILED and exits 1", () => {
  const { stdout, status } = runCli(JSON.stringify({ params: {} }));
  assert.equal(status, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.error.code, "VALIDATION_FAILED");
});

test("unrecognized method returns UNKNOWN_METHOD and exits 1", () => {
  const { stdout, status } = runCli(JSON.stringify({ method: "notARealMethod", params: {} }));
  assert.equal(status, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.error.code, "UNKNOWN_METHOD");
});

test("error envelope always uses the closed 5-code enum, never a custom code", () => {
  const CLOSED_ENUM = new Set(["NOT_FOUND", "VALIDATION_FAILED", "WRONG_CHANNEL", "NOT_READY", "UNKNOWN_METHOD"]);
  const { stdout } = runCli("not json{{{");
  const parsed = JSON.parse(stdout);
  assert.ok(CLOSED_ENUM.has(parsed.error.code), `${parsed.error.code} must be one of the closed enum`);
});

test("pollAndResumeConsusAnswers is registered as a real ABI method and no-ops with nothing parked", () => {
  const minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-poll-resume-cli-"));
  try {
    const { result, error, status } = call("pollAndResumeConsusAnswers", {}, { MINERVA_HOME: minervaHome });
    assert.equal(status, 0);
    assert.equal(error, undefined);
    assert.deepEqual(result, { polled: 0, resumed: [], poll_errors: [], resume_errors: [] });
  } finally {
    rmSync(minervaHome, { recursive: true, force: true });
  }
});
