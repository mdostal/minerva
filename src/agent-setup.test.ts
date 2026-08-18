// agent-setup.test.ts — real subprocess round trips against small fake-executable scripts
// (MINERVA_CLAUDE_BIN/MINERVA_CODEX_BIN overrides), same convention as
// agnostic-plan-driver.test.ts's OPENCODE_BIN/HIVE_PLAN_AGNOSTIC_CLI seams -- not framework-level
// mocking.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectHarnesses,
  mcpRegistered,
  registerMcp,
  skillNames,
  skillsInstalled,
  installSkills,
  agentStatus,
  agentInit,
} from "./agent-setup.ts";

let scratch: string;
let previousClaudeBin: string | undefined;
let previousCodexBin: string | undefined;
// Deterministic "not present" for codex -- never rely on the real machine happening to lack a
// real `codex` binary on PATH.
const NONEXISTENT_BIN = "/nonexistent/minerva-agent-setup-test/codex";

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "minerva-agent-setup-"));
  previousClaudeBin = process.env.MINERVA_CLAUDE_BIN;
  previousCodexBin = process.env.MINERVA_CODEX_BIN;
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (previousClaudeBin) process.env.MINERVA_CLAUDE_BIN = previousClaudeBin;
  else delete process.env.MINERVA_CLAUDE_BIN;
  if (previousCodexBin) process.env.MINERVA_CODEX_BIN = previousCodexBin;
  else delete process.env.MINERVA_CODEX_BIN;
});

// Writes a small fake CLI script that records every invocation's argv (one line of JSON per
// call, appended) to `logPath`, and exits with `exitCode`, printing `stdout` on success.
function fakeCli(name: string, logPath: string, exitCode: number, stdout: string): string {
  const path = join(scratch, name);
  const script = `#!/bin/sh
echo "$@" >> "${logPath}"
if [ ${exitCode} -ne 0 ]; then exit ${exitCode}; fi
printf '%s' '${stdout.replace(/'/g, "'\\''")}'
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

test("detectHarnesses reports presence via `which`", () => {
  const log = join(scratch, "detect.log");
  process.env.MINERVA_CLAUDE_BIN = fakeCli("fake-claude-detect", log, 0, "");
  process.env.MINERVA_CODEX_BIN = NONEXISTENT_BIN; // real `codex` almost certainly absent on CI/dev machines
  const result = detectHarnesses();
  assert.equal(result.claude, true);
  assert.equal(result.codex, false);
});

test("mcpRegistered for claude uses the targeted `mcp get minerva`, never `mcp list`", () => {
  const log = join(scratch, "mcp-get.log");
  process.env.MINERVA_CLAUDE_BIN = fakeCli("fake-claude-get", log, 0, "minerva:\n  Status: Connected\n");
  assert.equal(mcpRegistered("claude"), true);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["mcp get minerva"]);
});

test("mcpRegistered for codex uses `mcp list` (no per-server health-check risk)", () => {
  const log = join(scratch, "mcp-list.log");
  process.env.MINERVA_CODEX_BIN = fakeCli("fake-codex-list", log, 0, "Name     Status\nminerva  ok\n");
  assert.equal(mcpRegistered("codex"), true);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["mcp list"]);
});

test("mcpRegistered is false on a non-zero exit, and false for an unknown harness", () => {
  const log = join(scratch, "mcp-fail.log");
  process.env.MINERVA_CLAUDE_BIN = fakeCli("fake-claude-fail", log, 1, "");
  assert.equal(mcpRegistered("claude"), false);
  assert.equal(mcpRegistered("cursor"), false);
});

test("registerMcp skips (returns true, no shell-out) when already registered", () => {
  const log = join(scratch, "register-skip.log");
  process.env.MINERVA_CLAUDE_BIN = fakeCli("fake-claude-registered", log, 0, "minerva:\n  Status: Connected\n");
  const result = registerMcp("claude");
  assert.equal(result, true);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["mcp get minerva"]); // only the check, never an `add` call
});

test("registerMcp builds the correct argv for claude when not yet registered", () => {
  const log = join(scratch, "register-claude.log");
  const bin = join(scratch, "fake-claude-register");
  // First call (the internal mcpRegistered check) must report "not registered"; a real CLI
  // wouldn't behave differently per-call, but this fake only needs to prove the eventual `add`
  // argv is correct, so a single not-registered response plus a successful add is sufficient.
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  process.env.MINERVA_CLAUDE_BIN = bin;
  const result = registerMcp("claude");
  assert.equal(result, true);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["mcp get minerva", "mcp add --scope user minerva -- minerva mcp"]);
});

test("registerMcp builds the correct argv for codex when not yet registered", () => {
  const log = join(scratch, "register-codex.log");
  const bin = join(scratch, "fake-codex-register");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then exit 0; fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  process.env.MINERVA_CODEX_BIN = bin;
  const result = registerMcp("codex");
  assert.equal(result, true);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.deepEqual(calls, ["mcp list", "mcp add minerva -- minerva mcp"]);
});

test("registerMcp reports false when registration itself fails", () => {
  const log = join(scratch, "register-deny.log");
  const bin = join(scratch, "fake-claude-deny");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi
exit 1
`,
  );
  chmodSync(bin, 0o755);
  process.env.MINERVA_CLAUDE_BIN = bin;
  assert.equal(registerMcp("claude"), false);
});

