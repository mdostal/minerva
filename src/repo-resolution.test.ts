// repo-resolution.test.ts — repo-resolution story (PAN-6745 autonomy unlock)
// Pure, driver-free tests of resolveTargetRepo's priority ladder. Each test snapshots and restores
// the three env vars it touches so nothing leaks between tests within this file's process.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTargetRepo } from "./repo-resolution.ts";

const ENV_KEYS = ["MINERVA_REPO_MAP", "MINERVA_INCUBATOR_REPO"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

test("explicit target_repo wins over everything (source: explicit)", () => {
  clearEnv();
  process.env.MINERVA_INCUBATOR_REPO = "/some/incubator";
  const r = resolveTargetRepo({ explicit: "/repos/auriga", idea: "anything at all" });
  assert.equal(r.repo, "/repos/auriga");
  assert.equal(r.source, "explicit");
});

test("god-scoped idea resolves to that god's repo via MINERVA_REPO_MAP (source: god)", () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), "minerva-repomap-"));
  try {
    const mapPath = join(dir, "repo-map.json");
    writeFileSync(mapPath, JSON.stringify({ auriga: "/repos/auriga", heimdall: "/repos/heimdall" }));
    process.env.MINERVA_REPO_MAP = mapPath;
    const r = resolveTargetRepo({ explicit: undefined, idea: "Fix the Auriga routing hierarchy metadata" });
    assert.equal(r.repo, "/repos/auriga");
    assert.equal(r.source, "god");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("greenfield seed with no god match falls back to the configured incubator (source: incubator)", () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), "minerva-repomap-"));
  try {
    const mapPath = join(dir, "repo-map.json");
    writeFileSync(mapPath, JSON.stringify({ auriga: "/repos/auriga" }));
    process.env.MINERVA_REPO_MAP = mapPath;
    process.env.MINERVA_INCUBATOR_REPO = "/repos/incubator";
    const r = resolveTargetRepo({ explicit: undefined, idea: "A brand new standalone widget dashboard" });
    assert.equal(r.repo, "/repos/incubator");
    assert.equal(r.source, "incubator");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("greenfield seed with nothing configured resolves to none/undefined (legacy fresh_init preserved)", () => {
  clearEnv();
  const r = resolveTargetRepo({ explicit: undefined, idea: "A brand new standalone widget" });
  assert.equal(r.repo, undefined);
  assert.equal(r.source, "none");
});

test("god match is whole-word: a substring inside a longer token does NOT match", () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), "minerva-repomap-"));
  try {
    const mapPath = join(dir, "repo-map.json");
    // key "arc" must not match "architecture"
    writeFileSync(mapPath, JSON.stringify({ arc: "/repos/arc" }));
    process.env.MINERVA_REPO_MAP = mapPath;
    const r = resolveTargetRepo({ explicit: undefined, idea: "Improve the system architecture docs" });
    assert.equal(r.source, "none", "substring 'arc' inside 'architecture' must not match a whole-word god key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("god match is deterministic across key ordering (case-insensitive sorted, first match wins)", () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), "minerva-repomap-"));
  try {
    const mapPath = join(dir, "repo-map.json");
    // idea names both gods; sorted order (heimdall < vulcan) picks heimdall regardless of file order.
    writeFileSync(mapPath, JSON.stringify({ vulcan: "/repos/vulcan", heimdall: "/repos/heimdall" }));
    process.env.MINERVA_REPO_MAP = mapPath;
    const r = resolveTargetRepo({ explicit: undefined, idea: "Wire vulcan and heimdall together" });
    assert.equal(r.repo, "/repos/heimdall");
    assert.equal(r.source, "god");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
