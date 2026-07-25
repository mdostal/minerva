// Shared test helper: spawn the real bin/minerva.ts subprocess (no mocking the CLI
// boundary, per AD-1). Used across every story's tests from run-workspace-allocation on.

import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "bin", "minerva.ts");

export function runCli(
  input: string,
  env: Record<string, string> = {},
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("npx", ["tsx", BIN], {
      input,
      encoding: "utf8",
      env: { ...process.env, ...env },
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
