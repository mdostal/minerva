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
// SubagentDriver (claude --bg + poll + stop + resume-extract) and ForkedHiveDriver land in this
// same file in later stories of this epic.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { classificationSchemaArgs } from "./escalation-classification.ts";

const MODEL = process.env.MINERVA_DRIVE_MODEL ?? "claude-haiku-4-5-20251001";
const CLAUDE_TIMEOUT_MS = 120_000;

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
