// claude-credential.ts — the Claude credential Minerva hands to the `claude` children it spawns
// (PANT-1169, mdostal/minerva#99).
//
// Inside Pantheon's Multica runtime the provider credential is injected per task into the agent's
// own process only. Children inherit nothing: CLAUDE_CODE_OAUTH_TOKEN is unset and there is no
// ~/.zshrc, so every `claude -p` the planner spawns answered "Not logged in" and each planning run
// died before its first turn, while the agent itself passed every health check.
//
// resolveClaudeSpawnEnv (driver.ts) tries, in order:
//   1. CLAUDE_CODE_OAUTH_TOKEN already in process.env (standalone use, an operator shell);
//   2. the token exported in ~/.zshrc (a local dev machine);
//   3. the token this module resolved through Pantheon's secrets facade.
//
// (3) uses the same contract as operator-token.ts: ask core-api to inject the secret onto this
// runtime's own secrets dir (POST /api/secrets/inject, open to callers so they can fetch what they
// cannot yet present), read the file, delete it straight away. The value lives only in memory and
// goes only into the child's env, never into process.env. When the facade is unreachable, or this
// is not a container that mounts the secrets volume, nothing changes: the child gets the env it got
// before this module existed, and the reason is logged once.
//
// Env:
//   MINERVA_CLAUDE_TOKEN_TAGS         Portunus tag selector of the Claude credential. Default: the
//                                     runtime's own MULTICA_RUNTIME_CLAUDE_TOKEN_TAGS, else
//                                     provider=anthropic,project=ffevents (the default
//                                     pantheon-v2's bin/multica-runtime-entrypoint.sh resolves).
//   PANTHEON_SECRETS_SHARED_DIR       the dir core-api injects into (default /pantheon-secrets;
//                                     the inject is skipped when it does not exist).
//   MINERVA_CLAUDE_CREDENTIAL_INJECT=off  skips the inject (set by the test suite so it never asks
//                                     a live core-api for a secret).

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolvePantheonCoreApiUrl } from "./pantheon-core-api.ts";
import { parseEnvFile } from "./operator-token.ts";

export const CLAUDE_OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const DEFAULT_CLAUDE_TOKEN_TAGS = "provider=anthropic,project=ffevents";
const DEFAULT_RETRY_INTERVAL_MS = 60_000;
const INJECT_TIMEOUT_MS = 10_000;

type InjectFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

export interface ClaudeCredentialDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: InjectFetch;
  dirExists?: (dir: string) => boolean;
  readFile?: (filePath: string) => Promise<string>;
  deleteFile?: (filePath: string) => Promise<void>;
  generateId?: () => string;
  now?: () => number;
  retryIntervalMs?: number;
  logger?: { warn(message: string): void };
}

// The resolved token is kept for the life of the process (an OAuth token outlives any planning
// run). A failed attempt is remembered so a dead facade costs one inject per retry interval, not
// one per spawned child.
let resolvedToken: string | undefined;
let lastFailureAt: number | undefined;
const loggedReasons = new Set<string>();

/** Test-only: forget the resolved token, the last failure and which reasons were logged. */
export function resetClaudeCredentialCache(): void {
  resolvedToken = undefined;
  lastFailureAt = undefined;
  loggedReasons.clear();
}

/** The token resolved through the facade, if any. Read synchronously by resolveClaudeSpawnEnv. */
export function injectedClaudeToken(): string | undefined {
  return resolvedToken;
}

export function claudeTokenTags(env: NodeJS.ProcessEnv = process.env): string {
  return env.MINERVA_CLAUDE_TOKEN_TAGS?.trim() || env.MULTICA_RUNTIME_CLAUDE_TOKEN_TAGS?.trim() || DEFAULT_CLAUDE_TOKEN_TAGS;
}

async function injectToken(env: NodeJS.ProcessEnv, deps: ClaudeCredentialDeps): Promise<{ token: string } | { reason: string }> {
  const base = resolvePantheonCoreApiUrl(env);
  if (!base) return { reason: "no core-api URL configured" };
  const sharedDir = env.PANTHEON_SECRETS_SHARED_DIR?.trim() || "/pantheon-secrets";
  if (!(deps.dirExists ?? existsSync)(sharedDir)) return { reason: `secrets volume ${sharedDir} is not mounted` };

  const tags = claudeTokenTags(env);
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as InjectFetch);
  const filePath = join(sharedDir, `minerva-claude-credential-${(deps.generateId ?? randomUUID)()}.env`);
  try {
    const res = await fetchImpl(`${base.replace(/\/+$/, "")}/api/secrets/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags, target: "file", path: filePath, format: "env", key: CLAUDE_OAUTH_TOKEN_ENV }),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    if (!res.ok) return { reason: `inject of ${tags} answered HTTP ${res.status}` };
    const token = parseEnvFile(await (deps.readFile ?? ((p) => readFile(p, "utf8")))(filePath), CLAUDE_OAUTH_TOKEN_ENV);
    return token ? { token } : { reason: `inject of ${tags} wrote no ${CLAUDE_OAUTH_TOKEN_ENV}` };
  } catch (e) {
    return { reason: e instanceof Error ? e.message : String(e) };
  } finally {
    await (deps.deleteFile ?? unlink)(filePath).catch(() => {});
  }
}

/**
 * Makes sure a Claude credential is available for spawned children. A no-op when the caller's env
 * already carries one (`hasAmbientToken`), when one was already resolved, or when the inject is
 * switched off. Otherwise asks the facade once. Never throws: a failure is logged once and the
 * child spawns exactly as it did before.
 */
export async function primeClaudeCredential(hasAmbientToken: boolean, deps: ClaudeCredentialDeps = {}): Promise<void> {
  if (hasAmbientToken || resolvedToken) return;
  const env = deps.env ?? process.env;
  if (env.MINERVA_CLAUDE_CREDENTIAL_INJECT === "off") return;
  const now = deps.now ?? Date.now;
  if (lastFailureAt !== undefined && now() - lastFailureAt < (deps.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS)) return;

  const resolved = await injectToken(env, deps);
  if ("token" in resolved) {
    resolvedToken = resolved.token;
    lastFailureAt = undefined;
    return;
  }
  lastFailureAt = now();
  if (!loggedReasons.has(resolved.reason)) {
    loggedReasons.add(resolved.reason);
    (deps.logger ?? console).warn(
      `minerva: no Claude credential for spawned children (${resolved.reason}); they inherit the parent env as-is`,
    );
  }
}
