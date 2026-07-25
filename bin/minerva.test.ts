// bin/minerva.test.ts — wire-protocol-skeleton story
// Spawns a real bin/minerva subprocess per AD-1 (no mocking the CLI boundary).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "minerva.ts");

function run(input: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", BIN], { input, encoding: "utf8" });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

test("capabilities returns abi_version and exits 0", () => {
  const { stdout, status } = run(JSON.stringify({ method: "capabilities", params: {} }));
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed, { result: { abi_version: "1.0.0" } });
});

test("malformed JSON on stdin returns VALIDATION_FAILED and exits 1", () => {
  const { stdout, status } = run("not json{{{");
  assert.equal(status, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.error.code, "VALIDATION_FAILED");
});

test("envelope missing a string method returns VALIDATION_FAILED and exits 1", () => {
  const { stdout, status } = run(JSON.stringify({ params: {} }));
  assert.equal(status, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.error.code, "VALIDATION_FAILED");
});

test("unrecognized method returns UNKNOWN_METHOD and exits 1", () => {
  const { stdout, status } = run(JSON.stringify({ method: "notARealMethod", params: {} }));
  assert.equal(status, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.error.code, "UNKNOWN_METHOD");
});

test("error envelope always uses the closed 5-code enum, never a custom code", () => {
  const CLOSED_ENUM = new Set(["NOT_FOUND", "VALIDATION_FAILED", "WRONG_CHANNEL", "NOT_READY", "UNKNOWN_METHOD"]);
  const { stdout } = run("not json{{{");
  const parsed = JSON.parse(stdout);
  assert.ok(CLOSED_ENUM.has(parsed.error.code), `${parsed.error.code} must be one of the closed enum`);
});
