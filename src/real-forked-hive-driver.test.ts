// real-forked-hive-driver.test.ts — real-forked-hive-driver story (forked-driver-integration
// epic). Real, live claude -p calls against a local plugin-hive-fork checkout via
// MINERVA_HIVE_PLUGIN_DIR (--plugin-dir under the hood) -- never the marketplace-installed
// plugin-hive, and never waiting on PR #341 to merge upstream, per this epic's own scope
// decision. No mocking the CLI boundary (AD-1).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { ForkedHiveDriver, decodeEnvelopePointer, NO_PENDING_SENTINEL, HeimdallRouteError } from "./driver.ts";
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
let previousMinervaHome: string | undefined;
let minervaHome: string;

// driver-lifecycle-telemetry: snapshot of the REAL (developer) ~/.minerva/events directory,
// taken before MINERVA_HOME is overridden below. Used by the isolation test at the bottom of
// this file to prove telemetry writes during this whole test file never touched it.
function snapshotRealEventsDir(): Record<string, number> {
  const dir = join(homedir(), ".minerva", "events");
  if (!existsSync(dir)) return {};
  const snapshot: Record<string, number> = {};
  for (const name of readdirSync(dir)) {
    snapshot[name] = statSync(join(dir, name)).size;
  }
  return snapshot;
}
let realEventsSnapshotBefore: Record<string, number>;

before(() => {
  realEventsSnapshotBefore = snapshotRealEventsDir();

  previousRouteUrl = process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL = testHeimdallRouteUrl();
  process.env.MINERVA_HIVE_PLUGIN_DIR = FORK_PATH;

  // driver-lifecycle-telemetry (H1): isolate MINERVA_HOME under a throwaway temp dir for the
  // whole file, matching the mkdtempSync pattern in run-manager.test.ts -- otherwise
  // ForkedHiveDriver.runTurn()'s new telemetry writes would land in the developer's real
  // ~/.minerva/events/ directory.
  previousMinervaHome = process.env.MINERVA_HOME;
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-forked-driver-test-"));
  process.env.MINERVA_HOME = minervaHome;
});

after(() => {
  if (previousRouteUrl === undefined) {
    delete process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  } else {
    process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL = previousRouteUrl;
  }
  delete process.env.MINERVA_HIVE_PLUGIN_DIR;

  if (previousMinervaHome === undefined) {
    delete process.env.MINERVA_HOME;
  } else {
    process.env.MINERVA_HOME = previousMinervaHome;
  }
  rmSync(minervaHome, { recursive: true, force: true });
});

function newScratchWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "minerva-forked-driver-test-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "scratch init"]);
  return dir;
}

