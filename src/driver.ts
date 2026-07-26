// Driver abstraction (swappable-driver epic) — one method, runTurn(), driving one constrained
// plugin-hive turn -> {session_id, raw_result}. Every Driver implementation is validated
// against the same driver-independent contract in src/types.test.ts.
//
// SpawnDriver is today's mechanism (claude -p / --resume), converted from execFileSync to an
// async spawn(). This is a deliberate deviation from this story's original "keep execFileSync
// unchanged" scope: empirically confirmed (direct SIGINT test against both a plain `sleep` and
// a real `claude -p` child, see this epic's story notes) that execFileSync silently swallows
// SIGINT/SIGTERM while blocked -- a signal handler registered via process.on() never runs until
// the synchronous call returns, so the in-flight child cannot be killed on graceful interrupt
// under any circumstances. Switching to spawn() (async, non-blocking) is the only way real
// SIGINT/SIGTERM hardening is achievable; it keeps the same claude -p arguments and mechanism
// otherwise (still a standalone child_process spawn, not --bg).
//
// SubagentDriver (claude --bg + poll + stop + resume-extract) drives each turn as a genuinely
// independent background service (`claude --bg`), tracked via `claude agents`/`claude stop`,
// that survives its launching process being SIGKILL'd -- confirmed empirically, twice, in this
// epic's own research (a --bg session dispatched, then the launching process itself killed,
// left the background session running and independently trackable). Since --bg is incompatible
// with -p/--output-format json/--json-schema, the turn is dispatched via --bg (natural
// conversation, no schema), polled via `claude agents --json` until state is done or blocked
// (both terminal-for-extraction: "produced a response, stopped"), released via `claude stop`,
// then a `claude -p --resume <session_id> --json-schema` call extracts the same
// {question, suggested_channel, confidence, reason} shape via escalation-classification.ts's
// existing schema/parser, reusing SpawnDriver's own async spawnClaude() for that final call.
//
// Real property, confirmed twice: `--bg --resume <old_id>` returns a DIFFERENT session_id than
// the one resumed, even though conversation context is correctly retained -- this is exactly
// why the Driver contract (above) requires every runTurn() call to return a fresh session_id
// that the caller re-persists every time, not just at start.
//
// ForkedHiveDriver lands in this same file in a later story of this epic.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { classificationSchemaArgs } from "./escalation-classification.ts";

const MODEL = process.env.MINERVA_DRIVE_MODEL ?? "claude-haiku-4-5-20251001";

