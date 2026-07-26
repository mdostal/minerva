// driver-selection.test.ts — wire-driver-selection story (swappable-driver epic)
//
// Fast, live-API-free tests for MINERVA_DRIVER's selection logic. The actual claim that
// SubagentDriver satisfies the same contract as SpawnDriver end-to-end is proven separately by
// re-running the driver-touching integration suites (kickoff-engine, output-emitter,
// cleanup-ledger, completeness) with MINERVA_DRIVER=subagent -- see this story's review notes.
// Files that don't touch the Driver at all (run-manager's allocateRun-only tests, types.test.ts
// by design, the pure-parsing escalation-classification/question-extraction tests, driver.test.ts
// and subagent-driver.test.ts which already test each driver directly) aren't rerun here --
// they'd be identical regardless of which driver is selected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "minerva.ts");

function runCliRaw(env: Record<string, string>): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", BIN], {
      input: JSON.stringify({ method: "capabilities" }),
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

test("MINERVA_DRIVER unset selects SpawnDriver by default -- the process starts and responds normally", () => {
  const result = runCliRaw({});
  assert.equal(result.status, 0);
  assert.match(result.stdout, /abi_version/);
});

test("MINERVA_DRIVER=spawn explicitly selects SpawnDriver -- process starts and responds normally", () => {
  const result = runCliRaw({ MINERVA_DRIVER: "spawn" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /abi_version/);
});

test("MINERVA_DRIVER=subagent selects SubagentDriver -- process starts and responds normally", () => {
  const result = runCliRaw({ MINERVA_DRIVER: "subagent" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /abi_version/);
});

test("MINERVA_DRIVER set to an unrecognized value fails loudly at startup -- never silently falls back or guesses", () => {
  const result = runCliRaw({ MINERVA_DRIVER: "bogus" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MINERVA_DRIVER/);
  assert.match(result.stderr, /bogus/);
});
