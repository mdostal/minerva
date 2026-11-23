// PANT-1169: spawned claude children get a credential through Pantheon's secrets facade when the
// parent env and ~/.zshrc carry none. All seams injected: no live core-api, no real secrets dir.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CLAUDE_TOKEN_TAGS,
  claudeTokenTags,
  injectedClaudeToken,
  primeClaudeCredential,
  resetClaudeCredentialCache,
  type ClaudeCredentialDeps,
} from "./claude-credential.ts";

const ENV = { PANTHEON_API_URL: "http://core-api:3012/", PANTHEON_SECRETS_SHARED_DIR: "/pantheon-secrets/multica-runtime" };

function harness(overrides: Partial<ClaudeCredentialDeps> = {}) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const warnings: string[] = [];
  const deps: ClaudeCredentialDeps = {
    env: { ...ENV },
    dirExists: () => true,
    generateId: () => "fixed-id",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200 };
    },
    readFile: async () => "CLAUDE_CODE_OAUTH_TOKEN=injected-token\n",
    deleteFile: async (p) => {
      deleted.push(p);
    },
    logger: { warn: (m) => warnings.push(m) },
    ...overrides,
  };
  return { deps, calls, deleted, warnings };
}

beforeEach(() => resetClaudeCredentialCache());

test("resolves the token through /api/secrets/inject, deletes the file, keeps the value in memory only", async () => {
  const { deps, calls, deleted } = harness();
  await primeClaudeCredential(false, deps);

  assert.equal(injectedClaudeToken(), "injected-token");
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN === "injected-token", false, "never written into process.env");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://core-api:3012/api/secrets/inject");
  const file = "/pantheon-secrets/multica-runtime/minerva-claude-credential-fixed-id.env";
  assert.deepEqual(calls[0]!.body, {
    tags: DEFAULT_CLAUDE_TOKEN_TAGS,
    target: "file",
    path: file,
    format: "env",
    key: "CLAUDE_CODE_OAUTH_TOKEN",
  });
  assert.deepEqual(deleted, [file]);
});

test("asks once per process: a resolved token is reused", async () => {
  const { deps, calls } = harness();
  await primeClaudeCredential(false, deps);
  await primeClaudeCredential(false, deps);
  assert.equal(calls.length, 1);
});

test("never asks when the parent already has a credential, or when switched off", async () => {
  const { deps, calls } = harness();
  await primeClaudeCredential(true, deps);
  await primeClaudeCredential(false, { ...deps, env: { ...ENV, MINERVA_CLAUDE_CREDENTIAL_INJECT: "off" } });
  assert.equal(calls.length, 0);
  assert.equal(injectedClaudeToken(), undefined);
});

test("standalone use is unchanged: no core-api URL or no secrets volume resolves nothing, logs once, never throws", async () => {
  const noUrl = harness({ env: { PANTHEON_SECRETS_SHARED_DIR: "/x" } });
  await primeClaudeCredential(false, noUrl.deps);
  assert.equal(noUrl.calls.length, 0);
  assert.equal(injectedClaudeToken(), undefined);
  assert.match(noUrl.warnings[0]!, /no core-api URL configured/);

  resetClaudeCredentialCache();
  const noDir = harness({ dirExists: () => false });
  await primeClaudeCredential(false, noDir.deps);
  assert.equal(noDir.calls.length, 0);
  assert.match(noDir.warnings[0]!, /secrets volume \/pantheon-secrets\/multica-runtime is not mounted/);
});

test("a failing facade still deletes the file, logs the reason once and retries only after the interval", async () => {
  let now = 1_000;
  const { deps, calls, deleted, warnings } = harness({
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: false, status: 403 };
    },
    now: () => now,
    retryIntervalMs: 60_000,
  });

  await primeClaudeCredential(false, deps);
  await primeClaudeCredential(false, deps);
  assert.equal(calls.length, 1, "no second inject inside the retry interval");
  assert.equal(deleted.length, 1);
  assert.equal(injectedClaudeToken(), undefined);

  now += 60_000;
  await primeClaudeCredential(false, deps);
  assert.equal(calls.length, 2);
  assert.equal(warnings.length, 1, "the same reason is logged once");
  assert.match(warnings[0]!, /HTTP 403/);
});

test("a thrown fetch or an empty file resolves nothing and never throws", async () => {
  const thrown = harness({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); } });
  await primeClaudeCredential(false, thrown.deps);
  assert.equal(injectedClaudeToken(), undefined);
  assert.match(thrown.warnings[0]!, /ECONNREFUSED/);
  assert.equal(thrown.deleted.length, 1);

  resetClaudeCredentialCache();
  const empty = harness({ readFile: async () => "" });
  await primeClaudeCredential(false, empty.deps);
  assert.equal(injectedClaudeToken(), undefined);
  assert.match(empty.warnings[0]!, /wrote no CLAUDE_CODE_OAUTH_TOKEN/);
});

test("tag selector: MINERVA_CLAUDE_TOKEN_TAGS, then the runtime's MULTICA_RUNTIME_CLAUDE_TOKEN_TAGS, then the default", () => {
  assert.equal(claudeTokenTags({}), DEFAULT_CLAUDE_TOKEN_TAGS);
  assert.equal(claudeTokenTags({ MULTICA_RUNTIME_CLAUDE_TOKEN_TAGS: "provider=anthropic,project=x" }), "provider=anthropic,project=x");
  assert.equal(
    claudeTokenTags({ MINERVA_CLAUDE_TOKEN_TAGS: " provider=anthropic,project=y ", MULTICA_RUNTIME_CLAUDE_TOKEN_TAGS: "provider=anthropic,project=x" }),
    "provider=anthropic,project=y",
  );
});