// Production finding (2026-07-26): a real kickoff->planning transition turn legitimately runs
// past the old hardcoded 120s ceiling, causing SubagentDriver's poll to time out short of
// planning ("did not reach done/blocked within 120000ms"). MINERVA_TURN_TIMEOUT_MS makes this
// configurable, with a much higher default -- fails loudly (not silently) on an invalid value,
// consistent with this epic's "never guess" discipline (see MINERVA_DRIVER's selectDriver() in
// kickoff-engine.ts for the same pattern).
const DEFAULT_TURN_TIMEOUT_MS = 600_000; // 10 min
function resolveTurnTimeoutMs(): number {
  const raw = process.env.MINERVA_TURN_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TURN_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid MINERVA_TURN_TIMEOUT_MS value "${raw}" -- expected a positive number of milliseconds`,
    );
  }
  return parsed;
}
const CLAUDE_TIMEOUT_MS = resolveTurnTimeoutMs();

export interface DriverInput {
  cwd: string;
  sessionId: string | null;
  prompt: string;
}

export interface DriverResult {
  session_id: string;
  raw_result: string;
}

// One constrained turn -> structured result. session_id is always returned fresh, every turn
// -- callers must persist it after EVERY runTurn() call, not just the first. (Real property:
// SubagentDriver's tracked session_id changes on every --bg --resume call even though
// conversation context is correctly retained; baking "always re-persist" into this contract now
// keeps both implementations honest.)
export interface Driver {
  runTurn(input: DriverInput): Promise<DriverResult>;
}

interface ClaudePResult {
  is_error: boolean;
  stop_reason: string;
  session_id: string;
  result: string;
}

// Tracks the single in-flight child so a SIGINT/SIGTERM handler can kill it before the process
// exits. SpawnDriver drives turns one at a time per process (no concurrent children), so a
// single module-level slot is sufficient.
let inFlightChild: ChildProcess | null = null;

function killInFlightChild(): void {
  if (inFlightChild && !inFlightChild.killed) {
    inFlightChild.kill("SIGKILL");
  }
}

// Registered once, at module load. Closes the graceful-interrupt orphaning case (SIGKILL of
// the parent cannot be caught by any process-level handler -- that case is what SubagentDriver
// solves architecturally, not this hardening).
process.on("SIGINT", () => {
  killInFlightChild();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killInFlightChild();
  process.exit(143);
});

function spawnClaude(cwd: string, args: string[]): Promise<ClaudePResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    inFlightChild = child;

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (inFlightChild === child) inFlightChild = null;
      reject(err);
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (inFlightChild === child) inFlightChild = null;
      if (signal) {
        reject(new Error(`claude was killed by signal ${signal}${stderr ? `: ${stderr}` : ""}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as ClaudePResult);
      } catch (e) {
        reject(new Error(`claude produced non-JSON output: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}

export class SpawnDriver implements Driver {
  async runTurn(input: DriverInput): Promise<DriverResult> {
    const sessionArgs = input.sessionId ? ["--resume", input.sessionId] : ["--session-id", randomUUID()];
    const args = [
      "-p",
      "--model",
      MODEL,
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      ...sessionArgs,
      ...classificationSchemaArgs(),
      input.prompt,
    ];
    const result = await spawnClaude(input.cwd, args);
    return { session_id: result.session_id, raw_result: result.result };
  }
}

const POLL_INTERVAL_MS = 2_000;
const POLL_CEILING_MS = CLAUDE_TIMEOUT_MS; // same budget as SpawnDriver's own turn timeout
const UTILITY_CMD_TIMEOUT_MS = 15_000; // --bg dispatch / agents --json / stop are fast, bounded ops
const EXTRACTION_INSTRUCTION = "Structure your prior question into the required schema.";

interface BackgroundAgentEntry {
  id?: string;
  sessionId?: string;
  kind?: string;
  state?: string;
}

function runClaudeUtility(args: string[], cwd?: string): string {
  return execFileSync("claude", args, { encoding: "utf8", timeout: UTILITY_CMD_TIMEOUT_MS, cwd });
}

function dispatchBackground(cwd: string, sessionId: string | null, prompt: string): string {
  const args = [
    "--bg",
    "--model",
    MODEL,
    "--permission-mode",
    "bypassPermissions",
    ...(sessionId ? ["--resume", sessionId] : []),
    prompt,
  ];
  const out = runClaudeUtility(args, cwd);
  const match = out.match(/backgrounded\s*[·:]\s*(\S+)/);
  if (!match || !match[1]) {
    throw new Error(`could not parse a background session id from claude --bg output: ${out}`);
  }
  return match[1];
}

function listBackgroundAgents(): BackgroundAgentEntry[] {
  const out = runClaudeUtility(["agents", "--json"]);
  const parsed = JSON.parse(out) as BackgroundAgentEntry[];
  return parsed.filter((a) => a.kind === "background");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls until the dispatched session's state is done OR blocked -- both represent "the turn
// produced a response and stopped" from Minerva's perspective (confirmed empirically: a --bg
// session that asks a question and waits for input shows state: blocked, not done).
async function pollUntilTerminal(shortId: string): Promise<BackgroundAgentEntry> {
  const deadline = Date.now() + POLL_CEILING_MS;
  while (Date.now() < deadline) {
    const entry = listBackgroundAgents().find((a) => a.id === shortId);
    if (entry && (entry.state === "done" || entry.state === "blocked")) {
      return entry;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`background session ${shortId} did not reach done/blocked within ${POLL_CEILING_MS}ms`);
}

function stopBackground(shortId: string): void {
  runClaudeUtility(["stop", shortId]);
}

// Best-effort reap used on failure paths -- a failure to stop an already-gone/already-stopped
// session must not mask the original error being propagated up to the caller.
function reapBackground(shortId: string): void {
  try {
    stopBackground(shortId);
  } catch {
    // already stopped/finished/gone -- fine, this is best-effort cleanup on a failure path
  }
}

export class SubagentDriver implements Driver {
  async runTurn(input: DriverInput): Promise<DriverResult> {
    const shortId = dispatchBackground(input.cwd, input.sessionId, input.prompt);

    let entry: BackgroundAgentEntry;
    try {
      entry = await pollUntilTerminal(shortId);
    } catch (e) {
      // Production finding (2026-07-26): a poll timeout previously left the underlying --bg
      // session running and untracked -- never stopped, accumulating and burning tokens until
      // manually reaped. Reap it here even though we're giving up on this turn; the original
      // timeout error still propagates to the caller.
      reapBackground(shortId);
      throw e;
    }

    const fullSessionId = entry.sessionId;
    if (!fullSessionId) {
      reapBackground(shortId);
      throw new Error(`background session ${shortId} reached a terminal state with no sessionId`);
    }
    stopBackground(shortId);

    const args = [
      "-p",
      "--model",
      MODEL,
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--resume",
      fullSessionId,
      ...classificationSchemaArgs(),
      EXTRACTION_INSTRUCTION,
    ];
    const result = await spawnClaude(input.cwd, args);
    return { session_id: result.session_id, raw_result: result.result };
  }
}

// Inert stub for the future plugin-hive-fork driver -- the fork doesn't exist yet. Not wired
// into MINERVA_DRIVER's selection logic (see kickoff-engine.ts's selectDriver()); exists as a
// class, not a live option, so there is no way to accidentally select it in production.
// Throws rather than silently no-op-ing or returning fabricated data, consistent with this
// epic's "never guess" discipline (AD-5) -- a Driver that silently no-ops would be worse than
// one that fails loudly, since a caller might not notice the swap happened. When the fork is
// ready, this becomes a real implementation consuming its structured headless-question protocol
// directly (no spawn-and-parse) -- see docs/minerva-next-tests-and-driver-paths.md §3.
export class ForkedHiveDriver implements Driver {
  async runTurn(_input: DriverInput): Promise<DriverResult> {
    throw new Error(
      "ForkedHiveDriver is not implemented yet -- plugin-hive-fork does not exist. " +
        "See docs/minerva-next-tests-and-driver-paths.md §3 for the intended design.",
    );
  }
}
