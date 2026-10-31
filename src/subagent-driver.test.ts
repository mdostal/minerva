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
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SubagentDriver } from "./driver.ts";
import { call, createSeedRepo, testHeimdallRouteUrl, CLAUDE_AUTH_AVAILABLE } from "./test-cli.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SIGKILL_HARNESS = join(__dirname, "subagent-driver-sigkill-harness.ts");
// Spawn tsx directly (not via `npx tsx`) to avoid npx's own extra process hop. Note tsx itself is
// still two processes: its CLI re-runs the script in a child node, so a SIGKILL sent to the
// handle `spawn()` returns kills only the wrapper -- the harness guards against outliving it
// (see the sigkill harness helpers below).
const TSX_BIN = join(__dirname, "..", "node_modules", ".bin", "tsx");

// Isolated scratch workspace, NOT process.cwd() (the real minerva repo). Driving a real claude
// turn with bypassPermissions against the actual project directory lets the model notice real
// repo/branch context and substitute a genuinely-contextual response instead of following the
// synthetic test prompt -- confirmed empirically (asked for a literal word, got a real question
// about "the swappable driver feature" back instead). The SIGKILL test below already creates
// its own per-test scratch dir; this one is shared by the other three tests.
let scratchCwd: string;
let previousRouteUrl: string | undefined;

before(() => {
  previousRouteUrl = process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL;
  process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL = testHeimdallRouteUrl();
  scratchCwd = mkdtempSync(join(tmpdir(), "minerva-subagent-driver-test-"));
  execFileSync("git", ["init", "-q", scratchCwd]);
  execFileSync("git", ["-C", scratchCwd, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", scratchCwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", scratchCwd, "commit", "-q", "--allow-empty", "-m", "scratch init"]);
});

