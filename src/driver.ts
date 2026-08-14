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
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { classificationSchemaArgs, classificationOnlySchemaArgs, extractClassification } from "./escalation-classification.ts";
import { listEnvelopes } from "./envelope-detection.ts";

const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
const DEFAULT_HEIMDALL_URL = "http://127.0.0.1:4870";
const DEFAULT_ROUTE_TIMEOUT_MS = 10_000;
// Heimdall routes by runtime/provider; Minerva needs the spawnable CLI.
const RUNTIME_CLI: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "opencode",
  grok: "opencode",
  opencode: "opencode",
};

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

// Goblin PAN-7572 (turn-timeout-SIGKILLs-long-plans-loses-work): a turn that legitimately runs
// past CLAUDE_TIMEOUT_MS was previously indistinguishable, at the call site, from a genuine
// crash/malformed-output failure -- both surfaced as a plain Error, so kickoff-engine had no
// way to tell "this turn just needs another attempt" from "this turn is actually broken" and
// let a single slow architectural-planning turn destroy the whole run with no resume. Thrown
// ONLY when spawnRuntime's own timer (not an external SIGINT/SIGTERM) killed the child --
// kickoff-engine's retry wrapper (runTurnResumable) catches exactly this type.
export class TurnTimeoutError extends Error {
  constructor(
    message: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "TurnTimeoutError";
  }
}

// fix-heimdall-route-fail-fast-with-fallback: resolveRuntimeRoute() used to throw a plain,
// untyped Error on any Heimdall failure (unreachable, non-2xx, malformed body), and every one
// of its call sites (SpawnDriver/SubagentDriver/ForkedHiveDriver.dispatchFresh/
// ForkedHiveDriver.classify, plus submitAnswers via driverForRecord()'s default fallback) called
// it with zero try/catch -- two real startRun invocations against dev both failed before a
// single question was ever surfaced. HeimdallRouteError is the distinguishable, catchable type
// this story introduces so a Heimdall routing failure is no longer indistinguishable from any
// other bug. It deliberately does NOT extend TurnTimeoutError: a routing failure is not a "ran
// long" condition (kickoff-engine's runTurnResumable retries only `instanceof TurnTimeoutError`)
// -- retrying it would mask a real outage as a transient blip and multiply load against a
// service that may already be reporting down. This story does not add a new ErrorCode for it
// (that's add-upstream-error-code's job, mapping this type at the dispatch layer); it only makes
// the throw type-distinguishable.
export class HeimdallRouteError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "HeimdallRouteError";
  }
}

export interface RuntimeRoute {
  cli: string;
  model: string;
}

