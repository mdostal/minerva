// forked-hive-driver-bounded.test.ts -- PAN-5590
//
// Fast, live-API-free regression coverage for ForkedHiveDriver.runTurn() itself. The live
// real-forked-hive-driver.test.ts suite proves the actual claude/plugin boundary; this file
// keeps the composed dispatch -> detect -> classify -> consume loop pinned with fixtures so CI
// catches wiring regressions without making unbounded model calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  ForkedHiveDriver,
  decodeEnvelopePointer,
  type ClaudePResult,
  type ClaudeTurnRunner,
} from "./driver.ts";

const SINGLE_ENVELOPE = `id: kickoff-single
skill: kickoff
phase: 1a
status: pending
provenance:
  raised_by: kickoff
  raised_at: '2026-07-26T19:11:29.823Z'
deadline: '2026-07-26T19:41:29.823Z'
renewal_count: 0
questions:
  - qid: enable_metrics
    text: Enable metrics tracking?
    kind: single-select
    options: ["yes", "no"]
    required: true
    answer: null
`;

const MULTI_REQUIRED_ENVELOPE = `id: kickoff-multi
skill: kickoff
phase: 1b
status: pending
provenance:
  raised_by: kickoff
  raised_at: '2026-07-26T19:12:00.000Z'
deadline: '2026-07-26T19:42:00.000Z'
renewal_count: 0
questions:
  - qid: ship_kind
    text: What does shipping mean for this project?
    kind: single-select
    options: ["app-store", "vercel", "github-release", "npm", "custom"]
    required: true
    answer: null
  - qid: ship_notes
    text: Any special shipping notes?
    kind: free-text
    options: null
    required: true
    answer: null
`;

const NEXT_PHASE_ENVELOPE = `id: kickoff-next
skill: kickoff
phase: project-classification
status: pending
provenance:
  raised_by: kickoff
  raised_at: '2026-07-26T19:13:00.000Z'
deadline: '2026-07-26T19:43:00.000Z'
renewal_count: 0
questions:
  - qid: project_type
    text: What type of project is this?
    kind: single-select
    options: ["framework", "service", "consumer-app"]
    required: true
    answer: null
`;

interface ClaudeCall {
  cwd: string;
  args: string[];
  extraEnv?: NodeJS.ProcessEnv;
}

function newWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "minerva-forked-bounded-"));
}

