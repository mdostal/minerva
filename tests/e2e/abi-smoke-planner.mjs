#!/usr/bin/env node
// abi-smoke-planner.mjs -- scripted stand-in for the planning CLI, used only by abi-smoke.test.ts.
// The test routes Minerva's SpawnDriver at this file (route `cli` = this path), so it speaks the
// ClaudeAdapter turn surface: `-p ... (--session-id ID | --resume ID) ... PROMPT` -> one JSON
// TurnResult on stdout whose `result` is the escalation-classification JSON.
//
// Script, two turns, fully deterministic, no network:
//   fresh turn   -> asks one human-channel question
//   resumed turn -> writes a complete epic (epic.yaml + one story) into the run workspace (cwd),
//                   which is how Minerva detects completion, and asks nothing further

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SMOKE_QUESTION = "Which platform should the first release target: web or mobile?";
const SMOKE_EPIC_ID = "abi-smoke-epic";

function emit(sessionId, classification) {
  process.stdout.write(
    JSON.stringify({
      session_id: sessionId,
      result: JSON.stringify(classification),
      is_error: false,
      stop_reason: "end_turn",
    }) + "\n",
  );
}

const args = process.argv.slice(2);
if (args[0] !== "-p") {
  process.stderr.write(`abi-smoke-planner: unsupported invocation: ${args.join(" ")}\n`);
  process.exit(1);
}

const resumeIdx = args.indexOf("--resume");
if (resumeIdx === -1) {
  const sessionIdx = args.indexOf("--session-id");
  emit(sessionIdx !== -1 ? args[sessionIdx + 1] : randomUUID(), {
    question: SMOKE_QUESTION,
    suggested_channel: "human",
    confidence: 0.95,
    reason: "Product scope decision -- needs the operator",
  });
} else {
  const epicDir = join(process.cwd(), ".pHive", "epics", SMOKE_EPIC_ID);
  mkdirSync(join(epicDir, "stories"), { recursive: true });
  writeFileSync(
    join(epicDir, "epic.yaml"),
    `name: ${SMOKE_EPIC_ID}\ntitle: ABI Smoke Epic\nstatus: approved\nstories:\n  - id: story-1\n`,
  );
  writeFileSync(join(epicDir, "stories", "story-1.yaml"), "id: story-1\ntitle: Ship the web MVP\n");
  emit(args[resumeIdx + 1], {
    question: "",
    suggested_channel: "human",
    confidence: 1,
    reason: "Plan complete",
  });
}
