// subagent-driver.test.ts — subagent-driver story (swappable-driver epic)
//
// Real, live calls: claude --bg, claude agents --json, claude stop, claude -p --resume
// --json-schema. Each SubagentDriver.runTurn() involves two live API calls (the --bg turn
// itself, plus the extraction call) and a real poll loop, so this file is slower/costlier than
// SpawnDriver's -- that's the acceptance cost named in this story's own risk notes, not a bug.
//
// Requires --test-force-exit (see package.json's "test" script): some descendant of the real
// `claude` CLI invocations in this file leaves a handle open that keeps node:test's own process
// alive well past every individual test resolving. All assertions are correct and verified
// regardless -- this only affects how promptly the test *process* exits afterward.
//
// Also requires --test-concurrency=1 (see package.json): node:test parallelizes across test
// files by default. This file's resume path makes 4 live claude interactions per test (2 --bg
// turns, each polled + stopped + extracted) -- confirmed via isolated dry-run that it resolves
// in seconds alone, but reliably timed out at the 120s poll ceiling when running concurrently
// alongside the other ~10 test files' own live claude calls (real API/CLI contention under
// load, not a polling logic bug). Matches production reality too: Minerva drives one turn at a
// time per run, not N concurrent processes hammering the claude CLI simultaneously.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SubagentDriver } from "./driver.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGKILL_HARNESS = join(__dirname, "subagent-driver-sigkill-harness.ts");
// Spawn tsx directly (not via `npx tsx`) -- npx's own resolution can interpose an extra process
// hop, so a SIGKILL sent to the handle `spawn()` returns doesn't necessarily reach the real
// work process. tsx's local bin is a single-hop node script; killing it kills the real process.
const TSX_BIN = join(__dirname, "..", "node_modules", ".bin", "tsx");

// Isolated scratch workspace, NOT process.cwd() (the real minerva repo). Driving a real claude
// turn with bypassPermissions against the actual project directory lets the model notice real
// repo/branch context and substitute a genuinely-contextual response instead of following the
// synthetic test prompt -- confirmed empirically (asked for a literal word, got a real question
// about "the swappable driver feature" back instead). The SIGKILL test below already creates
// its own per-test scratch dir; this one is shared by the other three tests.
let scratchCwd: string;

before(() => {
  scratchCwd = mkdtempSync(join(tmpdir(), "minerva-subagent-driver-test-"));
  execFileSync("git", ["init", "-q", scratchCwd]);
  execFileSync("git", ["-C", scratchCwd, "commit", "-q", "--allow-empty", "-m", "scratch init"]);
});

after(() => {
  rmSync(scratchCwd, { recursive: true, force: true });
});

function listBackgroundAgentsRaw(): any[] {
  const out = execFileSync("claude", ["agents", "--json"], { encoding: "utf8" });
  return JSON.parse(out).filter((a: any) => a.kind === "background");
}

// Mirrors kickoff-engine.test.ts's proven-reliable "favorite fruit for idea X" scenario framing
// -- see driver.test.ts for why (an abstract "ask a question containing word X" instruction is
// ungrounded enough that the model sometimes asks an open-ended real-work clarifying question
// instead; confirmed this isn't session-environment leakage by testing with CLAUDE_*/CLAUDECODE
// env vars explicitly stripped and seeing the same behavior).
const FRUIT_PROMPT =
  "You are running headlessly (no interactive terminal, no AskUserQuestion tool available) " +
  "for idea 'a tiny scratch project'. You need one piece of information from the human " +
  "operator before you can proceed: their favorite fruit. Ask exactly one clear question in " +
  "your final text response, then stop and wait -- do not guess an answer, do not proceed " +
  "further this turn.";

test("SubagentDriver.runTurn with sessionId: null dispatches via --bg, polls to terminal, stops, and extracts a structured result", async () => {
  const driver = new SubagentDriver();
  const result = await driver.runTurn({
    cwd: scratchCwd,
    sessionId: null,
    prompt: FRUIT_PROMPT,
  });
  assert.equal(typeof result.session_id, "string");
  assert.ok(result.session_id.length > 0);
  assert.match(result.raw_result.toLowerCase(), /fruit/);
});

