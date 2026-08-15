// agnostic-plan-driver.ts — runner-agnostic PLAN driver.
//
// Minerva's planning turn drives plugin-hive's `/plugin-hive:plan` DECOMPOSE skill. That skill
// is a Claude-Code slash command: non-Claude runtimes never load it, so they IMPLEMENT instead
// of DECOMPOSE and write zero `.pHive` YAML — coupling planning to a Claude balance.
//
// This driver removes that coupling. It asks Heimdall which runtime should serve planning
// (`/available-route?task-type=planning`) and, when that runtime is NOT claude, spawns the
// ported entrypoint (plugin-hive `hive/agnostic/plan-agnostic.mjs`) which feeds the identical
// DECOMPOSE contract to the routed runtime (gemini/codex via opencode) and lets it WRITE the
// `.pHive/epics/<id>/epic.yaml` + `stories/*.yaml` that output-emitter files to Multica.
//
// BULLETPROOF CLAUDE FALLBACK: resolveAgnosticPlanDriver() returns null on ANY doubt — feature
// off, test mode, Heimdall unreachable, route is claude/absent, the ported CLI missing, or
// opencode missing. A null result means the caller keeps the built-in claude SpawnDriver, so
// planning NEVER breaks on an unavailable route or port.

import { spawn, execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TurnTimeoutError, type Driver, type DriverInput, type DriverResult } from "./driver.ts";

function getHeimdallUrl() {
  return process.env.MINERVA_HEIMDALL_URL ?? process.env.HEIMDALL_URL ?? "http://localhost:4870";
}
const ROUTE_TIMEOUT_MS = Number(process.env.MINERVA_PLAN_ROUTE_TIMEOUT_MS ?? 2000);
const TURN_TIMEOUT_MS = Number(process.env.MINERVA_TURN_TIMEOUT_MS ?? 600_000);

export interface PlanningRoute {
  runtime: string;
  model: string;
}

