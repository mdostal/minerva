// driver-telemetry.test.ts — driver-lifecycle-telemetry parity: SpawnDriver and SubagentDriver
// emit the same driver_started/driver_succeeded/driver_failed events ForkedHiveDriver does (see
// real-forked-hive-driver.test.ts), each tagged with which driver emitted it. The failure cases
// need no CLI or network at all (route resolution fails on a data: URL with no cli/model); the
// success cases make one real turn through `claude` (live, or the bin/stub-claude.ts stub that
// test-cli.ts installs when live auth is unavailable) and skip when neither is present.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpawnDriver, SubagentDriver, ForkedHiveDriver, HeimdallRouteError, type Driver } from "./driver.ts";
import { testHeimdallRouteUrl, CLAUDE_AUTH_AVAILABLE } from "./test-cli.ts";

const NO_CLAUDE = CLAUDE_AUTH_AVAILABLE ? false : "no live or stub claude CLI available";
const BROKEN_ROUTE_URL = `data:application/json,${encodeURIComponent(JSON.stringify({}))}`;

let minervaHome: string;
let scratchCwd: string;
const savedEnv = {
  MINERVA_HOME: process.env.MINERVA_HOME,
  MINERVA_PANTHEON_ROUTE_SELECT_URL: process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL,
};

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-driver-telemetry-"));
  process.env.MINERVA_HOME = minervaHome;
  scratchCwd = mkdtempSync(join(tmpdir(), "minerva-driver-telemetry-cwd-"));
  execFileSync("git", ["init", "-q", scratchCwd]);
});

after(() => {
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(scratchCwd, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function events(name: string): any[] {
  const path = join(minervaHome, "events", `${name}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function counts() {
  return {
    started: events("driver_started").length,
    succeeded: events("driver_succeeded").length,
    failed: events("driver_failed").length,
  };
}

const DRIVERS: Array<[string, () => Driver]> = [
  ["spawn", () => new SpawnDriver()],
  ["subagent", () => new SubagentDriver()],
  ["forked", () => new ForkedHiveDriver()],
];

for (const [name, make] of DRIVERS) {
  test(`${name} driver emits driver_started + driver_failed and rethrows the original error`, async () => {
    process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL = BROKEN_ROUTE_URL;
    const before = counts();

    await assert.rejects(make().runTurn({ cwd: scratchCwd, sessionId: null, prompt: "unused" }), (err: unknown) => {
      assert.ok(err instanceof HeimdallRouteError, `expected a HeimdallRouteError, got ${err}`);
      return true;
    });

    const after = counts();
    assert.equal(after.started, before.started + 1);
    assert.equal(after.succeeded, before.succeeded);
    assert.equal(after.failed, before.failed + 1);
    assert.equal(events("driver_started").at(-1).driver, name);
    const failed = events("driver_failed").at(-1);
    assert.equal(failed.driver, name);
    assert.match(failed.message, /Route selection failed/);
  });
}

for (const [name, make] of DRIVERS.filter(([n]) => n !== "forked")) {
  test(`${name} driver emits driver_started + driver_succeeded with its lane on a successful turn`, { skip: NO_CLAUDE }, async () => {
    process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL = testHeimdallRouteUrl();
    const before = counts();

    const result = await make().runTurn({
      cwd: scratchCwd,
      sessionId: null,
      prompt: "Reply with exactly the word OK and nothing else.",
    });
    assert.equal(typeof result.session_id, "string");
    assert.equal(result.route?.cli, "claude");

    const after = counts();
    assert.equal(after.started, before.started + 1);
    assert.equal(after.succeeded, before.succeeded + 1);
    assert.equal(after.failed, before.failed);
    const succeeded = events("driver_succeeded").at(-1);
    assert.equal(succeeded.driver, name);
    assert.equal(succeeded.lane, `claude:${result.route!.model}`);
  });
}