type RouteFetch = (
  input: string,
  init: { method: "GET"; signal: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}>;

function resolveRouteTimeoutMs(): number {
  const raw = process.env.MINERVA_HEIMDALL_ROUTE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_ROUTE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid MINERVA_HEIMDALL_ROUTE_TIMEOUT_MS value "${raw}" -- expected a positive number of milliseconds`,
    );
  }
  return parsed;
}

// Heimdall's /available-route only accepts task-type=planning|build|review (a closed enum --
// see heimdall/src/core/task-type.ts's TASK_TYPES); "kickoff" was never a valid value and Heimdall
// rejects it with HTTP 400 invalid_task_type. This driver's turns (SpawnDriver/SubagentDriver/
// ForkedHiveDriver) exclusively serve startRun, which drives plugin-hive's kickoff+plan skills to
// completion (research, design discussion, story decomposition -- see src/plan-runner.ts) and
// never touches code implementation or code review. That makes "planning" the correct task type
// here, corroborated by src/agnostic-plan-driver.ts's resolvePlanningRoute(), which already calls
// Heimdall with task-type=planning for Minerva's own planning-flavored turns and is confirmed
// working against a live Heimdall instance.
function availableRouteUrl(): string {
  const exact = process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  if (exact) return exact;
  const base = process.env.MINERVA_HEIMDALL_URL ?? process.env.HEIMDALL_URL ?? DEFAULT_HEIMDALL_URL;
  return new URL("/available-route?task-type=planning", base.endsWith("/") ? base : `${base}/`).toString();
}

// getAdapter()'s own known/distinguished CLI set (opencode, codex; anything else -- including
// "claude" -- silently falls through to ClaudeAdapter there). getAdapter() itself is NOT
// changed by this story: its fallthrough has other callers, and changing its default behavior
// has a larger blast radius than validating this one new env var at the boundary where it's
// read (design-discussion.md §3a). "claude" is included here because it IS a legitimate,
// recognized value for this new config surface even though getAdapter() reaches it via
// fallthrough rather than an explicit branch.
const KNOWN_FALLBACK_CLIS = new Set(["opencode", "codex", "claude"]);

// Optional operator-declared escape hatch: MINERVA_FALLBACK_CLI/MINERVA_FALLBACK_MODEL. Read
// and validated unconditionally, every call, regardless of whether Heimdall ends up being
// reachable -- malformed operator config (only one of the pair set, or an unrecognized CLI) must
// never be silently ignored just because Heimdall happened to succeed this time. Mirrors
// MINERVA_TURN_RETRY_LIMIT/MINERVA_TURN_TIMEOUT_MS's existing "fail loudly on invalid input"
// shape (kickoff-engine.ts:69-80, driver.ts:62-72). Returns null only when NEITHER var is
// meaningfully set (undefined or blank), meaning no fallback is configured at all.
function resolveFallbackRoute(): RuntimeRoute | null {
  const rawCli = process.env.MINERVA_FALLBACK_CLI;
  const rawModel = process.env.MINERVA_FALLBACK_MODEL;
  const cli = rawCli?.trim();
  const model = rawModel?.trim();
  const cliSet = !!cli;
  const modelSet = !!model;

  if (!cliSet && !modelSet) return null;

  if (cliSet !== modelSet) {
    throw new Error(
      `MINERVA_FALLBACK_CLI and MINERVA_FALLBACK_MODEL must both be set together, or both left ` +
        `unset -- got MINERVA_FALLBACK_CLI=${cliSet ? JSON.stringify(cli) : "(unset)"}, ` +
        `MINERVA_FALLBACK_MODEL=${modelSet ? JSON.stringify(model) : "(unset)"}`,
    );
  }

  if (!KNOWN_FALLBACK_CLIS.has(cli!)) {
    throw new Error(
      `Unrecognized MINERVA_FALLBACK_CLI value "${cli}" -- expected one of: ${[...KNOWN_FALLBACK_CLIS].join(", ")}`,
    );
  }

  return { cli: cli!, model: model! };
}

export function parseAvailableRoutePayload(payload: unknown): RuntimeRoute {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const route =
    root && typeof root.route === "object" && root.route !== null
      ? (root.route as Record<string, unknown>)
      : root && typeof root.runtime === "object" && root.runtime !== null
        ? (root.runtime as Record<string, unknown>)
        : root && typeof root.selected_route === "object" && root.selected_route !== null
          ? (root.selected_route as Record<string, unknown>)
        : root && typeof root.selected === "object" && root.selected !== null
          ? (root.selected as Record<string, unknown>)
          : root;

  const rawCli = route?.cli ?? route?.command ?? route?.executable ?? route?.cli_command ?? route?.tool;
  const runtimeName = route?.runtime ?? route?.provider;
  const cli = typeof rawCli === "string" && rawCli.trim()
    ? rawCli.trim()
    : typeof runtimeName === "string" && runtimeName.trim()
      ? RUNTIME_CLI[runtimeName.trim().toLowerCase()] ?? runtimeName.trim()
      : undefined;
  const model = route?.model ?? route?.model_name ?? route?.modelName;
  if (typeof cli !== "string" || cli.trim() === "" || typeof model !== "string" || model.trim() === "") {
    throw new Error(`Heimdall /available-route response must include non-empty cli and model strings`);
  }
  return { cli: cli.trim(), model: model.trim() };
}

export async function resolveRuntimeRoute(fetchImpl: RouteFetch = globalThis.fetch): Promise<RuntimeRoute> {
  // Read + validate the operator fallback config FIRST, unconditionally -- malformed config
  // (partial pair, unrecognized CLI) fails loudly here regardless of whether Heimdall is even
  // reachable. This intentionally throws a plain Error (matching this file's other
  // invalid-env-var precedents), not HeimdallRouteError: it's an operator config mistake, not a
  // Heimdall routing failure.
  const fallback = resolveFallbackRoute();

  const endpoint = availableRouteUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveRouteTimeoutMs());
  try {
    const res = await fetchImpl(endpoint, { method: "GET", signal: controller.signal });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Heimdall /available-route failed with HTTP ${res.status} ${res.statusText}: ${body}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`Heimdall /available-route returned non-JSON output: ${e instanceof Error ? e.message : String(e)}`);
    }
    return parseAvailableRoutePayload(parsed);
  } catch (e) {
    // Heimdall failed (unreachable, non-2xx, malformed/timed-out body). If the operator declared
    // an explicit fallback pair, honor it verbatim -- no inference, exactly what they configured.
    // Otherwise fail fast with a distinguishable, typed error (not a plain Error) rather than the
    // untyped throw this story fixes: every call site (SpawnDriver/SubagentDriver/
    // ForkedHiveDriver.dispatchFresh/.classify, plus submitAnswers) inherits this automatically,
    // since none of them wrap this call in their own try/catch.
    if (fallback) return fallback;
    const reason =
      e instanceof Error && e.name === "AbortError"
        ? `Heimdall /available-route timed out after ${resolveRouteTimeoutMs()}ms`
        : e instanceof Error
          ? e.message
          : String(e);
    throw new HeimdallRouteError(
      `Heimdall routing failed and no MINERVA_FALLBACK_CLI/MINERVA_FALLBACK_MODEL fallback is configured: ${reason}`,
      e,
    );
  } finally {
    clearTimeout(timer);
  }
}

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

export interface TurnResult {
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

function readClaudeOauthTokenFromZshrc(): string | undefined {
  const home = process.env.HOME || homedir();
  try {
    const zshrc = readFileSync(join(home, ".zshrc"), "utf8");
    const match = zshrc.match(
      /(?:^|\n)\s*(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN=(?:"([^"]*)"|'([^']*)'|([^\s#\n]+))/,
    );
    return match?.[1] ?? match?.[2] ?? match?.[3];
  } catch {
    return undefined;
  }
}

export function resolveClaudeSpawnEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...(extraEnv ?? {}) };
  if (!env[CLAUDE_OAUTH_TOKEN_ENV]) {
    const token = readClaudeOauthTokenFromZshrc();
    if (token) env[CLAUDE_OAUTH_TOKEN_ENV] = token;
  }
  return env;
}

function spawnRuntime(route: RuntimeRoute, cwd: string, args: string[], parseOutput: (stdout: string) => TurnResult, extraEnv?: NodeJS.ProcessEnv): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    const env = resolveClaudeSpawnEnv(extraEnv);
    const child = spawn(route.cli, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    inFlightChild = child;

    let stdout = "";
    let stderr = "";
    // Distinguishes "we killed our own child because it ran too long" from any other kill
    // (e.g. killInFlightChild()'s SIGINT/SIGTERM propagation) -- only the former is a retryable
    // TurnTimeoutError; a real external interrupt must keep surfacing as a plain Error so it
    // isn't mistaken for a resumable slow turn.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
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
        if (timedOut) {
          reject(
            new TurnTimeoutError(
              `${route.cli} did not complete within ${CLAUDE_TIMEOUT_MS}ms and was killed`,
              CLAUDE_TIMEOUT_MS,
            ),
          );
        } else {
          reject(new Error(`${route.cli} was killed by signal ${signal}${stderr ? `: ${stderr}` : ""}`));
        }
        return;
      }
      if (code !== 0) {
        reject(new Error(`${route.cli} exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        resolve(parseOutput(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse output from ${route.cli}: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  });
}


export interface RuntimeAdapter {
  formatTurnArgs(model: string, sessionId: string | null, prompt: string, extraArgs?: string[]): string[];
  parseTurnResult(stdout: string): TurnResult;
  formatBackgroundArgs(model: string, sessionId: string | null, prompt: string): string[];
  parseBackgroundDispatch(stdout: string): string;
  formatListAgentsArgs(): string[];
  parseListAgents(stdout: string): BackgroundAgentEntry[];
  formatStopAgentArgs(shortId: string): string[];
}

export class ClaudeAdapter implements RuntimeAdapter {
  formatTurnArgs(model: string, sessionId: string | null, prompt: string, extraArgs: string[] = []): string[] {
    const sessionArgs = sessionId ? ["--resume", sessionId] : ["--session-id", randomUUID()];
    return [
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      ...sessionArgs,
      ...extraArgs,
      prompt,
    ];
  }

  parseTurnResult(stdout: string): TurnResult {
    try {
      return JSON.parse(stdout) as TurnResult;
    } catch (e) {
      throw new Error(`Claude produced non-JSON output: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  formatBackgroundArgs(model: string, sessionId: string | null, prompt: string): string[] {
    return [
      "--bg",
      "--model",
      model,
      "--permission-mode",
      "bypassPermissions",
      ...(sessionId ? ["--resume", sessionId] : []),
      prompt,
    ];
  }

  parseBackgroundDispatch(stdout: string): string {
    const match = stdout.match(/backgrounded\s*[·:]\s*(\S+)/);
    if (!match || !match[1]) {
      throw new Error(`could not parse a background session id from Claude --bg output: ${stdout}`);
    }
    return match[1];
  }

  formatListAgentsArgs(): string[] {
    return ["agents", "--json"];
  }

  parseListAgents(stdout: string): BackgroundAgentEntry[] {
    return JSON.parse(stdout) as BackgroundAgentEntry[];
  }

  formatStopAgentArgs(shortId: string): string[] {
    return ["stop", shortId];
  }
}

function schemaPrompt(prompt: string, extraArgs: string[] = []): string {
  const schemaFlag = extraArgs.indexOf("--json-schema");
  const schema = schemaFlag >= 0 ? extraArgs[schemaFlag + 1] : undefined;
  if (!schema) return prompt;
  return `${prompt}\n\nRespond with exactly one JSON object matching this JSON Schema, with no markdown or prose outside the JSON object:\n${schema}`;
}

function parseJsonLines(stdout: string): unknown[] {
  const values: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed));
    } catch {
      // Formatted/prose output is allowed; callers fall back to raw stdout when no JSON events parse.
    }
  }
  return values;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function findStringByKey(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const nested of Object.values(record)) {
    const found = findStringByKey(nested, keys);
    if (found) return found;
  }
  return undefined;
}

function findAssistantText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    const parts = value.map((item) => findAssistantText(item)).filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("") : undefined;
  }

  const record = value as Record<string, unknown>;
  const role = record.role;
  const type = typeof record.type === "string" ? record.type : "";
  const looksAssistant =
    role === "assistant" ||
    type.includes("assistant") ||
    type.includes("message") ||
    type.includes("text") ||
    type.includes("response") ||
    type.includes("output");

  if (looksAssistant) {
    for (const key of ["result", "message", "content", "text", "delta"]) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate;
      const nested = findAssistantText(candidate);
      if (nested) return nested;
    }
  }

  if (hasOwn(record, "message") || hasOwn(record, "content") || hasOwn(record, "text")) {
    for (const key of ["message", "content", "text"]) {
      const nested = findAssistantText(record[key]);
      if (nested) return nested;
    }
  }

  return undefined;
}

function parseJsonEventTurnResult(stdout: string, fallbackSessionId = randomUUID()): TurnResult {
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<TurnResult>;
      if (
        typeof parsed.session_id === "string" &&
        typeof parsed.result === "string" &&
        typeof parsed.stop_reason === "string" &&
        typeof parsed.is_error === "boolean"
      ) {
        return parsed as TurnResult;
      }
    } catch {
      // Not a single JSON object; try JSONL events below.
    }
  }

  const events = parseJsonLines(stdout);
  const sessionId =
    [...events]
      .reverse()
      .map((event) => findStringByKey(event, ["session_id", "sessionId", "sessionID", "thread_id"]))
      .find((id): id is string => Boolean(id)) ?? fallbackSessionId;
  const result = events
    .map((event) => findAssistantText(event))
    .filter((text): text is string => Boolean(text))
    .join("")
    .trim();

  return {
    is_error: false,
    stop_reason: "end_turn",
    session_id: sessionId,
    result: result || stdout,
  };
}

export class OpencodeAdapter implements RuntimeAdapter {
  formatTurnArgs(model: string, sessionId: string | null, prompt: string, extraArgs: string[] = []): string[] {
    const sessionArgs = sessionId ? ["--session", sessionId] : [];
    return [
      "run",
      "--model",
      model,
      "--format",
      "json",
      "--auto",
      ...sessionArgs,
      schemaPrompt(prompt, extraArgs),
    ];
  }

  parseTurnResult(stdout: string): TurnResult {
    return parseJsonEventTurnResult(stdout);
  }

  formatBackgroundArgs(model: string, sessionId: string | null, prompt: string): string[] {
    throw new Error("Background agents not supported");
  }

  parseBackgroundDispatch(stdout: string): string {
    throw new Error("Background agents not supported");
  }

  formatListAgentsArgs(): string[] {
    throw new Error("Background agents not supported");
  }

  parseListAgents(stdout: string): BackgroundAgentEntry[] {
    throw new Error("Background agents not supported");
  }

  formatStopAgentArgs(shortId: string): string[] {
    throw new Error("Background agents not supported");
  }
}

export class CodexAdapter implements RuntimeAdapter {
  formatTurnArgs(model: string, sessionId: string | null, prompt: string, extraArgs: string[] = []): string[] {
    const commonArgs = [
      "--json",
      "--model",
      model,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
    ];
    const finalPrompt = schemaPrompt(prompt, extraArgs);
    if (sessionId) {
      return ["exec", "resume", ...commonArgs, sessionId, finalPrompt];
    }
    return ["exec", ...commonArgs, finalPrompt];
  }

  parseTurnResult(stdout: string): TurnResult {
    return parseJsonEventTurnResult(stdout);
  }

  formatBackgroundArgs(model: string, sessionId: string | null, prompt: string): string[] {
    throw new Error("Background agents not supported");
  }

  parseBackgroundDispatch(stdout: string): string {
    throw new Error("Background agents not supported");
  }

  formatListAgentsArgs(): string[] {
    throw new Error("Background agents not supported");
  }

  parseListAgents(stdout: string): BackgroundAgentEntry[] {
    throw new Error("Background agents not supported");
  }

  formatStopAgentArgs(shortId: string): string[] {
    throw new Error("Background agents not supported");
  }
}

export function getAdapter(cli: string): RuntimeAdapter {
  if (cli === "opencode") {
    return new OpencodeAdapter();
  }
  if (cli === "codex") {
    return new CodexAdapter();
  }
  return new ClaudeAdapter();
}

export class SpawnDriver implements Driver {
  async runTurn(input: DriverInput): Promise<DriverResult> {
    const route = await resolveRuntimeRoute();
    const adapter = getAdapter(route.cli);
    const args = adapter.formatTurnArgs(route.model, input.sessionId, input.prompt, classificationSchemaArgs());
    const result = await spawnRuntime(route, input.cwd, args, adapter.parseTurnResult.bind(adapter));
    return { session_id: result.session_id, raw_result: result.result };
  }
}

const POLL_INTERVAL_MS = 2_000;
const POLL_CEILING_MS = CLAUDE_TIMEOUT_MS; // same budget as SpawnDriver's own turn timeout
const UTILITY_CMD_TIMEOUT_MS = 15_000; // --bg dispatch / agents --json / stop are fast, bounded ops
const EXTRACTION_INSTRUCTION = "Structure your prior question into the required schema.";

export interface BackgroundAgentEntry {
  id?: string;
  sessionId?: string;
  kind?: string;
  state?: string;
}

function runRuntimeUtility(route: RuntimeRoute, args: string[], cwd?: string): string {
  return execFileSync(route.cli, args, {
    encoding: "utf8",
    timeout: UTILITY_CMD_TIMEOUT_MS,
    cwd,
    env: resolveClaudeSpawnEnv(),
  });
}

function dispatchBackground(route: RuntimeRoute, adapter: RuntimeAdapter, cwd: string, sessionId: string | null, prompt: string): string {
  const args = adapter.formatBackgroundArgs(route.model, sessionId, prompt);
  const out = runRuntimeUtility(route, args, cwd);
  return adapter.parseBackgroundDispatch(out);
}

function listBackgroundAgents(route: RuntimeRoute, adapter: RuntimeAdapter): BackgroundAgentEntry[] {
  const out = runRuntimeUtility(route, adapter.formatListAgentsArgs());
  return adapter.parseListAgents(out).filter((a) => a.kind === "background");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls until the dispatched session's state is done OR blocked -- both represent "the turn
// produced a response and stopped" from Minerva's perspective (confirmed empirically: a --bg
// session that asks a question and waits for input shows state: blocked, not done).
async function pollUntilTerminal(route: RuntimeRoute, adapter: RuntimeAdapter, shortId: string): Promise<BackgroundAgentEntry> {
  const deadline = Date.now() + POLL_CEILING_MS;
  while (Date.now() < deadline) {
    const entry = listBackgroundAgents(route, adapter).find((a) => a.id === shortId);
    if (entry && (entry.state === "done" || entry.state === "blocked")) {
      return entry;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`background session ${shortId} did not reach done/blocked within ${POLL_CEILING_MS}ms`);
}

function stopBackground(route: RuntimeRoute, adapter: RuntimeAdapter, shortId: string): void {
  runRuntimeUtility(route, adapter.formatStopAgentArgs(shortId));
}

// Best-effort reap used on failure paths -- a failure to stop an already-gone/already-stopped
// session must not mask the original error being propagated up to the caller.
function reapBackground(route: RuntimeRoute, adapter: RuntimeAdapter, shortId: string): void {
  try {
    stopBackground(route, adapter, shortId);
  } catch {
    // already stopped/finished/gone -- fine, this is best-effort cleanup on a failure path
  }
}

export class SubagentDriver implements Driver {
  async runTurn(input: DriverInput): Promise<DriverResult> {
    const route = await resolveRuntimeRoute();
    const adapter = getAdapter(route.cli);
    const shortId = dispatchBackground(route, adapter, input.cwd, input.sessionId, input.prompt);

    let entry: BackgroundAgentEntry;
    try {
      entry = await pollUntilTerminal(route, adapter, shortId);
    } catch (e) {
      // Production finding (2026-07-26): a poll timeout previously left the underlying --bg
      // session running and untracked -- never stopped, accumulating and burning tokens until
      // manually reaped. Reap it here even though we're giving up on this turn; the original
      // timeout error still propagates to the caller.
      reapBackground(route, adapter, shortId);
      throw e;
    }

    const fullSessionId = entry.sessionId;
    if (!fullSessionId) {
      reapBackground(route, adapter, shortId);
      throw new Error(`background session ${shortId} reached a terminal state with no sessionId`);
    }
    stopBackground(route, adapter, shortId);

    const args = adapter.formatTurnArgs(route.model, fullSessionId, EXTRACTION_INSTRUCTION, classificationSchemaArgs());
    const result = await spawnRuntime(route, input.cwd, args, adapter.parseTurnResult.bind(adapter));
    return { session_id: result.session_id, raw_result: result.result };
  }
}

// ForkedHiveDriver (forked-driver-integration epic) -- drives the real headless-question-
// protocol shipped in firefly-events/plugin-hive#341 (branch feat/headless-question-protocol).
// Unlike SpawnDriver/SubagentDriver, this driver does NOT keep a live session across the
// question-wait boundary at all -- there is no process running while a question sits
// unanswered, because the protocol hands off via a FILE (.pHive/questions/*.yaml), not a
// tracked background job or a resumed conversation. This is the actual fix for the orphaning
// risk the whole swappable-driver epic exists to address.
//
// CONFIRMED BY THE EPIC'S OWN SPIKE (spike-stateless-model-tier), not assumed:
// (1) Stateless turns are feasible -- a fresh, non---resume claude -p call correctly continues
//     a headless run using on-disk state alone.
// (2) Model tier is NOT the limiting factor -- both Haiku and Sonnet comply reliably once the
//     drive prompt includes an explicit, forceful stop-after-writing-envelope instruction. The
//     bare skill-invocation prompt alone is NOT sufficient regardless of tier: without that
//     instruction, the model fills the ambiguity with its own initiative (self-answering
//     inline, or building/running a self-authored wrapper script that simulates the entire
//     protocol end-to-end in one turn) -- confirmed directly, repeatedly, via transcript
//     inspection. Every prompt this driver sends therefore always appends
//     EXPLICIT_STOP_INSTRUCTION.
//
// STATE ACROSS CALLS: ForkedHiveDriver never uses session_id for --resume (statelessness makes
// that unnecessary). Instead, per the Driver contract's own "opaque from run-manager's
// perspective" design, session_id is repurposed to carry TWO things a stateless driver still
// needs to remember between calls: which envelope+question an incoming answer belongs to, and
// the ORIGINAL skill-invocation prompt (e.g. "/plugin-hive:kickoff {idea}") needed to correctly
// re-dispatch -- confirmed empirically that re-issuing the SAME initial prompt (not a generic
// "continue") is what makes the skill re-check its own on-disk state and progress. See
// EnvelopePointer / encodeEnvelopePointer / decodeEnvelopePointer below.
//
// MULTI-QUESTION ENVELOPES: an envelope's closure invariant (question-envelope-schema.md) means
// it's only consumable once EVERY required question has a non-null answer. writeAnswerOntoEnvelope
// tracks this per-envelope, not per-question -- answering one question in a multi-question
// envelope surfaces the NEXT unanswered question (required or optional, in encounter order)
// with NO new live dispatch at all, until the closure invariant is satisfied; only then does
// this driver re-dispatch the skill to let it consume+progress.
//
// TESTING: point MINERVA_HIVE_PLUGIN_DIR at a local plugin-hive-fork checkout to test/drive
// against the fork directly (via `claude --plugin-dir`) before PR #341 ships in a real release
// -- unset in production once the protocol is installed via the normal marketplace mechanism.

// Optional -- when unset, no --plugin-dir flag is passed and claude relies on whatever
// plugin-hive is installed via the normal marketplace mechanism (the production case, once
// PR #341 ships). Set for local development/testing against a fork checkout.
//
// Read LAZILY (inside the function, not as a module-level const) -- confirmed by a live-test
// failure that a module-level capture reads process.env at import time, which in a test file
// that sets this var inside a before() hook is BEFORE the hook runs (ESM import evaluation
// precedes test-runner hook execution), silently resulting in no --plugin-dir flag ever being
// passed and a silent fallback to the marketplace-installed plugin-hive.
function pluginDirArgs(): string[] {
  const dir = process.env.MINERVA_HIVE_PLUGIN_DIR;
  return dir ? ["--plugin-dir", dir] : [];
}

// Confirmed directly and repeatedly (the epic's own spike) to be necessary and sufficient --
// without this, both Haiku and Sonnet self-simulate the entire protocol in one turn instead of
// stopping for a real orchestrator answer, regardless of model tier.
//
// Second confirmed finding (real-forked-hive-driver story, live-integration debugging): a model
// resolving `from hive.lib.question_gateway import ask_or_emit` via the Bash tool naturally `cd`s
// into $CLAUDE_PLUGIN_ROOT first so the `hive` package import succeeds. But
// ask_or_emit()/askOrEmit()'s default base_dir is Path.cwd() (resp. process.cwd()) at CALL time
// -- so a `cd`-first invocation writes the envelope under the PLUGIN directory's own
// .pHive/questions/, not the actual project's, and ForkedHiveDriver (which only ever looks under
// the project cwd) never finds it. Confirmed empirically: invoking instead with
// `PYTHONPATH="$CLAUDE_PLUGIN_ROOT" python3 -c "..."` (Node equivalent: NODE_PATH, or an absolute
// require/import path) from the project's own unchanged working directory resolves the import
// AND writes the envelope to the correct project-relative path.
//
// Third confirmed finding (same debugging session): even with PYTHONPATH used correctly (no cd),
// a model will sometimes still pass an explicit base_dir kwarg (e.g. base_dir=".pHive", guessing
// it means "the state directory root") to be extra-explicit about where it wants the envelope.
// But ask_or_emit's base_dir, when supplied, IS the exact questions directory itself (internally:
// `Path(base_dir)`, NOT `Path(base_dir) / "questions"`) -- passing base_dir=".pHive" silently
// writes to .pHive/kickoff-*.yaml instead of .pHive/questions/kickoff-*.yaml, which
// listEnvelopes() (always .pHive/questions/ under the project cwd) then never finds. The fix is
// instructional, not a code workaround: never pass base_dir at all -- the default already
// resolves correctly as long as cwd is left unchanged (see the PYTHONPATH finding above).
const EXPLICIT_STOP_INSTRUCTION =
  "\n\nIMPORTANT: You are running headlessly with no human present. When this protocol's " +
  "headless routing tells you to call ask_or_emit()/askOrEmit(), you MUST invoke that real " +
  "function via the Bash tool against hive/lib/question_gateway.py or .js -- do NOT write a " +
  "wrapper script that simulates or loops through phases/rounds. Do NOT `cd` into the plugin " +
  "directory to resolve the import -- that changes your working directory and causes the " +
  "envelope to be written under the PLUGIN's own .pHive/questions/ instead of THIS project's. " +
  "Keep your working directory unchanged (this project's root) and instead set PYTHONPATH (for " +
  "Python) so the import resolves without changing directory, e.g.: " +
  "`PYTHONPATH=\"$CLAUDE_PLUGIN_ROOT\" python3 -c \"from hive.lib.question_gateway import " +
  "ask_or_emit; ...\"` -- or the equivalent NODE_PATH/absolute-require approach for the JS " +
  "gateway. Do NOT pass a base_dir argument to ask_or_emit()/askOrEmit() -- its default already " +
  "resolves to the correct directory as long as your working directory is left unchanged; " +
  "passing base_dir yourself (e.g. base_dir=\".pHive\") is interpreted as the exact questions " +
  "directory itself, not a parent to search under, and will silently write the envelope to the " +
  "wrong path. The MOMENT an envelope is written with status: pending, your response MUST end " +
  "immediately. Do not answer the question yourself, do not continue to the next phase or " +
  "round, do not simulate what an orchestrator would do. Print the envelope path and STOP.";

interface EnvelopePointer {
  envelopePath: string;
  qid: string;
  skillPrompt: string;
}

const POINTER_PREFIX = "forked-hive-driver:";
export const NO_PENDING_SENTINEL = "forked-hive-driver:no-pending-envelope";

export function encodeEnvelopePointer(pointer: EnvelopePointer): string {
  return `${POINTER_PREFIX}${JSON.stringify(pointer)}`;
}

// Never throws -- returns null for the no-pending sentinel or any unrecognized/malformed
// session_id, so a caller can always safely attempt to decode without a try/catch of its own.
export function decodeEnvelopePointer(sessionId: string): EnvelopePointer | null {
  if (!sessionId.startsWith(POINTER_PREFIX) || sessionId === NO_PENDING_SENTINEL) return null;
  try {
    const parsed = JSON.parse(sessionId.slice(POINTER_PREFIX.length));
    if (
      parsed &&
      typeof parsed.envelopePath === "string" &&
      typeof parsed.qid === "string" &&
      typeof parsed.skillPrompt === "string"
    ) {
      return parsed as EnvelopePointer;
    }
    return null;
  } catch {
    return null;
  }
}

// The ONLY write path this driver has. Writes a single question's `answer`, and flips
// `status: answered` only once every REQUIRED question in the envelope has a non-null answer
// (the closure invariant) -- never writes id/skill/phase/provenance/question text/options,
// matching the schema's "Single writer per field group" rule. Returns whether the envelope is
// now fully consumable (closure invariant satisfied), so the caller knows whether to re-dispatch
// the skill or just surface the next question with no new live call.
export function writeAnswerOntoEnvelope(envelopePath: string, qid: string, answer: string): boolean {
  const raw = readFileSync(envelopePath, "utf8");
  const parsed = parseYaml(raw) as any;
  if (!parsed || !Array.isArray(parsed.questions)) {
    throw new Error(`Envelope at ${envelopePath} is malformed -- cannot write answer for qid ${qid}`);
  }
  const question = parsed.questions.find((q: any) => q && q.qid === qid);
  if (!question) {
    throw new Error(`Envelope at ${envelopePath} has no question with qid ${qid}`);
  }
  question.answer = answer;

  const closureSatisfied = parsed.questions.every((q: any) => !q.required || (q.answer !== null && q.answer !== undefined));
  if (closureSatisfied) {
    parsed.status = "answered";
  }
  writeFileSync(envelopePath, stringifyYaml(parsed));
  return closureSatisfied;
}

export class ForkedHiveDriver implements Driver {
  async runTurn(input: DriverInput): Promise<DriverResult> {
    if (input.sessionId === null) {
      return this.dispatchFresh(input.cwd, input.prompt);
    }
    const pointer = decodeEnvelopePointer(input.sessionId);
    if (!pointer) {
      // No pending envelope from the prior turn (NO_PENDING_SENTINEL), or an unrecognized
      // session_id -- treat as a fresh dispatch rather than throwing, matching this epic's
      // "never guess, but degrade gracefully" discipline for an odd-but-not-catastrophic input.
      return this.dispatchFresh(input.cwd, input.prompt);
    }
    return this.answerAndContinue(input.cwd, pointer, input.prompt);
  }

  private async dispatchFresh(cwd: string, skillPrompt: string): Promise<DriverResult> {
    const route = await resolveRuntimeRoute();
    const adapter = getAdapter(route.cli);
    const args = adapter.formatTurnArgs(
      route.model,
      null,
      skillPrompt + EXPLICIT_STOP_INSTRUCTION,
      pluginDirArgs()
    );
    await spawnRuntime(route, cwd, args, adapter.parseTurnResult.bind(adapter), { HIVE_HEADLESS: "1" });
    return this.surfaceNextQuestion(cwd, skillPrompt);
  }

  private async answerAndContinue(cwd: string, pointer: EnvelopePointer, answerText: string): Promise<DriverResult> {
    const closureSatisfied = writeAnswerOntoEnvelope(pointer.envelopePath, pointer.qid, answerText);
    if (!closureSatisfied) {
      // A required sibling question in the SAME envelope is still unanswered -- surface it with
      // no new live dispatch at all.
      return this.surfaceNextQuestion(cwd, pointer.skillPrompt);
    }
    // Every required question now has an answer -- re-dispatch the ORIGINAL skill-invocation
    // prompt (confirmed by the spike: re-issuing the same initial prompt, not a generic
    // "continue", is what makes the skill re-check its own on-disk state and progress).
    return this.dispatchFresh(cwd, pointer.skillPrompt);
  }

  private async surfaceNextQuestion(cwd: string, skillPrompt: string): Promise<DriverResult> {
    const pending = listEnvelopes(cwd).find((e) => e.status === "pending");
    if (!pending) {
      // Zero-envelopes observability: this placeholder fires both when a run legitimately
      // completed AND when no envelope was ever written because MINERVA_HIVE_PLUGIN_DIR is
      // unset against a plugin-hive install that predates PR #341 -- today those two cases are
      // indistinguishable. One structured JSON line to stderr so a real deployment can
      // grep/alert on this. Does NOT change behavior -- the placeholder below is unchanged.
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          event: "forked_hive_driver_no_pending_envelope",
          message:
            "surfaceNextQuestion: zero pending envelopes found -- ambiguous between a legitimately " +
            "complete run and MINERVA_HIVE_PLUGIN_DIR being unset against a pre-#341 plugin-hive " +
            "install that never wrote one",
          cwd,
        }) + "\n",
      );
      // No pending envelope -- the skill likely completed. checkAndMarkComplete() (shared by
      // every Driver implementation) detects this as a filesystem fact independent of
      // raw_result, so this placeholder is never actually consulted for completion detection.
      return {
        session_id: NO_PENDING_SENTINEL,
        raw_result: JSON.stringify({
          question: "(no pending question -- run may be complete)",
          suggested_channel: "human",
          confidence: 0,
          reason: "no pending envelope found after this turn",
        }),
      };
    }

    // Surface the next unanswered question in encounter order -- required or optional. Only
    // required questions gate the closure invariant, but any unanswered question (including an
    // optional one encountered before all required ones are done) is still surfaced rather than
    // silently skipped, so no information the skill asked for is ever lost.
    const next = pending.questions.find((q) => q.answer === null || q.answer === undefined);
    if (!next) {
      // Defensive: every question already has an answer, yet the envelope is still `pending`.
      // Should not happen if writeAnswerOntoEnvelope's own closure check is correct, but this
      // driver never assumes that invariant holds elsewhere -- degrade to the same placeholder
      // as "no pending envelope" rather than surface a question with nothing to ask.
      return {
        session_id: NO_PENDING_SENTINEL,
        raw_result: JSON.stringify({
          question: "(envelope has no unanswered questions)",
          suggested_channel: "human",
          confidence: 0,
          reason: "defensive fallback -- envelope pending but every question already answered",
        }),
      };
    }

    const classification = await this.classify(cwd, next.text);
    const pointer: EnvelopePointer = { envelopePath: pending.path, qid: next.qid, skillPrompt };
    const rawResult = JSON.stringify({
      question: next.text,
      suggested_channel: classification.suggested_channel,
      confidence: classification.confidence,
      reason: classification.reason,
      kind: next.kind,
      options: next.options,
      qid: next.qid,
    });
    return { session_id: encodeEnvelopePointer(pointer), raw_result: rawResult };
  }

  private async classify(cwd: string, questionText: string) {
    const route = await resolveRuntimeRoute();
    const adapter = getAdapter(route.cli);
    const args = adapter.formatTurnArgs(
      route.model,
      null,
      `Classify this question, which will be asked on Minerva's behalf: ${questionText}`,
      classificationOnlySchemaArgs()
    );
    const result = await spawnRuntime(route, cwd, args, adapter.parseTurnResult.bind(adapter));
    return extractClassification(result.result);
  }
}
