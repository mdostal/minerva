import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter, CodexAdapter, OpencodeAdapter, getAdapter } from "./driver.ts";

const CLAUDE_ONLY_ARGS = ["--json-schema", "{\"type\":\"object\"}", "--plugin-dir", "/tmp/plugin-hive"];
const FORBIDDEN_NON_CLAUDE_ARGS = ["-p", "--output-format", "--permission-mode", "--json-schema", "--plugin-dir"];

test("ClaudeAdapter preserves the existing claude -p foreground arg shape", () => {
  const args = new ClaudeAdapter().formatTurnArgs("claude-sonnet-4-5", "session-123", "Prompt text", CLAUDE_ONLY_ARGS);

  assert.deepEqual(args.slice(0, 8), [
    "-p",
    "--model",
    "claude-sonnet-4-5",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--resume",
  ]);
  assert.equal(args[8], "session-123");
  assert.deepEqual(args.slice(9, 13), CLAUDE_ONLY_ARGS);
  assert.equal(args.at(-1), "Prompt text");
});

test("OpencodeAdapter uses opencode run and never forwards claude-only args", () => {
  const args = new OpencodeAdapter().formatTurnArgs("google/gemini-2.5-pro", "session-123", "Prompt text", CLAUDE_ONLY_ARGS);

  assert.deepEqual(args, [
    "run",
    "--model",
    "google/gemini-2.5-pro",
    "--session",
    "session-123",
    "--auto",
    "Prompt text",
  ]);
  assert.deepEqual(args.filter((arg) => FORBIDDEN_NON_CLAUDE_ARGS.includes(arg)), []);
});

test("CodexAdapter uses codex exec and never forwards claude-only args", () => {
  const args = new CodexAdapter().formatTurnArgs("gpt-5-codex", null, "Prompt text", CLAUDE_ONLY_ARGS);

  assert.deepEqual(args, [
    "exec",
    "--model",
    "gpt-5-codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "Prompt text",
  ]);
  assert.deepEqual(args.filter((arg) => FORBIDDEN_NON_CLAUDE_ARGS.includes(arg)), []);
});

test("CodexAdapter resumes with codex exec resume", () => {
  const args = new CodexAdapter().formatTurnArgs("gpt-5-codex", "session-123", "Prompt text");

  assert.deepEqual(args, [
    "exec",
    "resume",
    "--model",
    "gpt-5-codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "session-123",
    "Prompt text",
  ]);
});

test("getAdapter returns concrete adapters for known routed CLIs", () => {
  assert.ok(getAdapter("claude") instanceof ClaudeAdapter);
  assert.ok(getAdapter("opencode") instanceof OpencodeAdapter);
  assert.ok(getAdapter("codex") instanceof CodexAdapter);
});
