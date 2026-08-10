// Shared test helper: spawn the real bin/minerva.ts subprocess (no mocking the CLI
// boundary, per AD-1). Used across every story's tests from run-workspace-allocation on.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "minerva.ts");
const DEFAULT_TEST_MODEL = "claude-haiku-4-5-20251001";

export function testHeimdallRouteUrl(model = DEFAULT_TEST_MODEL, cli = "claude"): string {
  return `data:application/json,${encodeURIComponent(JSON.stringify({ cli, model }))}`;
}

function withDefaultTestRoute(env: Record<string, string>): Record<string, string> {
  if (
    env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL ||
    env.MINERVA_HEIMDALL_URL ||
    env.HEIMDALL_URL ||
    process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL ||
    process.env.MINERVA_HEIMDALL_URL ||
    process.env.HEIMDALL_URL
  ) {
    return env;
  }
  const model = env.MINERVA_DRIVE_MODEL ?? process.env.MINERVA_DRIVE_MODEL ?? DEFAULT_TEST_MODEL;
  return { MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL: testHeimdallRouteUrl(model), ...env };
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
