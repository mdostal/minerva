// dispatch.test.ts -- add-upstream-error-code story.
//
// dispatch.ts's handler-catch branch (lines ~71-85) used to coerce ANY exception thrown by a
// dispatched method's handler into UNKNOWN_METHOD, indistinguishable from the genuine
// "no such method" case just above it. This file proves the fix: a HeimdallRouteError (the
// typed error fix-heimdall-route-fail-fast-with-fallback introduced for a Heimdall routing
// failure) now surfaces as the new UPSTREAM_ERROR code, while a truly nonexistent method name
// is completely unaffected and still returns UNKNOWN_METHOD.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dispatch } from "./dispatch.ts";
import { __setDriverForTest } from "./kickoff-engine.ts";
import { HeimdallRouteError, type Driver, type DriverInput, type DriverResult } from "./driver.ts";
import { createSeedRepo } from "./test-cli.ts";

let minervaHome: string;
let seedRepo: string;
let savedDriver: Driver;
const savedEnv = {
  MINERVA_HOME: process.env.MINERVA_HOME,
  MINERVA_SEED_REPO: process.env.MINERVA_SEED_REPO,
};

// A driver whose very first turn throws the same typed error resolveRuntimeRoute() throws when
// Heimdall fails and no operator fallback is configured -- exactly what a real SpawnDriver /
// SubagentDriver / ForkedHiveDriver.runTurn() would propagate, per driver.ts's resolveRuntimeRoute.
class HeimdallFailureDriver implements Driver {
  async runTurn(_input: DriverInput): Promise<DriverResult> {
    throw new HeimdallRouteError(
      "Heimdall routing failed and no MINERVA_FALLBACK_CLI/MINERVA_FALLBACK_MODEL fallback is configured: connect ECONNREFUSED",
    );
  }
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-dispatch-"));
  seedRepo = createSeedRepo("minerva-seed-repo-dispatch-");
  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_SEED_REPO = seedRepo;
  savedDriver = __setDriverForTest(new HeimdallFailureDriver());
});

after(() => {
  __setDriverForTest(savedDriver);
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("a HeimdallRouteError raised inside startRun's handler surfaces as UPSTREAM_ERROR, not UNKNOWN_METHOD", async () => {
  const response = await dispatch({ method: "startRun", params: { idea: "an app that hits a dead Heimdall" } });

  assert.ok("error" in response, `expected an error response, got ${JSON.stringify(response)}`);
  assert.equal(response.error.code, "UPSTREAM_ERROR");
  assert.match(response.error.message, /Heimdall routing failed/);
  assert.equal(response.error.retry_after_ms, null);
});

test("a genuinely nonexistent method name still returns UNKNOWN_METHOD -- this path is unchanged", async () => {
  const response = await dispatch({ method: "thisMethodDoesNotExist" });

  assert.ok("error" in response, `expected an error response, got ${JSON.stringify(response)}`);
  assert.equal(response.error.code, "UNKNOWN_METHOD");
  assert.match(response.error.message, /Unknown method: thisMethodDoesNotExist/);
  assert.equal(response.error.retry_after_ms, null);
});