after(() => {
  if (previousRouteUrl === undefined) {
    delete process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL;
  } else {
    process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL = previousRouteUrl;
  }
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
  //
  // KNOWN EXTERNAL FLAKINESS (2026-07-25, still open upstream): this specific test can hang for
  // the full MINERVA_TURN_TIMEOUT_MS ceiling and fail on an otherwise-healthy machine/token.
  // Root-caused to plugin-hive's globally-registered Stop hook (matcher "" -- fires on every
  // Claude Code session close, not just Hive-initialized projects; reproduced independently in a
  // bare scratch dir with no project-level Hive config at all). The model's own turn completes
  // in ~2s; the background job then sits in "running stop hooks… 0/3" and never reports
  // done/blocked. The three registered Stop hooks declare 10s+15s+5s=30s worst-case combined
  // timeout, yet the observed hang was 10+ minutes, twice, back to back -- a ~20x gap, meaning
  // either the CLI's own hook-timeout enforcement isn't honored in --bg mode, or --bg's
  // background-job status tracking doesn't correctly reflect hook completion. This is NOT a
  // Minerva bug and there is no in-scope fix on Minerva's side: the only CLI flag that disables
  // hooks (--bare) also disables plugin loading entirely, which would break the very
  // `/plugin-hive:kickoff`/`/plugin-hive:plan` invocation Minerva exists to drive. Minerva's own
  // mitigation (this epic: MINERVA_TURN_TIMEOUT_MS + reap-on-timeout) is the correct and
  // sufficient response from Minerva's side -- it can't prevent the hang, but it now degrades
  // gracefully (bounded wait, clean reap, no orphan) instead of hanging or leaking indefinitely,
  // confirmed via the dedicated reap-on-timeout regression test below. This test itself should
  // become reliably fast again once the upstream plugin-hive/Claude-Code-CLI issue is fixed.
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

// Regression test, production finding (2026-07-26): a real kickoff->planning transition turn
// legitimately exceeds the old hardcoded 120s poll ceiling. When SubagentDriver's poll times
// out, the underlying --bg session must still be reaped (stopped) rather than left running --
// previously it was not, and orphaned/accumulating sessions had to be manually `claude stop`'d.
// CLAUDE_TIMEOUT_MS/POLL_CEILING_MS are computed once at driver.ts's module top level, so this
// can't be exercised by importing SubagentDriver directly within this same process (the module
// is already cached with whatever timeout was in effect at first import) -- it goes through the
// full CLI instead, a fresh process per call (AD-1), which naturally picks up a fresh env.
test("SubagentDriver poll timeout reaps the underlying --bg session instead of leaving it running", async () => {
  const minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-reap-"));
  const seedRepo = createSeedRepo();
  try {
    const env = {
      MINERVA_HOME: minervaHome,
      MINERVA_SEED_REPO: seedRepo,
      MINERVA_DRIVER: "subagent",
      MINERVA_DRIVE_MODEL: "claude-haiku-4-5-20251001",
      MINERVA_TURN_TIMEOUT_MS: "3000", // deliberately tiny -- forces a poll timeout fast
      MINERVA_STUB_BG_STUCK: "1",  // stub keeps bg session in "running" state so poll times out
    };

    const started = call("startRun", { idea: "a tiny scratch project" }, env);
    assert.equal(started.status, 1);
    assert.match(started.error.message, /did not reach done\/blocked/);

    // Identify the run's workspace (created by allocateRun before the driver was ever invoked)
    // to find the --bg session dispatched against it.
    const runsDir = join(minervaHome, "runs");
    const runIds = readdirSync(runsDir);
    assert.equal(runIds.length, 1);
    const [runId] = runIds;
    assert.ok(runId);
    const record = JSON.parse(readFileSync(join(runsDir, runId, "run.yaml"), "utf8"));
    // realpath'd: macOS's os.tmpdir() returns /var/folders/... but `claude agents --json`
    // reports the resolved /private/var/folders/... form -- compare like-for-like.
    const workspacePath = realpathSync(record.workspace_path);

    // Give claude's own bookkeeping a moment to reflect our reap call.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Directly confirmed (manual repro, both with and without this fix): a genuinely orphaned
    // session (fix reverted) stays listed in `claude agents --json` with a live pid; a reaped
    // one (fix applied) vanishes from the list entirely -- not merely marked stopped. So strict
    // absence is the correct, non-vacuous assertion here (an earlier version of this test used
    // an `if (found) assert pid dead` shape that passed vacuously either way whenever the entry
    // wasn't found -- confirmed that bug by deliberately reverting the fix and re-running).
    const all = listBackgroundAgentsRaw();
    const orphan = all.find((a) => a.cwd === workspacePath);
    assert.equal(
      orphan,
      undefined,
      `expected no lingering --bg session for this run's workspace after reap; found: ${JSON.stringify(orphan)}, all: ${JSON.stringify(all)}`,
    );
  } finally {
    rmSync(minervaHome, { recursive: true, force: true });
    rmSync(seedRepo, { recursive: true, force: true });
  }
});

// ── sigkill harness: launch + lifetime helpers ───────────────────────────────
//
// The harness must never outlive the test that launched it (PANT-1094 / mdostal/minerva#94):
// an orphan sits on the subagent-driver path and kept calling core-api for hours after its run
// finished. So every harness is spawned into its own process group (detached: true makes the
// tsx launcher a group leader; tsx's real node child, esbuild and the dispatch CLI inherit that
// group), every test kill(-pgid)s that group from a `finally`, and the tests assert the
// processes are actually gone -- not merely that the harness handle returned.

type Harness = {
  launcher: ChildProcess;
  pgid: number;
  /** The real harness process -- tsx runs the script in a child node, not in `launcher`. */
  harnessPid: Promise<number>;
  dispatchedId: Promise<string>;
};

function spawnHarness(cwd: string, env: NodeJS.ProcessEnv = process.env): Harness {
  const launcher = spawn(TSX_BIN, [SIGKILL_HARNESS, "Say hello."], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(launcher.pid, "harness launcher failed to spawn");
  let buf = "";
  launcher.stdout!.setEncoding("utf8").on("data", (d: string) => (buf += d));
  // Synchronize on the harness's own stdout instead of guessing a wall-clock delay.
  const waitFor = (re: RegExp, what: string) =>
    new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        launcher.stdout!.off("data", check);
        reject(new Error(`harness never printed ${what} within 30s; stdout so far: ${JSON.stringify(buf)}`));
      }, 30_000);
      const check = () => {
        const match = buf.match(re);
        if (match?.[1]) {
          clearTimeout(timer);
          launcher.stdout!.off("data", check);
          resolve(match[1]);
        }
      };
      launcher.stdout!.on("data", check);
      check();
    });
  const harnessPid = waitFor(/HARNESS_PID:(\d+)/, "HARNESS_PID:").then(Number);
  const dispatchedId = waitFor(/DISPATCHED:(\S+)/, "DISPATCHED:");
  // Don't let a rejection that a test never awaits (it failed earlier) surface as unhandled.
  harnessPid.catch(() => {});
  dispatchedId.catch(() => {});
  return { launcher, pgid: launcher.pid, harnessPid, dispatchedId };
}

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException).code;
}