test("SubagentDriver.runTurn with a non-null sessionId dispatches via --bg --resume and retains context", async () => {
  const driver = new SubagentDriver();
  const first = await driver.runTurn({
    cwd: scratchCwd,
    sessionId: null,
    prompt: FRUIT_PROMPT,
  });
  assert.ok(first.session_id);

  const second = await driver.runTurn({
    cwd: scratchCwd,
    sessionId: first.session_id,
    prompt:
      "My answer: mango. Now ask exactly one follow-up question that includes the word 'mango' in it, then stop and wait.",
  });
  assert.match(second.raw_result.toLowerCase(), /mango/);

  // Real property, confirmed empirically: --bg --resume returns a DIFFERENT session_id than
  // the one resumed, even though context is correctly retained. The caller must persist the
  // NEW value every turn -- never assume it stays constant.
  assert.notEqual(second.session_id, first.session_id);
});

test("a --bg turn that completes a task rather than asking a question reaches state: done, and SubagentDriver treats it as terminal the same as blocked", async () => {
  const driver = new SubagentDriver();
  // No question is asked here -- the turn just performs a quick task and stops, so the
  // background session should settle into state: done rather than blocked. SubagentDriver
  // must poll through to extraction either way (blocked and done are both terminal-for-us).
  const result = await driver.runTurn({
    cwd: scratchCwd,
    sessionId: null,
    prompt: "Reply with exactly the word 'acknowledged' and then stop. Do not ask any question.",
  });
  assert.equal(typeof result.session_id, "string");
  // The extraction call still forces the combined schema, so even a non-question turn gets
  // structured into SOME question-shaped result -- what matters here is that runTurn resolved
  // at all (proving the done path was handled), not the specific text.
  assert.ok(result.raw_result.length > 0);
});

test("SIGKILL of the launching process does not orphan or lose the underlying --bg session -- it remains independently trackable", async () => {
  // realpath'd: macOS's os.tmpdir() returns /var/folders/... but `claude agents --json`
  // reports the resolved /private/var/folders/... form -- compare like-for-like.
  const scratchCwd = realpathSync(mkdtempSync(join(tmpdir(), "minerva-subagent-sigkill-")));
  let dispatchedId: string | null = null;
  try {
    const child = spawn(TSX_BIN, [SIGKILL_HARNESS, "Say hello."], {
      cwd: scratchCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Synchronize on the harness's own stdout instead of guessing a wall-clock delay -- it
    // prints DISPATCHED:<id> the instant `claude --bg` succeeds, then hangs. We kill it the
    // moment we see that line, proving survival independent of npx/tsx startup variance.
    dispatchedId = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("harness never printed DISPATCHED: within 30s")), 30_000);
      child.stdout.on("data", (d) => {
        buf += d;
        const match = buf.match(/DISPATCHED:(\S+)/);
        if (match && match[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    assert.notEqual(dispatchedId, "UNKNOWN");

    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    // Confirm the session is still alive/trackable via `claude agents --json`, keyed on cwd
    // (a --bg session's reported prompt-derived "name" isn't reliable to match on, but cwd is).
    const all = listBackgroundAgentsRaw();
    const entries = all.filter((a) => a.cwd === scratchCwd);
    assert.ok(
      entries.length > 0,
      `expected the --bg session to survive its launching process being SIGKILL'd. scratchCwd=${scratchCwd}, dispatchedId=${dispatchedId}, observed cwds=${JSON.stringify(all.map((a) => a.cwd))}`,
    );

    // Cleanup: release the session we just proved survives, so it doesn't linger.
    for (const entry of entries) {
      if (entry.id) {
        try {
          execFileSync("claude", ["stop", entry.id]);
        } catch {
          // already stopped/finished -- fine
        }
      }
    }
  } finally {
    rmSync(scratchCwd, { recursive: true, force: true });
  }
});
