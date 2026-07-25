// spike-plugin-hive-drivability-spike.test.ts — Risk-A PoC spike (kickoff-review gate)
//
// Proves the load-bearing assumption behind Minerva's architecture: plugin-hive's
// kickoff (a Claude Code skill, not a standalone binary) can be driven headlessly via
// `claude -p`, stopped cleanly at a generated question, persisted to disk as a normal
// session transcript, and resumed via `claude -p --resume <session_id>` to continue
// past that question with full context.
//
// Run: npx tsx --test docs/spike-plugin-hive-drivability-spike.test.ts
//
// Each test spawns a real `claude -p` subprocess (real API calls, real cost — kept to
// claude-haiku-4-5 and single-turn prompts to stay cheap). Every scratch git repo this
// spike creates lives under os.tmpdir() and is removed in an after() hook.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const MODEL = "claude-haiku-4-5-20251001";
let scratchRepo: string;

function claudeP(args: string[], opts: { timeout?: number } = {}) {
  const out = execFileSync("claude", ["-p", "--model", MODEL, "--output-format", "json",
    "--permission-mode", "bypassPermissions", ...args], {
    cwd: scratchRepo,
    encoding: "utf8",
    timeout: opts.timeout ?? 60_000,
  });
  return JSON.parse(out);
}

function findSessionFile(sessionId: string): string | null {
  // Claude Code namespaces project transcript dirs by an escaped absolute cwd path
  // under ~/.claude/projects/. Locate it by walking that directory rather than
  // hardcoding the escaping rule (it's an implementation detail we shouldn't couple to).
  const projectsDir = join(process.env.HOME ?? "", ".claude", "projects");
  const dirs = require("node:fs").readdirSync(projectsDir);
  for (const dir of dirs) {
    const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

before(() => {
  scratchRepo = mkdtempSync(join(tmpdir(), "minerva-spike-"));
  execFileSync("git", ["init", "-q"], { cwd: scratchRepo });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "spike scratch init"], { cwd: scratchRepo });
});

after(() => {
  rmSync(scratchRepo, { recursive: true, force: true });
});

test("AskUserQuestion is NOT available to a headless (-p) session", () => {
  const sessionId = randomUUID();
  const result = claudeP([
    "--session-id", sessionId,
    "Call the AskUserQuestion tool exactly once with header 'Fruit', question 'Pick a fruit', " +
    "and two options 'Apple' and 'Banana'. Do not guess or answer it yourself -- actually invoke " +
    "the tool and let the call complete however the system handles it in this mode.",
  ]);
  assert.equal(result.is_error, false);
  assert.equal(result.stop_reason, "end_turn");
  // The model cannot find/invoke AskUserQuestion headlessly -- it reports back that
  // the tool isn't available rather than successfully invoking it. Phrasing varies
  // (LLM prose), so assert on the concept (mentions the tool + a not-available word)
  // rather than one exact sentence.
  const text = result.result.toLowerCase();
  assert.match(text, /askuserquestion/);
  assert.match(text, /(not available|isn't available|don't see|not listed|not accessible|couldn't find|unable to find)/);
});

test("a headless run asked to get one fact stops cleanly at a single prose question", () => {
  const sessionId = randomUUID();
  const result = claudeP([
    "--session-id", sessionId,
    "You are running headlessly (no interactive terminal, no AskUserQuestion tool available). " +
    "You need one piece of information from the human operator before you can proceed: their " +
    "favorite fruit. Ask exactly one clear question in your final text response, then stop and " +
    "wait -- do not guess an answer, do not proceed further this turn.",
  ]);
  assert.equal(result.is_error, false);
  assert.equal(result.stop_reason, "end_turn");
  assert.equal(result.num_turns, 1); // stopped after one turn -- did not spin/retry
  assert.match(result.result, /fruit/i);
  assert.match(result.result.trim(), /\?\s*$/); // ends on a question, not a guessed answer

  // Persistence: the run's state must actually be on disk, not just in this process.
  const sessionFile = findSessionFile(sessionId);
  assert.ok(sessionFile, `expected a session transcript for ${sessionId} on disk`);
  const lines = readFileSync(sessionFile!, "utf8").trim().split("\n");
  assert.ok(lines.length > 0);

  // Resume: a fresh `claude -p --resume` call, with no other state, must recover the
  // paused question and correctly incorporate the human's answer.
  const resumed = claudeP([
    "--resume", sessionId,
    "My answer: mango. Now confirm back to me what question you had asked and what answer " +
    "you just received, in one sentence, to prove you remember the prior turn.",
  ]);
  assert.equal(resumed.is_error, false);
  assert.equal(resumed.session_id, sessionId); // same session, not forked
  assert.match(resumed.result.toLowerCase(), /fruit/);
  assert.match(resumed.result.toLowerCase(), /mango/);
});
