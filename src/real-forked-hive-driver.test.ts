// real-forked-hive-driver.test.ts — real-forked-hive-driver story (forked-driver-integration
// epic). Real, live claude -p calls against a local plugin-hive-fork checkout via
// MINERVA_HIVE_PLUGIN_DIR (--plugin-dir under the hood) -- never the marketplace-installed
// plugin-hive, and never waiting on PR #341 to merge upstream, per this epic's own scope
// decision. No mocking the CLI boundary (AD-1).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ForkedHiveDriver, decodeEnvelopePointer, NO_PENDING_SENTINEL } from "./driver.ts";
import { testHeimdallRouteUrl } from "./test-cli.ts";

const FORK_PATH = "/Users/dostal/Documents/work/dostal/code/plugin-hive-fork";
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

function newScratchWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "minerva-forked-driver-test-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "scratch init"]);
  return dir;
}

test("ForkedHiveDriver.runTurn with sessionId: null dispatches fresh and surfaces the first question, classified", async () => {
  const cwd = newScratchWorkspace();
  const driver = new ForkedHiveDriver();

  const result = await driver.runTurn({
    cwd,
    sessionId: null,
    prompt: "/plugin-hive:kickoff a tiny forked-driver test project",
  });

  // Contract compliance -- same DriverResult shape every other Driver implementation returns.
  assert.equal(typeof result.session_id, "string");
  assert.equal(typeof result.raw_result, "string");

  const parsed = JSON.parse(result.raw_result);
  assert.equal(typeof parsed.question, "string");
  assert.ok(["agent", "human"].includes(parsed.suggested_channel));
  assert.equal(typeof parsed.confidence, "number");
  assert.ok(parsed.confidence >= 0 && parsed.confidence <= 1);
  assert.equal(typeof parsed.reason, "string");
  // Envelope-sourced extras (added by the type-extension story) round-trip through too.
  assert.ok(["single-select", "multi-select", "free-text"].includes(parsed.kind));
  assert.equal(typeof parsed.qid, "string");

  // The returned session_id must be a real, decodable envelope pointer -- not a plain claude
  // session id (statelessness confirmed by the spike: this driver never uses --resume).
  const pointer = decodeEnvelopePointer(result.session_id);
  assert.ok(pointer, "expected a decodable envelope pointer");
  assert.match(pointer!.envelopePath, /\.pHive\/questions\//);
  assert.equal(pointer!.qid, parsed.qid);
  assert.equal(pointer!.skillPrompt, "/plugin-hive:kickoff a tiny forked-driver test project");

  rmSync(cwd, { recursive: true, force: true });
});

// This test does NOT hardcode phase names, qid names, or an assumed phase ORDER -- a live debug
// session (real-forked-hive-driver story) found kickoff-protocol.md's phase-id table is not a
// strict execution order (a fresh greenfield kickoff hit "project-classification" immediately
// after "1a", not "1b"), some qid names aren't literally pinned by the doc (the 1a metrics qid
// came back as "metrics_enabled" one run, "enable_metrics" another), and feeding a
// non-schema-valid free-text answer (e.g. "placeholder") to a single-select question triggers the
// skill's OWN validation-retry mechanism (a "-round-2" re-emitted envelope) -- which looks
// identical to a real phase transition from the driver's perspective, and correctly so: the
// driver has no way (and no need) to distinguish "real progression" from "validation retry",
// both are just "prior envelope consumed, new envelope now pending." So this test always answers
// with a genuinely schema-valid value (the question's own first declared `options` entry when
// present) and walks generically until it either observes the specific invariant under test --
// at least one interim answer that does NOT trigger a new dispatch (same envelope path back) --
// or the run completes.
test("ForkedHiveDriver.runTurn walks a real multi-turn kickoff run, surfacing interim answers within the same envelope and only re-dispatching on closure", async () => {
  const cwd = newScratchWorkspace();
  const driver = new ForkedHiveDriver();
  const skillPrompt = "/plugin-hive:kickoff a tiny forked-driver test project";
  const MAX_TURNS = 8;

  let result = await driver.runTurn({ cwd, sessionId: null, prompt: skillPrompt });
  let previousEnvelopePath: string | null = null;
  let sameEnvelopeObservedAtLeastOnce = false;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (result.session_id === NO_PENDING_SENTINEL) break;

    const pointer = decodeEnvelopePointer(result.session_id);
    assert.ok(pointer, `turn ${turn}: expected a decodable envelope pointer, got session_id ${result.session_id}`);

    if (pointer!.envelopePath === previousEnvelopePath) {
      sameEnvelopeObservedAtLeastOnce = true;
    }
    previousEnvelopePath = pointer!.envelopePath;

    const parsed = JSON.parse(result.raw_result);
    assert.equal(typeof parsed.qid, "string");
    assert.ok(["single-select", "multi-select", "free-text"].includes(parsed.kind));

    const answer = Array.isArray(parsed.options) && parsed.options.length > 0 ? parsed.options[0] : "n/a";
    result = await driver.runTurn({ cwd, sessionId: result.session_id, prompt: answer });
  }

  assert.ok(
    sameEnvelopeObservedAtLeastOnce,
    `expected at least one interim answer within the same envelope (no new dispatch) across a ${MAX_TURNS}-turn real walk`,
  );

  rmSync(cwd, { recursive: true, force: true });
});
