// operator-token.ts — the operator token Minerva sends on every write to Pantheon core-api (PANT-1093).
//
// Under PANTHEON_REQUIRE_OPERATOR_TOKEN=enforce core-api answers 401 to any mutating /api/* call
// without the `x-pantheon-operator-token` header. Minerva's writes (POST /api/route/select, the
// /api/backlog/issues writes in plan-runner) sent none, so enforce killed every headless plan run
// at route selection.
//
// The token is resolved the way every other god resolves it: ask core-api to inject it onto the
// shared secrets volume (POST /api/secrets/inject, itself exempt from the guard precisely so a
// caller can fetch the token it cannot yet present), read the file, delete it. Same contract as
// pantheon-v2's lib/operator-token-client.ts:
//
//   - one inject per refresh interval, not per request;
//   - a refresh that fails keeps the last token that worked;
//   - when no token can be resolved the request still goes out without it and the reason is
//     logged once, so a token outage degrades (works under `warn`, surfaces as a 401 in
//     bin/operator-token-check.sh under `enforce`) instead of hard-failing here.
//
// Env: PANTHEON_SECRETS_SHARED_DIR (default /pantheon-secrets; the inject is skipped when it does
// not exist, i.e. outside a container that mounts the volume), MINERVA_OPERATOR_TOKEN_INJECT=off
// (set by the test suite so it never asks a live core-api for a secret).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolvePantheonCoreApiUrl } from "./pantheon-core-api.ts";

export const OPERATOR_TOKEN_HEADER = "x-pantheon-operator-token";
export const OPERATOR_TOKEN_TAGS = "provider=pantheon,kind=operator-token";
const TOKEN_ENV_KEY = "PANTHEON_OPERATOR_TOKEN";
const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
const INJECT_TIMEOUT_MS = 5_000;

type InjectFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface OperatorTokenDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: InjectFetch;
  dirExists?: (dir: string) => boolean;
  readFile?: (filePath: string) => Promise<string>;
  deleteFile?: (filePath: string) => Promise<void>;
  generateId?: () => string;
  now?: () => number;
  refreshIntervalMs?: number;
  logger?: { warn(message: string): void };
}

let cache: { token?: string; at: number } | undefined;
const loggedReasons = new Set<string>();

/** Test-only: forget the resolved token and which reasons were already logged. */
export function resetOperatorTokenCache(): void {
  cache = undefined;
  loggedReasons.clear();
}

/** Reads `KEY=value` out of a `format: "env"` inject, tolerating `export`, quotes and a trailing newline. */
export function parseEnvFile(contents: string, key: string): string | undefined {
  for (const line of contents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || match[1] !== key) continue;
    return match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

// Returns the token, or the reason it could not be resolved. Never throws;
// `off` resolves to nothing, silently.
async function resolveToken(deps: OperatorTokenDeps): Promise<{ token: string } | { reason: string } | null> {
  const env = deps.env ?? process.env;
  if (env.MINERVA_OPERATOR_TOKEN_INJECT === "off") return null;
  const base = resolvePantheonCoreApiUrl(env);
  if (!base) return { reason: "no core-api URL configured" };
  const sharedDir = env.PANTHEON_SECRETS_SHARED_DIR?.trim() || "/pantheon-secrets";
  if (!(deps.dirExists ?? existsSync)(sharedDir)) return { reason: `secrets volume ${sharedDir} is not mounted` };

  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as InjectFetch);
  const filePath = join(sharedDir, `minerva-operator-token-${(deps.generateId ?? randomUUID)()}.env`);
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, "")}/api/secrets/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: OPERATOR_TOKEN_TAGS, target: "file", path: filePath, format: "env", key: TOKEN_ENV_KEY }),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    if (!res.ok) return { reason: `inject answered HTTP ${res.status}` };
    const token = parseEnvFile(await (deps.readFile ?? ((p) => readFile(p, "utf8")))(filePath), TOKEN_ENV_KEY);
    return token ? { token } : { reason: `inject wrote no ${TOKEN_ENV_KEY}` };
  } catch (e) {
    return { reason: e instanceof Error ? e.message : String(e) };
  } finally {
    await (deps.deleteFile ?? unlink)(filePath).catch(() => {});
  }
}

/**
 * The request headers for a core-api write: `base` plus the operator token when it resolves.
 * Never throws; without a token the headers go out unchanged.
 */
export async function withOperatorToken(
  base: Record<string, string> = {},
  deps: OperatorTokenDeps = {},
): Promise<Record<string, string>> {
  const now = deps.now ?? Date.now;
  if (!cache || now() - cache.at >= (deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS)) {
    const resolved = await resolveToken(deps);
    if (resolved && "reason" in resolved && !loggedReasons.has(resolved.reason)) {
      loggedReasons.add(resolved.reason);
      (deps.logger ?? console).warn(
        `minerva: operator token unavailable (${resolved.reason}); core-api writes go out without it`,
      );
    }
    cache = { token: resolved && "token" in resolved ? resolved.token : cache?.token, at: now() };
  }
  return cache.token ? { ...base, [OPERATOR_TOKEN_HEADER]: cache.token } : { ...base };
}