test("skillNames matches the real packaged directory -- never empty, this repo always ships minerva-plan", () => {
  const names = skillNames();
  assert.ok(names.includes("minerva-plan"));
});

test("installSkills copies every packaged skill, idempotent, repairs a modified file", () => {
  const dest = join(scratch, "install-dest");
  const written = installSkills(dest);
  assert.deepEqual(written, skillNames());
  for (const name of skillNames()) {
    assert.equal(skillsInstalled(dest)[name], true);
  }

  const second = installSkills(dest);
  assert.deepEqual(second, []); // nothing changed -- nothing reported as (re)written

  const installedFile = join(dest, "minerva-plan", "SKILL.md");
  writeFileSync(installedFile, "tampered content");
  const third = installSkills(dest);
  assert.deepEqual(third, ["minerva-plan"]);
  assert.notEqual(readFileSync(installedFile, "utf8"), "tampered content");
});

test("agentStatus reports harnesses, mcp_registered, and skills without mutating anything", () => {
  const log = join(scratch, "status.log");
  process.env.MINERVA_CLAUDE_BIN = fakeCli("fake-claude-status", log, 0, "minerva:\n  Status: Connected\n");
  process.env.MINERVA_CODEX_BIN = NONEXISTENT_BIN;
  const dest = join(scratch, "status-dest");
  const status = agentStatus(undefined, dest) as {
    harnesses: Record<string, boolean>;
    mcp_registered: Record<string, boolean>;
    skills: Record<string, boolean>;
  };
  assert.equal(status.harnesses.claude, true);
  assert.equal(status.harnesses.codex, false);
  assert.equal(status.mcp_registered.claude, true);
  assert.equal(status.mcp_registered.codex, false); // absent harness never checked -- reported false, not attempted
  assert.equal(status.skills["minerva-plan"], false); // dest is fresh, nothing installed yet
});

test("agentStatus with only=['codex'] narrows harnesses/mcp_registered to just codex and omits skills", () => {
  process.env.MINERVA_CODEX_BIN = NONEXISTENT_BIN;
  const status = agentStatus(["codex"]) as {
    harnesses: Record<string, boolean>;
    mcp_registered: Record<string, boolean>;
    skills: Record<string, boolean>;
  };
  assert.deepEqual(Object.keys(status.harnesses), ["codex"]);
  assert.deepEqual(Object.keys(status.mcp_registered), ["codex"]);
  assert.deepEqual(status.skills, {}); // skills are a claude-code-install concept, not codex's
});

test("agentInit registers every detected harness and installs skills only when claude is a target", () => {
  const claudeLog = join(scratch, "init-claude.log");
  const bin = join(scratch, "fake-claude-init");
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${claudeLog}"
if [ "$1" = "mcp" ] && [ "$2" = "get" ]; then exit 1; fi
exit 0
`,
  );
  chmodSync(bin, 0o755);
  process.env.MINERVA_CLAUDE_BIN = bin;
  process.env.MINERVA_CODEX_BIN = NONEXISTENT_BIN;

  const dest = join(scratch, "init-dest");
  const result = agentInit(undefined, dest) as {
    requested: string[];
    mcp_registered: Record<string, boolean>;
    skills_installed: string[];
  };
  assert.deepEqual(result.requested, ["claude"]); // codex not detected, never targeted
  assert.equal(result.mcp_registered.claude, true);
  assert.deepEqual(result.skills_installed, skillNames());
});

test("agentInit with only=['codex'] never touches skills, even if claude is also present", () => {
  const log = join(scratch, "init-codex-only.log");
  process.env.MINERVA_CODEX_BIN = fakeCli("fake-codex-init-only", log, 0, "");
  const dest = join(scratch, "init-codex-only-dest");
  const result = agentInit(["codex"], dest) as { skills_installed: string[] };
  assert.deepEqual(result.skills_installed, []);
});
