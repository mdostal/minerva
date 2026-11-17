#!/usr/bin/env tsx
// stub-claude.ts — fake `claude` CLI for tests that run without real auth.
// Simulates just enough of the claude CLI surface for Minerva's test suite:
//   claude -p --output-format json ... PROMPT              → classification JSON TurnResult
//   claude --bg ... PROMPT                                 → backgrounded · <shortId>
//   claude agents --json                                   → session array
//   claude stop SHORTID                                    → marks session stopped

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STATE_FILE =
  process.env.STUB_CLAUDE_STATE_FILE || join(tmpdir(), "stub-claude-state-default.json");

const EXTRACTION_INSTRUCTION = "Structure your prior question into the required schema.";

interface StubSession {
  shortId: string;
  sessionId: string;
  state: "running" | "blocked" | "stopped";
  cwd: string;
  question: string;
}

interface StateFile {
  sessions: Record<string, StubSession>;
}

function readState(): StateFile {
  if (!existsSync(STATE_FILE)) return { sessions: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as StateFile;
  } catch {
    return { sessions: {} };
  }
}

function writeState(state: StateFile): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function findSessionBySessionId(state: StateFile, sessionId: string): StubSession | undefined {
  return Object.values(state.sessions).find((s) => s.sessionId === sessionId);
}

// Derive a scripted question from the prompt text.
function deriveQuestion(prompt: string): string {
  if (prompt.toLowerCase().includes("fruit")) return "What is your favorite fruit?";
  const answerMatch = prompt.match(/My answer:\s*(\w+)/);
  if (answerMatch && answerMatch[1]) return `Would you like a ${answerMatch[1]}-flavored recipe?`;
  return "What information do you need?";
}

function makeClassificationJson(question: string): string {
  return JSON.stringify({
    question,
    suggested_channel: "human",
    confidence: 0.9,
    reason: "Human input required",
  });
}

function emitTurnResult(sessionId: string, result: string): void {
  process.stdout.write(
    JSON.stringify({ session_id: sessionId, result, is_error: false, stop_reason: "end_turn" }) +
      "\n",
  );
}

const args = process.argv.slice(2);

// ── claude agents --json ──────────────────────────────────────────────────────
if (args[0] === "agents" && args[1] === "--json") {
  const state = readState();
  const entries = Object.values(state.sessions)
    .filter((s) => s.state !== "stopped")
    .map((s) => ({
      id: s.shortId,
      sessionId: s.sessionId,
      kind: "background",
      state: s.state,
      cwd: s.cwd,
    }));
  process.stdout.write(JSON.stringify(entries) + "\n");
  process.exit(0);
}

// ── claude stop SHORTID ───────────────────────────────────────────────────────
if (args[0] === "stop" && args[1]) {
  const shortId = args[1];
  const state = readState();
  if (state.sessions[shortId]) {
    state.sessions[shortId]!.state = "stopped";
    writeState(state);
  }
  process.stdout.write("Session stopped\n");
  process.exit(0);
}

// ── claude --bg ... PROMPT ────────────────────────────────────────────────────
if (args[0] === "--bg") {
  const isStuck = process.env.MINERVA_STUB_BG_STUCK === "1";
  const prompt = args[args.length - 1] ?? "";

  const shortId = randomUUID().replace(/-/g, "").slice(0, 8);
  const fullSessionId = randomUUID();
  const question = deriveQuestion(prompt);
  const sessionState: "running" | "blocked" = isStuck ? "running" : "blocked";

  const state = readState();
  state.sessions[shortId] = {
    shortId,
    sessionId: fullSessionId,
    state: sessionState,
    cwd: process.cwd(),
    question,
  };
  writeState(state);

  process.stdout.write(`backgrounded · ${shortId}\n`);
  process.exit(0);
}

// ── claude -p ... PROMPT ──────────────────────────────────────────────────────
if (args[0] === "-p") {
  const prompt = args[args.length - 1] ?? "";

  // Special SIGINT-harness behavior: hang indefinitely when prompt contains "Marker:"
  // The test process kills us via SIGKILL after reading DISPATCHED:<id> from the harness.
  if (prompt.includes("Marker:")) {
    setInterval(() => {}, 1000); // keep event loop alive; never resolve
    // no process.exit() — we hang until killed
  } else if (prompt === "ping") {
    // Auth probe
    emitTurnResult(randomUUID(), "pong");
    process.exit(0);
  } else {
    const resumeIdx = args.indexOf("--resume");
    const sessionIdIdx = args.indexOf("--session-id");

    if (resumeIdx !== -1) {
      const resumeSessionId = args[resumeIdx + 1] ?? "";

      if (prompt === EXTRACTION_INSTRUCTION) {
        // SubagentDriver extraction call: look up the question stored for this session.
        const state = readState();
        const session = findSessionBySessionId(state, resumeSessionId);
        const question = session ? session.question : "What information do you need?";
        emitTurnResult(randomUUID(), makeClassificationJson(question));
      } else {
        // Resume with an answer from the human / follow-up turn.
        const question = deriveQuestion(prompt);
        emitTurnResult(randomUUID(), makeClassificationJson(question));
      }
      process.exit(0);
    } else {
      // Fresh session (--session-id or no session flag).
      const sessionId =
        sessionIdIdx !== -1 && args[sessionIdIdx + 1] ? (args[sessionIdIdx + 1] as string) : randomUUID();
      const question = deriveQuestion(prompt);
      emitTurnResult(sessionId, makeClassificationJson(question));
      process.exit(0);
    }
  }
} else {
  process.stderr.write(`stub-claude: unrecognized args: ${args.join(" ")}\n`);
  process.exit(1);
}
