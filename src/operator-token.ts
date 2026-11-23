// operator-token.ts — the caller token Minerva sends on every write to Pantheon core-api
// (PANT-1093; Pantheon first-cut-trust 1c).
//
// core-api's guard (PANTHEON_REQUIRE_OPERATOR_TOKEN) refuses a mutating /api/* call without a known
// token in the `x-pantheon-operator-token` header. The header name is historical: since
// first-cut-trust it carries either the operator token or a named caller token from Pantheon's
// config/pantheon-callers.yaml. Minerva runs as a dispatched board agent inside the multica
// runtimes, so its token is the `runtime-agent` caller token, whose route scope covers exactly what
// Minerva writes (POST /api/route/select, the /api/backlog/issues writes in plan-runner).
//
// Minerva never asks for the operator token. Before first-cut-trust it did (hard-coded
// `provider=pantheon,kind=operator-token`), which let any agent in the runtime read the key that
// passes every route. core-api now refuses that selector into a runtime's own secrets dir (403),
// and Minerva refuses to send it at all: a MINERVA_OPERATOR_TOKEN_TAGS carrying
// `kind=operator-token` is logged and nothing is injected. There is no fallback to the old
// selector; it can only fail (403 on the runtime's dir) or leak (on a shared dir).
//
// The token is resolved the way every other god resolves its own: ask core-api to inject it onto
// this caller's secrets dir (POST /api/secrets/inject, itself exempt from the guard precisely so a
// caller can fetch the token it cannot yet present), read the file, delete it. Same contract as
// pantheon-v2's lib/operator-token-client.ts:
//
//   - one inject per refresh interval, not per request;
//   - a refresh that fails keeps the last token that worked;
//   - when no token can be resolved the request still goes out without it and the reason is
//     logged once, so a token outage degrades (works under `warn`, surfaces as a 401 in
//     bin/operator-token-check.sh under `enforce`) instead of hard-failing here.
//
// Env:
//   MINERVA_OPERATOR_TOKEN_TAGS   the Portunus tag selector of Minerva's caller token (default
//                                 provider=pantheon,kind=caller-token,caller=runtime-agent). Never
//                                 the operator token's: a selector with kind=operator-token is refused.
//   PANTHEON_SECRETS_SHARED_DIR   the dir core-api injects into: the runtime's own secrets dir
//                                 (default /pantheon-secrets; the inject is skipped when it does
//                                 not exist, i.e. outside a container that mounts the volume).
//   MINERVA_OPERATOR_TOKEN_INJECT=off  skips the inject (set by the test suite so it never asks a
//                                 live core-api for a secret).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolvePantheonCoreApiUrl } from "./pantheon-core-api.ts";

/** The header core-api's guard reads a token from (pantheon-v2 core/api/middleware/operator-token.ts). */
export const OPERATOR_TOKEN_HEADER = "x-pantheon-operator-token";
/** Pantheon's `runtime-agent` caller (config/pantheon-callers.yaml): the board agents and Minerva. */
export const DEFAULT_CALLER_TOKEN_TAGS = "provider=pantheon,kind=caller-token,caller=runtime-agent";
/** The tag that names the operator token. A selector carrying it is never requested. */
const OPERATOR_TOKEN_KIND = "kind=operator-token";
const TOKEN_ENV_KEY = "PANTHEON_CALLER_TOKEN";
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

/**
 * Minerva's token selector: MINERVA_OPERATOR_TOKEN_TAGS, else the runtime-agent caller token.
 * Returns a reason instead when the selector names the operator token (any `kind=operator-token`
 * item, as core-api's own check reads it) or is not a `key=value,...` list.
 */
export function callerTokenTags(env: NodeJS.ProcessEnv = process.env): { tags: string } | { reason: string } {
  const tags = env.MINERVA_OPERATOR_TOKEN_TAGS?.trim() || DEFAULT_CALLER_TOKEN_TAGS;
  const items = tags.split(",").map((item) => item.trim());
  if (items.some((item) => item.replace(/\s*=\s*/, "=").toLowerCase() === OPERATOR_TOKEN_KIND)) {
    return { reason: `MINERVA_OPERATOR_TOKEN_TAGS names the operator token (${OPERATOR_TOKEN_KIND}); Minerva never requests it, set its own caller token's selector` };
  }
  if (items.some((item) => !/^[^=\s]+\s*=\s*\S/.test(item))) {
    return { reason: `MINERVA_OPERATOR_TOKEN_TAGS is not a tag selector (key=value,...): ${tags}` };
  }
  return { tags: items.join(",") };
}

// Returns the token, or the reason it could not be resolved. Never throws;
// `off` resolves to nothing, silently.
async function resolveToken(deps: OperatorTokenDeps): Promise<{ token: string } | { reason: string } | null> {
  const env = deps.env ?? process.env;
  if (env.MINERVA_OPERATOR_TOKEN_INJECT === "off") return null;
  const selector = callerTokenTags(env);
  if ("reason" in selector) return selector;
  const base = resolvePantheonCoreApiUrl(env);
  if (!base) return { reason: "no core-api URL configured" };
  const sharedDir = env.PANTHEON_SECRETS_SHARED_DIR?.trim() || "/pantheon-secrets";
  if (!(deps.dirExists ?? existsSync)(sharedDir)) return { reason: `secrets volume ${sharedDir} is not mounted` };

  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as InjectFetch);
  const filePath = join(sharedDir, `minerva-caller-token-${(deps.generateId ?? randomUUID)()}.env`);
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, "")}/api/secrets/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: selector.tags, target: "file", path: filePath, format: "env", key: TOKEN_ENV_KEY }),
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
 * The request headers for a core-api write: `base` plus Minerva's caller token, as
 * `x-pantheon-operator-token`, when it resolves.
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
        `minerva: caller token unavailable (${resolved.reason}); core-api writes go out without it`,
      );
    }
    cache = { token: resolved && "token" in resolved ? resolved.token : cache?.token, at: now() };
  }
  return cache.token ? { ...base, [OPERATOR_TOKEN_HEADER]: cache.token } : { ...base };
}