function questionsDir(cwd: string): string {
  const dir = join(cwd, ".pHive", "questions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEnvelope(cwd: string, name: string, body: string): string {
  const path = join(questionsDir(cwd), name);
  writeFileSync(path, body);
  return path;
}

function claudeResult(result: string, sessionId = "fake-session"): ClaudePResult {
  return { is_error: false, stop_reason: "stop", session_id: sessionId, result };
}

function makeRunner(options: {
  initialEnvelope?: string;
  nextEnvelopeAfterConsume?: string;
  classifications: string[];
}): { calls: ClaudeCall[]; runner: ClaudeTurnRunner } {
  const calls: ClaudeCall[] = [];
  let dispatchCount = 0;
  let classificationIndex = 0;

  const runner: ClaudeTurnRunner = async (cwd, args, extraEnv) => {
    calls.push({ cwd, args, extraEnv });

    if (extraEnv?.HIVE_HEADLESS === "1") {
      dispatchCount += 1;
      if (dispatchCount === 1 && options.initialEnvelope) {
        writeEnvelope(cwd, "kickoff.yaml", options.initialEnvelope);
      } else if (dispatchCount > 1) {
        const dir = questionsDir(cwd);
        const oldPath = join(dir, "kickoff.yaml");
        if (existsSync(oldPath)) {
          const parsed = parseYaml(readFileSync(oldPath, "utf8")) as { status?: string };
          assert.equal(parsed.status, "answered", "consume dispatch should only happen after the envelope is answered");
          unlinkSync(oldPath); // simulate plugin-hive's delete-on-consume side effect.
        }
        if (options.nextEnvelopeAfterConsume) {
          writeEnvelope(cwd, "kickoff-next.yaml", options.nextEnvelopeAfterConsume);
        }
      }
      return claudeResult("{}");
    }

    const result = options.classifications[classificationIndex++] ?? "{}";
    return claudeResult(result);
  };

  return { calls, runner };
}

test("ForkedHiveDriver.runTurn dispatches headlessly, detects a fixture envelope, and classifies one question", async () => {
  const cwd = newWorkspace();
  const { calls, runner } = makeRunner({
    initialEnvelope: SINGLE_ENVELOPE,
    classifications: [
      JSON.stringify({
        suggested_channel: "agent",
        confidence: 0.91,
        reason: "Routine setup preference.",
      }),
    ],
  });
  const driver = new ForkedHiveDriver(runner);

  const result = await driver.runTurn({
    cwd,
    sessionId: null,
    prompt: "/plugin-hive:kickoff bounded test",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.extraEnv?.HIVE_HEADLESS, "1");
  assert.match(calls[0]?.args.join(" ") ?? "", /MOMENT an envelope is written/);
  assert.match(calls[0]?.args.join(" ") ?? "", /Do NOT `cd` into the plugin/);
  assert.match(calls[1]?.args.at(-1) ?? "", /Enable metrics tracking/);

  const parsed = JSON.parse(result.raw_result);
  assert.deepEqual(parsed, {
    question: "Enable metrics tracking?",
    suggested_channel: "agent",
    confidence: 0.91,
    reason: "Routine setup preference.",
    kind: "single-select",
    options: ["yes", "no"],
    qid: "enable_metrics",
  });

  const pointer = decodeEnvelopePointer(result.session_id);
  assert.ok(pointer);
  assert.equal(pointer.qid, "enable_metrics");
  assert.equal(pointer.skillPrompt, "/plugin-hive:kickoff bounded test");
  rmSync(cwd, { recursive: true, force: true });
});

test("ForkedHiveDriver.runTurn uses the safe escalation boundary when classification output is malformed", async () => {
  const cwd = newWorkspace();
  const { runner } = makeRunner({
    initialEnvelope: SINGLE_ENVELOPE,
    classifications: ["not valid json"],
  });
  const driver = new ForkedHiveDriver(runner);

  const result = await driver.runTurn({ cwd, sessionId: null, prompt: "/plugin-hive:kickoff bounded test" });
  const parsed = JSON.parse(result.raw_result);

  assert.equal(parsed.suggested_channel, "human");
  assert.equal(parsed.confidence, 0);
  assert.match(parsed.reason, /defaulted to human/);
  rmSync(cwd, { recursive: true, force: true });
});

test("ForkedHiveDriver.runTurn consumes only on envelope closure; partial answers stall on the same envelope without live redispatch", async () => {
  const cwd = newWorkspace();
  const { calls, runner } = makeRunner({
    initialEnvelope: MULTI_REQUIRED_ENVELOPE,
    nextEnvelopeAfterConsume: NEXT_PHASE_ENVELOPE,
    classifications: [
      JSON.stringify({ suggested_channel: "human", confidence: 0.8, reason: "Shipping policy needs a human." }),
      JSON.stringify({ suggested_channel: "agent", confidence: 0.95, reason: "Mechanical note capture." }),
      JSON.stringify({ suggested_channel: "human", confidence: 0.7, reason: "Project classification affects planning." }),
    ],
  });
  const driver = new ForkedHiveDriver(runner);

  const first = await driver.runTurn({ cwd, sessionId: null, prompt: "/plugin-hive:kickoff bounded test" });
  const firstPointer = decodeEnvelopePointer(first.session_id);
  assert.ok(firstPointer);
  assert.equal(firstPointer.qid, "ship_kind");

  const second = await driver.runTurn({ cwd, sessionId: first.session_id, prompt: "github-release" });
  const secondPointer = decodeEnvelopePointer(second.session_id);
  assert.ok(secondPointer);
  assert.equal(secondPointer.envelopePath, firstPointer.envelopePath);
  assert.equal(secondPointer.qid, "ship_notes");
  assert.equal(calls.filter((c) => c.extraEnv?.HIVE_HEADLESS === "1").length, 1);

  const partiallyAnswered = parseYaml(readFileSync(firstPointer.envelopePath, "utf8")) as any;
  assert.equal(partiallyAnswered.status, "pending");
  assert.equal(partiallyAnswered.questions[0].answer, "github-release");
  assert.equal(partiallyAnswered.questions[1].answer, null);

  const third = await driver.runTurn({ cwd, sessionId: second.session_id, prompt: "no special notes" });
  const thirdPointer = decodeEnvelopePointer(third.session_id);
  assert.ok(thirdPointer);
  assert.notEqual(thirdPointer.envelopePath, firstPointer.envelopePath);
  assert.equal(thirdPointer.qid, "project_type");
  assert.equal(existsSync(firstPointer.envelopePath), false);
  assert.equal(calls.filter((c) => c.extraEnv?.HIVE_HEADLESS === "1").length, 2);

  rmSync(cwd, { recursive: true, force: true });
});

test("ForkedHiveDriver.runTurn returns the no-pending sentinel without classification when dispatch produces no envelope", async () => {
  const cwd = newWorkspace();
  const { calls, runner } = makeRunner({ classifications: [] });
  const driver = new ForkedHiveDriver(runner);

  const result = await driver.runTurn({ cwd, sessionId: null, prompt: "/plugin-hive:kickoff already complete" });
  const parsed = JSON.parse(result.raw_result);

  assert.equal(result.session_id, "forked-hive-driver:no-pending-envelope");
  assert.equal(parsed.suggested_channel, "human");
  assert.equal(parsed.confidence, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.extraEnv?.HIVE_HEADLESS, "1");
  rmSync(cwd, { recursive: true, force: true });
});
