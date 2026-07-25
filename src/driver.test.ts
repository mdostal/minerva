// driver.test.ts — driver-interface-spawn story (swappable-driver epic)
//
// Real, live claude -p calls (kept cheap: single words / short exchanges except the SIGINT
// test, which deliberately needs a slow-to-complete turn to reliably interrupt mid-flight).
// The full pre-existing kickoff-engine/run-manager/output-emitter/cleanup-ledger/completeness
// suite is the regression proof that refactoring kickoff-engine.ts onto SpawnDriver is a pure
// extraction (see this story's acceptance criteria) -- not restated here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SpawnDriver } from "./driver.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(__dirname, "driver-sigint-harness.ts");

// Every runTurn() call bakes in the combined question+classification --json-schema (AD-2) --
// prompts must be phrased as "ask exactly one question", not a bare echo, or the model
// correctly refuses to force an unrelated reply into the question-routing shape.

test("SpawnDriver.runTurn with sessionId: null starts a fresh session, returning {session_id, raw_result}", async () => {
  const driver = new SpawnDriver();
  const result = await driver.runTurn({
    cwd: process.cwd(),
    sessionId: null,
    prompt: "You are running headlessly. Ask exactly one clear question containing the word 'pineapple', then stop and wait.",
  });
  assert.equal(typeof result.session_id, "string");
  assert.ok(result.session_id.length > 0);
  assert.match(result.raw_result.toLowerCase(), /pineapple/);
});

test("SpawnDriver.runTurn with a non-null sessionId resumes context, matching today's submitAnswers resume behavior", async () => {
  const driver = new SpawnDriver();
  const first = await driver.runTurn({
    cwd: process.cwd(),
    sessionId: null,
    prompt: "You are running headlessly. Ask exactly one clear question about the human operator's favorite fruit, then stop and wait.",
  });
  assert.ok(first.session_id);

  const second = await driver.runTurn({
    cwd: process.cwd(),
    sessionId: first.session_id,
    prompt:
      "My answer: mango. Now ask exactly one follow-up question that includes the word 'mango' in it, then stop and wait.",
  });
  assert.match(second.raw_result.toLowerCase(), /mango/);
  assert.ok(second.session_id); // Driver always returns a session_id, every turn -- caller persists it
});

test("SIGINT to a live SpawnDriver-driven process kills the in-flight claude child -- no orphan", async () => {
  const marker = `sigint-harness-marker-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const child = spawn(
    "npx",
    ["tsx", HARNESS, `Write a very long, detailed 1200 word essay about deep sea ecosystems. Marker: ${marker}.`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Give the harness time to actually spawn its inner `claude` child before we interrupt it.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  child.kill("SIGINT");

  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  // The harness never completed its turn -- it was interrupted, not finished normally.
  assert.notEqual(exitInfo.code, 0);

  // Give the OS a moment to reflect the killed grandchild's absence, then confirm no orphaned
  // `claude` process (carrying this run's distinguishing marker) is still alive.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const psOut = execFileSync("ps", ["aux"], { encoding: "utf8" });
  assert.doesNotMatch(psOut, new RegExp(marker), "expected no orphaned claude process after SIGINT");
});
