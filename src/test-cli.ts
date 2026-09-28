// Shared test helper: spawn the real bin/minerva.ts subprocess (no mocking the CLI
// boundary, per AD-1). Used across every story's tests from run-workspace-allocation on.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "minerva.ts");
const DEFAULT_TEST_MODEL = "claude-haiku-4-5-20251001";

export function testHeimdallRouteUrl(model = DEFAULT_TEST_MODEL, cli = "claude"): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ cli, model }))}`;
}

function withDefaultTestRoute(env: Record<string, string>): Record<string, string> {
  if (
    env.MINERVA_PANTHEON_ROUTE_SELECT_URL ||
    env.MINERVA_PANTHEON_CORE_API_URL ||
    process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL ||
    process.env.MINERVA_PANTHEON_CORE_API_URL
  ) {
    return env;
  }
  const model = env.MINERVA_DRIVE_MODEL ?? process.env.MINERVA_DRIVE_MODEL ?? DEFAULT_TEST_MODEL;
  return { MINERVA_PANTHEON_ROUTE_SELECT_URL: testHeimdallRouteUrl(model), ...env };
}

export function runCli(
  input: string,
  env: Record<string, string> = {},
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", BIN], {
      input,
      encoding: "utf8",
      env: { ...process.env, ...withDefaultTestRoute(env) },
    });
    return { stdout, status: 0 };
  } catch (e: any) {
    return { stdout: e.stdout ?? "", status: e.status ?? 1 };
  }
}

export function call(
  method: string,
  params: Record<string, unknown> = {},
  env: Record<string, string> = {},
): { result?: any; error?: any; status: number } {
  const { stdout, status } = runCli(JSON.stringify({ method, params }), env);
  return { ...JSON.parse(stdout), status };
}

export function createSeedRepo(prefix = "minerva-seed-repo-"): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "dev", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "seed init"]);
  return repo;
}

// Hermetic by default: every test run puts a stub `claude` binary (bin/stub-claude.ts) first on
// PATH, simulating just enough CLI surface for the suite, so `npm test` never makes real, paid,
// nondeterministic model calls -- even on a machine with a logged-in `claude`. Set
// MINERVA_TEST_REAL_CLAUDE=1 to opt into live integration against the real CLI instead; that mode
// probes `claude -p` once and falls back to the stub when real auth is unavailable.
function setupStubClaude(): boolean {
  const stubPath = join(__dirname, "..", "bin", "stub-claude.ts");
  const tsxDir = join(__dirname, "..", "node_modules", "tsx");
  const preflightCjs = join(tsxDir, "dist", "preflight.cjs");
  const loaderMjs = join(tsxDir, "dist", "loader.mjs");
  if (!existsSync(stubPath) || !existsSync(preflightCjs) || !existsSync(loaderMjs)) return false;
  try {
    const tmpDir = mkdtempSync(join(tmpdir(), "stub-claude-bin-"));
    // Use node directly with tsx's loader flags so the stub runs in a SINGLE node process --
    // when tsx is invoked as a binary it spawns a child node process to run the TypeScript, which
    // means kill("SIGKILL") on the spawned child kills the tsx parent but leaves the actual stub
    // running as an orphan. Running node directly with tsx as a loader avoids this second process.
    const loaderUrl = `file://${loaderMjs}`;
    const script = `#!/bin/sh\nexec node --require "${preflightCjs}" --import "${loaderUrl}" "${stubPath}" "$@"\n`;
    const scriptPath = join(tmpDir, "claude");
    writeFileSync(scriptPath, script, { encoding: "utf8" });
    chmodSync(scriptPath, 0o755);
    process.env.PATH = `${tmpDir}:${process.env.PATH ?? ""}`;
    process.env.STUB_CLAUDE_STATE_FILE = join(tmpdir(), `stub-claude-state-${Date.now()}.json`);
    return true;
  } catch {
    return false;
  }
}

export const REAL_CLAUDE_REQUESTED: boolean = process.env.MINERVA_TEST_REAL_CLAUDE === "1";

function probeRealClaude(): boolean {
  const result = spawnSync(
    "claude",
    ["-p", "--model", DEFAULT_TEST_MODEL, "--output-format", "json",
     "--permission-mode", "bypassPermissions", "--session-id",
     "00000000-0000-0000-0000-000000000001", "ping"],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.error || result.status !== 0) return false;
  try {
    return !(JSON.parse(result.stdout) as { is_error?: boolean }).is_error;
  } catch {
    return false;
  }
}

function detectClaudeAuthAvailable(): { available: boolean; stubActive: boolean } {
  if (process.env.MINERVA_SKIP_CLAUDE_INTEGRATION === "1") {
    return { available: false, stubActive: false };
  }
  if (REAL_CLAUDE_REQUESTED && probeRealClaude()) {
    return { available: true, stubActive: false };
  }
  // Never fall through to whatever `claude` is on PATH: a missing stub would silently turn this
  // run into real, paid model calls, so fail loudly instead.
  if (!setupStubClaude()) {
    throw new Error(
      "test-cli: could not install the stub claude (bin/stub-claude.ts + node_modules/tsx) -- run `npm install`, or set MINERVA_TEST_REAL_CLAUDE=1 to use the real CLI",
    );
  }
  return { available: true, stubActive: true };
}

const _detection = detectClaudeAuthAvailable();
export const CLAUDE_AUTH_AVAILABLE: boolean = _detection.available;
export const STUB_CLAUDE_ACTIVE: boolean = _detection.stubActive;
export const REAL_CLAUDE_ACTIVE: boolean = _detection.available && !_detection.stubActive;

export async function mockHeimdallServer(routes: { kickoff?: any; planning?: any }) {
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/route/select") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(routes.planning || routes.kickoff || { runtime: "claude", model: "claude-haiku-4-5" }));
      return;
    }
    res.writeHead(503);
    res.end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r as any));
  return {
    server,
    get url() {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    }
  };
}
export const __pant905TypeErrorProbe: number = "deliberate type error (PANT-905 CI proof, reverted)";