/** Candidate locations for the ported CLI; env override wins. First existing path is used. */
export function agnosticPlanCliPath(): string | null {
  // Resolve every hit to its REAL path (following symlinks). The ported CLI guards its main()
  // on `fileURLToPath(import.meta.url) === process.argv[1]`. Node resolves import.meta.url
  // THROUGH symlinks, but process.argv[1] keeps whatever path we spawn it with, so invoking the
  // CLI via a symlinked directory (this host's ~/code -> ~/Documents/work/dostal/code) makes
  // that guard FALSE: main() never runs, the CLI exits 0 with empty stdout, no .pHive plan is
  // written, and the run parks with 0 stories. Canonicalizing here makes the spawned argv[1] the
  // realpath, so the guard holds and the planner actually runs.
  const canon = (p: string): string | null => {
    if (!existsSync(p)) return null;
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const override = process.env.HIVE_PLAN_AGNOSTIC_CLI;
  if (override) return canon(override);
  const candidates = [
    // plugin-hive-fork-dev is where the merged agnostic-planning port actually lives on this
    // host; plugin-hive-fork carries the branch but its working tree has hive/agnostic empty.
    join(homedir(), "code", "plugin-hive-fork-dev", "hive", "agnostic", "plan-agnostic.mjs"),
    join(homedir(), "Code", "plugin-hive-fork-dev", "hive", "agnostic", "plan-agnostic.mjs"),
    join(homedir(), "code", "plugin-hive-fork", "hive", "agnostic", "plan-agnostic.mjs"),
    join(homedir(), "Code", "plugin-hive-fork", "hive", "agnostic", "plan-agnostic.mjs"),
    join(homedir(), ".claude", "plugins", "plugin-hive", "hive", "agnostic", "plan-agnostic.mjs"),
  ];
  for (const p of candidates) {
    const r = canon(p);
    if (r) return r;
  }
  // Silent-null-fallback observability (PAN-7734 starved a build lane before anyone noticed
  // this): one structured JSON line to stderr, naming every candidate checked, so a real
  // deployment can grep/alert on this instead of the fallback being invisible. Does NOT change
  // behavior -- resolveAgnosticPlanDriver() still falls back to the built-in claude SpawnDriver.
  process.stderr.write(
    JSON.stringify({
      level: "warn",
      event: "agnostic_plan_cli_unresolved",
      message:
        "agnosticPlanCliPath: none of the candidate ported-CLI paths exist; falling back to the built-in claude driver",
      checked_paths: candidates,
    }) + "\n",
  );
  return null;
}

function opencodeAvailable(): boolean {
  const bin = process.env.OPENCODE_BIN ?? "opencode";
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask Heimdall which runtime serves planning. Fail-open: any network/parse/timeout error, a
 * non-200, or a malformed body yields null (→ claude fallback upstream).
 */
export async function resolvePlanningRoute(): Promise<PlanningRoute | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch(`${getHeimdallUrl()}/available-route?task-type=planning`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    const runtime = typeof body.runtime === "string" ? body.runtime : null;
    const model = typeof body.model === "string" ? body.model : null;
    if (!runtime || !model) return null;
    return { runtime, model };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve an AgnosticPlanDriver, or null to keep the built-in claude driver. Null on: feature
 * off, test mode, unreachable/claude route, missing ported CLI, or missing opencode.
 */
export async function resolveAgnosticPlanDriver(): Promise<AgnosticPlanDriver | null> {
  if (process.env.MINERVA_PLAN_AGNOSTIC === "off") return null;
  // Test seam: the automated suite injects a fake driver and swaps the drive prompt; never reach
  // for the network or a real runtime there. Byte-identical to pre-existing behavior in tests.
  if (process.env.MINERVA_TEST_DRIVE_PROMPT) return null;

  const route = await resolvePlanningRoute();
  if (!route) return null;
  if (route.runtime.toLowerCase() === "claude" || route.runtime.toLowerCase() === "anthropic") return null;

  const cli = agnosticPlanCliPath();
  if (!cli) return null;
  if (!opencodeAvailable()) return null;

  return new AgnosticPlanDriver(route.runtime, route.model, cli);
}

/** Reconstruct a driver from persisted run-record fields (used on continuation turns). */
export function agnosticPlanDriverFromRecord(runtime: string, model: string): AgnosticPlanDriver | null {
  const cli = agnosticPlanCliPath();
  if (!cli) return null;
  return new AgnosticPlanDriver(runtime, model, cli);
}

export class AgnosticPlanDriver implements Driver {
  constructor(
    public readonly runtime: string,
    public readonly model: string,
    private readonly cliPath: string,
  ) {}

  async runTurn(input: DriverInput): Promise<DriverResult> {
    const { cwd, sessionId, prompt } = input;
    // First turn: prompt is the idea → --idea (CLI wraps it in the DECOMPOSE contract).
    // Continuation turn: --session <id> --prompt <raw> continues the same runtime session.
    const turnArgs = sessionId
      ? ["--session", sessionId, "--prompt", prompt]
      : ["--idea", prompt];
    const args = [
      this.cliPath,
      "--runtime",
      this.runtime,
      "--model",
      this.model,
      "--cwd",
      cwd,
      ...turnArgs,
    ];

    const stdout = await new Promise<string>((resolve, reject) => {
      // Spawn via the current node binary so PATH/interpreter resolution never bites.
      const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      // See driver.ts's TurnTimeoutError -- same "our own timer, not an external signal" flag
      // so a turn that just ran long (goblin PAN-7572) is retryable, distinct from a genuine
      // crash.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, TURN_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (signal) {
          if (timedOut) {
            return reject(new TurnTimeoutError(`plan-agnostic did not complete within ${TURN_TIMEOUT_MS}ms and was killed`, TURN_TIMEOUT_MS));
          }
          return reject(new Error(`plan-agnostic killed by ${signal}${err ? `: ${err.slice(-500)}` : ""}`));
        }
        if (code !== 0) return reject(new Error(`plan-agnostic exited ${code}${err ? `: ${err.slice(-500)}` : ""}`));
        resolve(out);
      });
    });

    // The CLI prints one JSON line: {"session_id": "...", "result": "..."}.
    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
    const parsed = JSON.parse(line) as { session_id?: string | null; result?: string };
    return { session_id: parsed.session_id ?? "", raw_result: parsed.result ?? "" };
  }
}
