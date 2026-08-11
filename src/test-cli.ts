// Shared test helper: spawn the real bin/minerva.ts subprocess (no mocking the CLI
// boundary, per AD-1). Used across every story's tests from run-workspace-allocation on.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
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

export async function mockHeimdallServer(routes: { kickoff?: any; planning?: any }) {
  const server = createServer((req, res) => {
    if (req.url === "/available-route?task-type=kickoff") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(routes.kickoff || { cli: "claude", model: "claude-haiku-4-5" }));
      return;
    }
    if (req.url === "/available-route?task-type=planning") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(routes.planning || { runtime: "gemini", model: "gemini-2.5-pro" }));
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

export async function mockConsusServer() {
  const posts: any[] = [];
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/") {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try {
          posts.push(JSON.parse(body));
        } catch(e) {}
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "mock-decision-id" }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r as any));
  return {
    server,
    posts,
    get url() {
      const addr = server.address() as AddressInfo;
      return `http://127.0.0.1:${addr.port}`;
    }
  };
}