/** kill(target, 0) probe; a negative target probes a whole process group. Zombies count as gone. */
function isAlive(target: number): boolean {
  try {
    process.kill(target, 0);
  } catch (e) {
    return errnoCode(e) !== "ESRCH";
  }
  if (target > 0 && process.platform === "linux") {
    try {
      // /proc/<pid>/stat: "pid (comm) STATE ..." -- comm may contain spaces/parens.
      const stat = readFileSync(`/proc/${target}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
    } catch {
      return false;
    }
  }
  return true;
}

async function waitUntilGone(target: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(target)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/** Safety net for every harness test: SIGKILL whatever is left of the group and wait it out. */
async function reapHarnessGroup(h: Harness): Promise<void> {
  try {
    process.kill(-h.pgid, "SIGKILL");
  } catch (e) {
    if (errnoCode(e) !== "ESRCH") throw e;
  }
  await waitUntilGone(-h.pgid, 10_000);
}

function exitOf(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function stopBackgroundSessionsIn(cwd: string): any[] {
  const entries = listBackgroundAgentsRaw().filter((a) => a.cwd === cwd);
  for (const entry of entries) {
    if (entry.id) {
      try {
        execFileSync("claude", ["stop", entry.id]);
      } catch {
        // already stopped/finished -- fine
      }
    }
  }
  return entries;
}

// How long a harness gets to notice its launcher died / its deadline passed and exit on its
// own. The watchdog polls every 200ms; this is generous headroom for a loaded CI box.
const SELF_EXIT_GRACE_MS = 5_000;

test("SIGKILL of the launching process does not orphan or lose the underlying --bg session -- it remains independently trackable, and the harness itself does not outlive it", async () => {
  // realpath'd: macOS's os.tmpdir() returns /var/folders/... but `claude agents --json`
  // reports the resolved /private/var/folders/... form -- compare like-for-like.
  const scratchCwd = realpathSync(mkdtempSync(join(tmpdir(), "minerva-subagent-sigkill-")));
  const h = spawnHarness(scratchCwd);
  try {
    const harnessPid = await h.harnessPid;
    const dispatchedId = await h.dispatchedId;
    assert.notEqual(dispatchedId, "UNKNOWN");
    assert.notEqual(harnessPid, h.launcher.pid, "expected tsx to run the harness in a child process");

    // SIGKILL only the launching process, exactly as before -- not its group. This is the
    // case that used to leak: the real harness process survived, reparented to init.
    h.launcher.kill("SIGKILL");
    await exitOf(h.launcher);

    assert.ok(
      await waitUntilGone(harnessPid, SELF_EXIT_GRACE_MS),
      `harness pid ${harnessPid} outlived its SIGKILL'd launcher by more than ${SELF_EXIT_GRACE_MS}ms -- it would leak`,
    );

    // Confirm the session is still alive/trackable via `claude agents --json`, keyed on cwd
    // (a --bg session's reported prompt-derived "name" isn't reliable to match on, but cwd is).
    const all = listBackgroundAgentsRaw();
    assert.ok(
      all.some((a) => a.cwd === scratchCwd),
      `expected the --bg session to survive its launching process being SIGKILL'd. scratchCwd=${scratchCwd}, dispatchedId=${dispatchedId}, observed cwds=${JSON.stringify(all.map((a) => a.cwd))}`,
    );

    // Release the session we just proved survives, then prove nothing from the harness's own
    // process group (tsx, the real harness, esbuild, the dispatch CLI) is left either -- before
    // the `finally` safety net gets a chance to hide a leak.
    stopBackgroundSessionsIn(scratchCwd);
    assert.ok(
      await waitUntilGone(-h.pgid, SELF_EXIT_GRACE_MS),
      `process group ${h.pgid} still has live members ${SELF_EXIT_GRACE_MS}ms after the harness exited`,
    );
  } finally {
    await reapHarnessGroup(h);
    stopBackgroundSessionsIn(scratchCwd);
    rmSync(scratchCwd, { recursive: true, force: true });
  }
});

