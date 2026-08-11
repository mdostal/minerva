import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter, CodexAdapter, OpencodeAdapter, getAdapter } from "./driver.ts";

const SCHEMA_ARGS = ["--json-schema", '{"type":"object","required":["question"]}'];

test("ClaudeAdapter keeps the claude-native noninteractive JSON schema flags", () => {
  const args = new ClaudeAdapter().formatTurnArgs("claude-sonnet", null, "Ask one question", SCHEMA_ARGS);

  assert.deepEqual(args.slice(0, 6), [
    "-p",
    "--model",
    "claude-sonnet",
    "--output-format",
    "json",
    "--permission-mode",
  ]);
  assert.ok(args.includes("--json-schema"));
  assert.equal(args.at(-1), "Ask one question");
});

test("ClaudeAdapter parses Claude JSON stdout into a TurnResult", () => {
  const result = new ClaudeAdapter().parseTurnResult(
    JSON.stringify({ session_id: "claude-session", result: "What fruit?" }),
  );

  assert.equal(result.session_id, "claude-session");
  assert.equal(result.result, "What fruit?");
});

test("OpencodeAdapter uses opencode run JSON mode and does not forward claude-only flags", () => {
  const args = new OpencodeAdapter().formatTurnArgs("google/gemini-2.5-pro", "sess-123", "Ask one question", SCHEMA_ARGS);

  assert.deepEqual(args.slice(0, 8), [
    "run",
    "--model",
    "google/gemini-2.5-pro",
    "--format",
    "json",
    "--auto",
    "--session",
    "sess-123",
  ]);
  assert.equal(args.includes("--json-schema"), false);
  assert.equal(args.includes("--output-format"), false);
  assert.match(args.at(-1) ?? "", /JSON Schema/);
});

test("CodexAdapter uses codex exec JSON mode and does not forward claude-only flags", () => {
  const args = new CodexAdapter().formatTurnArgs("gpt-5-codex", null, "Ask one question", SCHEMA_ARGS);

  assert.deepEqual(args.slice(0, 8), [
    "exec",
    "--json",
    "--model",
    "gpt-5-codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "Ask one question\n\nRespond with exactly one JSON object matching this JSON Schema, with no markdown or prose outside the JSON object:\n{\"type\":\"object\",\"required\":[\"question\"]}",
  ]);
  assert.equal(args.includes("--json-schema"), false);
  assert.equal(args.includes("--output-format"), false);
});

test("CodexAdapter resumes with codex exec resume", () => {
  const args = new CodexAdapter().formatTurnArgs("gpt-5-codex", "thread-123", "Continue");

  assert.deepEqual(args, [
    "exec",
    "resume",
    "--json",
    "--model",
    "gpt-5-codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "thread-123",
    "Continue",
  ]);
});

test("non-Claude adapters normalize JSONL event output into TurnResult", () => {
  const opencode = new OpencodeAdapter().parseTurnResult(
    [
      JSON.stringify({ type: "session", sessionID: "sess-abc" }),
      JSON.stringify({ type: "message", role: "assistant", content: [{ type: "text", text: "What fruit?" }] }),
    ].join("\n"),
  );
  assert.equal(opencode.session_id, "sess-abc");
  assert.equal(opencode.result, "What fruit?");

  const codex = new CodexAdapter().parseTurnResult(
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-abc" }),
      JSON.stringify({ type: "agent_message", message: "What fruit?" }),
    ].join("\n"),
  );
  assert.equal(codex.session_id, "thread-abc");
  assert.equal(codex.result, "What fruit?");
});

test("getAdapter returns CLI-specific adapters", () => {
  assert.ok(getAdapter("claude") instanceof ClaudeAdapter);
  assert.ok(getAdapter("opencode") instanceof OpencodeAdapter);
  assert.ok(getAdapter("codex") instanceof CodexAdapter);
});
