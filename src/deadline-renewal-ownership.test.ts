// deadline-renewal-ownership.test.ts — deadline-renewal-ownership story (forked-driver-integration
// epic). Live, real integration test against the fork (no mocking the CLI boundary, AD-1)
// proving the story's decision: ForkedHiveDriver needs NO proactive deadline-renewal logic.
//
// DECISION (documented in full, with rationale, in this story's design_decisions): Minerva never
// implements proactive renewal. Reasoning, confirmed empirically by this test:
//
// ForkedHiveDriver only ever re-dispatches the skill (re-invoking `/plugin-hive:kickoff ...`,
// which is the only thing that ever calls ask_or_emit() again for a given phase) AFTER it has
// already written the human's answer onto the envelope and satisfied the closure invariant (see
// answerAndContinue() in src/driver.ts). So by the time the skill re-runs and calls
// find_envelope_for_phase() for that phase, the on-disk envelope's status is ALREADY "answered".
// question_gateway.py's ask_or_emit() only ever consults the `deadline` field on the OTHER
// branch -- when the matched envelope is still unanswered (`_extract_answers` returns None). An
// answered envelope is consumed unconditionally via the answers-based branch, regardless of how
// stale its `deadline` timestamp is. The upstream deadline-expiry/re-emit code path is therefore
// architecturally UNREACHABLE from Minerva's own usage pattern -- it exists in the protocol for a
// different hypothetical caller shape (one that polls/re-invokes a skill periodically even
// without a human answer yet), which ForkedHiveDriver simply never does. This is also exactly
// the behavior AD-5 ("the stall invariant has no timeout; the hold is unbounded") wants: a human
// can take arbitrarily long to answer, and the eventual answer is still honored correctly no
// matter how long the on-disk deadline has technically lapsed.
//
// This test proves it directly: configure a real, tiny (1s) answer_deadline_seconds via the
// scratch workspace's own hive.config.yaml (question_gateway.py's resolve_headless_config() reads
// Path.cwd()/"hive.config.yaml" -- confirmed correct because ForkedHiveDriver's PYTHONPATH-based
// invocation instruction, story real-forked-hive-driver, never changes cwd away from the
// project), sleep well past it, then answer -- and confirm the run still progresses cleanly to a
// new envelope rather than re-emitting a duplicate or losing the answer.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ForkedHiveDriver, decodeEnvelopePointer, NO_PENDING_SENTINEL } from "./driver.ts";
import { testHeimdallRouteUrl } from "./test-cli.ts";

// The hardcoded default below only ever matched one specific developer's home directory --
// override it with MINERVA_HIVE_PLUGIN_DIR (the same var this test sets for the code under
// test) to point at your own local plugin-hive-fork checkout. Skip, don't fail, when neither
// resolves to a real checkout: this is a deliberate live integration test (AD-1, no mocking the
// CLI boundary), not something every machine is expected to have set up.
const FORK_PATH = process.env.MINERVA_HIVE_PLUGIN_DIR || "/Users/dostal/Documents/work/dostal/code/plugin-hive-fork";
const FORK_MISSING = existsSync(FORK_PATH)
  ? false
  : `plugin-hive-fork checkout not found at ${FORK_PATH} -- set MINERVA_HIVE_PLUGIN_DIR to a local checkout to run this live integration test`;
let previousRouteUrl: string | undefined;

before(() => {
  previousRouteUrl = process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL = testHeimdallRouteUrl();
  process.env.MINERVA_HIVE_PLUGIN_DIR = FORK_PATH;
});

after(() => {
  if (previousRouteUrl === undefined) {
    delete process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  } else {
    process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL = previousRouteUrl;
  }
  delete process.env.MINERVA_HIVE_PLUGIN_DIR;
});

function newScratchWorkspaceWithShortDeadline(): string {
  const dir = mkdtempSync(join(tmpdir(), "minerva-deadline-test-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "scratch init"]);
  // A 1s deadline (vs the upstream default of 1800s) lets this test prove the real behavior in
  // seconds instead of half an hour, without touching any Minerva code -- purely a fork-side
  // config knob (hive/references/question-envelope-schema.md's documented renewal/expiry config).
  writeFileSync(
    join(dir, "hive.config.yaml"),
    "headless:\n  answer_deadline_seconds: 1\n  deadline_expired_action: re-emit\n",
  );
  return dir;
}

test("an answer submitted long after the envelope's on-disk deadline has lapsed still lands correctly -- no proactive renewal needed", { skip: FORK_MISSING }, async () => {
  const cwd = newScratchWorkspaceWithShortDeadline();
  const driver = new ForkedHiveDriver();
  const skillPrompt = "/plugin-hive:kickoff a tiny forked-driver test project";

  const first = await driver.runTurn({ cwd, sessionId: null, prompt: skillPrompt });
  const firstParsed = JSON.parse(first.raw_result);
  const firstPointer = decodeEnvelopePointer(first.session_id);
  assert.ok(firstPointer, "expected a decodable envelope pointer");
  const envelopePathAtStart = firstPointer!.envelopePath;

  // Sleep well past the configured 1s deadline -- nothing re-invokes the skill in this window
  // (ForkedHiveDriver is purely reactive, no polling), so this alone proves the envelope's
  // `deadline` field going stale, on its own, has no effect.
  await new Promise((resolve) => setTimeout(resolve, 5_000));

  const answer = Array.isArray(firstParsed.options) && firstParsed.options.length > 0 ? firstParsed.options[0] : "no";
  const second = await driver.runTurn({ cwd, sessionId: first.session_id, prompt: answer });

  // The answer must have landed and the run must have progressed -- NOT lost, and NOT stuck
  // re-asking the exact same still-pending question via a duplicate re-emitted envelope.
  if (second.session_id === NO_PENDING_SENTINEL) {
    // Acceptable: the run completed entirely after this one answer.
  } else {
    const secondPointer = decodeEnvelopePointer(second.session_id);
    assert.ok(secondPointer, "expected a decodable envelope pointer for the next question");
    assert.notEqual(
      secondPointer!.envelopePath,
      envelopePathAtStart,
      "expected real progression to a NEW envelope, not a re-emitted duplicate of the answered one",
    );
  }

  rmSync(cwd, { recursive: true, force: true });
});
