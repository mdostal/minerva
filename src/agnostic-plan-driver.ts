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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

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
  const override = process.env.HIVE_PLAN_AGNOSTIC_CLI;
  if (override) return existsSync(override) ? override : null;
  const candidates = [
    join(homedir(), "code", "plugin-hive-fork", "hive", "agnostic", "plan-agnostic.mjs"),
    join(homedir(), "Code", "plugin-hive-fork", "hive", "agnostic", "plan-agnostic.mjs"),
    join(homedir(), ".claude", "plugins", "plugin-hive", "hive", "agnostic", "plan-agnostic.mjs"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
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
      const timer = setTimeout(() => child.kill("SIGKILL"), TURN_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        if (signal) return reject(new Error(`plan-agnostic killed by ${signal}${err ? `: ${err.slice(-500)}` : ""}`));
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