test("SIGKILL of the harness process itself leaves nothing from its process group behind", async () => {
  const scratchCwd = realpathSync(mkdtempSync(join(tmpdir(), "minerva-subagent-sigkill-self-")));
  const h = spawnHarness(scratchCwd);
  try {
    const harnessPid = await h.harnessPid;
    await h.dispatchedId;

    // No JS exit path runs on SIGKILL, so nothing inside the harness can clean up here.
    process.kill(harnessPid, "SIGKILL");
    await exitOf(h.launcher);
    stopBackgroundSessionsIn(scratchCwd);

    assert.ok(await waitUntilGone(harnessPid, SELF_EXIT_GRACE_MS), `harness pid ${harnessPid} survived SIGKILL`);
    assert.ok(
      await waitUntilGone(-h.pgid, SELF_EXIT_GRACE_MS),
      `process group ${h.pgid} still has live members ${SELF_EXIT_GRACE_MS}ms after the harness was SIGKILL'd`,
    );
  } finally {
    await reapHarnessGroup(h);
    stopBackgroundSessionsIn(scratchCwd);
    rmSync(scratchCwd, { recursive: true, force: true });
  }
});

test("the sigkill harness exits on its own at its hard deadline even if nobody ever kills it", async () => {
  const scratchCwd = realpathSync(mkdtempSync(join(tmpdir(), "minerva-subagent-sigkill-deadline-")));
  const h = spawnHarness(scratchCwd, { ...process.env, MINERVA_SIGKILL_HARNESS_DEADLINE_MS: "3000" });
  try {
    const harnessPid = await h.harnessPid;
    await h.dispatchedId;

    // Nobody kills anything: the deadline alone must end it.
    let timer: NodeJS.Timeout | undefined;
    const { code } = await Promise.race([
      exitOf(h.launcher),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("harness ignored its 3000ms hard deadline")), 3_000 + SELF_EXIT_GRACE_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(code, 124, "expected the harness's deadline exit code to propagate through tsx");
    stopBackgroundSessionsIn(scratchCwd);

    assert.ok(await waitUntilGone(harnessPid, SELF_EXIT_GRACE_MS), `harness pid ${harnessPid} outlived its deadline`);
    assert.ok(
      await waitUntilGone(-h.pgid, SELF_EXIT_GRACE_MS),
      `process group ${h.pgid} still has live members after the harness's deadline exit`,
    );
  } finally {
    await reapHarnessGroup(h);
    stopBackgroundSessionsIn(scratchCwd);
    rmSync(scratchCwd, { recursive: true, force: true });
  }
});