test("ForkedHiveDriver.runTurn with sessionId: null dispatches fresh and surfaces the first question, classified", { skip: FORK_MISSING }, async () => {
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
test("ForkedHiveDriver.runTurn walks a real multi-turn kickoff run, surfacing interim answers within the same envelope and only re-dispatching on closure", { skip: FORK_MISSING }, async () => {
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

// driver-lifecycle-telemetry: driver_started/driver_succeeded/driver_failed telemetry for
// ForkedHiveDriver.runTurn(). These tests are deliberately structured to NOT require
// MINERVA_HIVE_PLUGIN_DIR/plugin-hive-fork (unlike the two tests above) -- they only care that
// runTurn() emits the right lifecycle events around whatever spawnRuntime() call happens inside
// it, not about real plugin-hive kickoff behavior, so they run unconditionally (no FORK_MISSING
// skip) even on a machine without a plugin-hive-fork checkout. The success case still makes one
// real, live `claude -p` call (AD-1, no mocking the CLI boundary) with a trivial prompt; the
// failure case needs no live CLI or network call at all (see below).

function eventsDir(): string {
  return join(minervaHome, "events");
}

function readJsonlLines(path: string): any[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("ForkedHiveDriver.runTurn emits driver_started and driver_succeeded telemetry when spawnRuntime succeeds", async () => {
  const cwd = newScratchWorkspace();
  const driver = new ForkedHiveDriver();

  const startedPath = join(eventsDir(), "driver_started.jsonl");
  const succeededPath = join(eventsDir(), "driver_succeeded.jsonl");
  const failedPath = join(eventsDir(), "driver_failed.jsonl");
  const startedBefore = readJsonlLines(startedPath).length;
  const succeededBefore = readJsonlLines(succeededPath).length;
  const failedBefore = readJsonlLines(failedPath).length;

  const result = await driver.runTurn({
    cwd,
    sessionId: null,
    prompt: "Reply with exactly the word OK and nothing else.",
  });
  assert.equal(typeof result.session_id, "string");

  const startedAfter = readJsonlLines(startedPath);
  const succeededAfter = readJsonlLines(succeededPath);
  const failedAfter = readJsonlLines(failedPath);

  assert.equal(startedAfter.length, startedBefore + 1, "expected exactly one new driver_started event");
  assert.equal(succeededAfter.length, succeededBefore + 1, "expected exactly one new driver_succeeded event");
  assert.equal(failedAfter.length, failedBefore, "expected no new driver_failed event on success");

  const startedEvent = startedAfter[startedAfter.length - 1];
  const succeededEvent = succeededAfter[succeededAfter.length - 1];
  assert.equal(startedEvent.event, "driver_started");
  assert.match(startedEvent.emitted_at, ISO_TIMESTAMP_RE, "expected an ISO emitted_at timestamp");
  assert.equal(succeededEvent.event, "driver_succeeded");
  assert.match(succeededEvent.emitted_at, ISO_TIMESTAMP_RE, "expected an ISO emitted_at timestamp");

  rmSync(cwd, { recursive: true, force: true });
});

test("ForkedHiveDriver.runTurn emits driver_started and driver_failed (never driver_succeeded) when the turn fails, and rethrows the original error unchanged", async () => {
  const cwd = newScratchWorkspace();
  const driver = new ForkedHiveDriver();

  const startedPath = join(eventsDir(), "driver_started.jsonl");
  const succeededPath = join(eventsDir(), "driver_succeeded.jsonl");
  const failedPath = join(eventsDir(), "driver_failed.jsonl");
  const startedBefore = readJsonlLines(startedPath).length;
  const succeededBefore = readJsonlLines(succeededPath).length;
  const failedBefore = readJsonlLines(failedPath).length;

  // Force resolveRuntimeRoute() (called from dispatchFresh, ahead of spawnRuntime) to fail
  // deterministically without any live network call or CLI subprocess: a syntactically valid
  // `data:` route response missing the required cli/model fields makes
  // parseAvailableRoutePayload() throw inside resolveRuntimeRoute()'s own try block, which (with
  // no MINERVA_FALLBACK_CLI/MODEL configured) re-throws as a HeimdallRouteError -- an uncaught
  // throw from inside runTurn()'s body, the same shape a spawnRuntime() failure would take from
  // this test's perspective (both are exceptions runTurn() must record via driver_failed and
  // rethrow unchanged).
  const savedRouteUrl = process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL = `data:application/json,${encodeURIComponent(JSON.stringify({}))}`;
  try {
    await assert.rejects(
      driver.runTurn({ cwd, sessionId: null, prompt: "irrelevant -- route resolution fails before any CLI spawn" }),
      (err: unknown) => {
        assert.ok(err instanceof HeimdallRouteError, `expected a HeimdallRouteError, got ${err}`);
        assert.match((err as Error).message, /Heimdall routing failed/);
        return true;
      },
    );
  } finally {
    if (savedRouteUrl === undefined) {
      delete process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
    } else {
      process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL = savedRouteUrl;
    }
  }

  const startedAfter = readJsonlLines(startedPath);
  const succeededAfter = readJsonlLines(succeededPath);
  const failedAfter = readJsonlLines(failedPath);

  assert.equal(startedAfter.length, startedBefore + 1, "expected exactly one new driver_started event");
  assert.equal(succeededAfter.length, succeededBefore, "expected NO new driver_succeeded event on failure");
  assert.equal(failedAfter.length, failedBefore + 1, "expected exactly one new driver_failed event");

  const failedEvent = failedAfter[failedAfter.length - 1];
  assert.equal(failedEvent.event, "driver_failed");
  assert.match(failedEvent.emitted_at, ISO_TIMESTAMP_RE, "expected an ISO emitted_at timestamp");
  assert.equal(typeof failedEvent.message, "string");
  assert.match(failedEvent.message, /Heimdall routing failed/, "expected the driver_failed payload to carry err.message");

  rmSync(cwd, { recursive: true, force: true });
});

test("telemetry writes from this file's tests never touch the real ~/.minerva/events directory", () => {
  const after = snapshotRealEventsDir();
  assert.deepEqual(
    after,
    realEventsSnapshotBefore,
    "expected zero new/changed files under the real ~/.minerva/events directory -- MINERVA_HOME isolation must contain all telemetry writes",
  );
});
