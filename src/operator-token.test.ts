import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CALLER_TOKEN_TAGS,
  OPERATOR_TOKEN_HEADER,
  callerTokenTags,
  parseEnvFile,
  resetOperatorTokenCache,
  withOperatorToken,
  type OperatorTokenDeps,
} from "./operator-token.ts";

beforeEach(() => resetOperatorTokenCache());

// A fake core-api + secrets volume: the inject "writes" the token into an in-memory file map.
function fakeVolume(opts: { token?: string | (() => string | undefined); status?: number } = {}) {
  const files = new Map<string, string>();
  const injects: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const deleted: string[] = [];
  const warnings: string[] = [];
  let clock = 0;
  const deps: OperatorTokenDeps = {
    env: { PANTHEON_API_URL: "http://core-api:3012/", PANTHEON_SECRETS_SHARED_DIR: "/vol" },
    dirExists: (dir) => dir === "/vol",
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      injects.push({ url, headers: init.headers, body });
      const status = opts.status ?? 200;
      const token = typeof opts.token === "function" ? opts.token() : opts.token ?? "tok-1";
      if (status === 200 && token !== undefined) files.set(body.path as string, `${body.key as string}=${token}\n`);
      return { ok: status === 200, status };
    },
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    deleteFile: async (p) => {
      deleted.push(p);
      files.delete(p);
    },
    generateId: () => "uuid-1",
    now: () => clock,
    logger: { warn: (m) => warnings.push(m) },
  };
  return { deps, files, injects, deleted, warnings, advance: (ms: number) => (clock += ms) };
}

test("withOperatorToken injects via /api/secrets/inject, reads the file, deletes it, and adds the header", async () => {
  const v = fakeVolume();
  const headers = await withOperatorToken({ "content-type": "application/json" }, v.deps);
  assert.deepEqual(headers, { "content-type": "application/json", [OPERATOR_TOKEN_HEADER]: "tok-1" });
  assert.equal(v.injects.length, 1);
  assert.equal(v.injects[0]!.url, "http://core-api:3012/api/secrets/inject");
  assert.equal(v.injects[0]!.headers[OPERATOR_TOKEN_HEADER], undefined, "the inject itself carries no token");
  assert.deepEqual(v.injects[0]!.body, {
    tags: "provider=pantheon,kind=caller-token,caller=runtime-agent",
    target: "file",
    path: "/vol/minerva-caller-token-uuid-1.env",
    format: "env",
    key: "PANTHEON_CALLER_TOKEN",
  });
  assert.deepEqual(v.deleted, ["/vol/minerva-caller-token-uuid-1.env"]);
  assert.equal(v.files.size, 0);
  assert.deepEqual(v.warnings, []);
});

test("withOperatorToken caches the token for the refresh interval, then re-injects", async () => {
  let n = 0;
  const v = fakeVolume({ token: () => `tok-${++n}` });
  v.deps.refreshIntervalMs = 1000;
  assert.equal((await withOperatorToken({}, v.deps))[OPERATOR_TOKEN_HEADER], "tok-1");
  v.advance(999);
  assert.equal((await withOperatorToken({}, v.deps))[OPERATOR_TOKEN_HEADER], "tok-1");
  assert.equal(v.injects.length, 1);
  v.advance(1);
  assert.equal((await withOperatorToken({}, v.deps))[OPERATOR_TOKEN_HEADER], "tok-2");
  assert.equal(v.injects.length, 2);
});

test("a failed refresh keeps the last working token", async () => {
  let status = 200;
  const v = fakeVolume();
  const deps: OperatorTokenDeps = {
    ...v.deps,
    refreshIntervalMs: 10,
    fetchImpl: async (url, init) => (status === 200 ? v.deps.fetchImpl!(url, init) : { ok: false, status }),
  };
  assert.equal((await withOperatorToken({}, deps))[OPERATOR_TOKEN_HEADER], "tok-1");
  status = 503;
  v.advance(10);
  assert.equal((await withOperatorToken({}, deps))[OPERATOR_TOKEN_HEADER], "tok-1");
  assert.match(v.warnings.join("\n"), /HTTP 503/);
});

test("an unresolvable token degrades: headers go out unchanged and the reason is logged once", async () => {
  const v = fakeVolume({ status: 500 });
  v.deps.refreshIntervalMs = 1;
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await withOperatorToken({ a: "b" }, v.deps), { a: "b" });
    v.advance(1);
  }
  assert.equal(v.injects.length, 3);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0]!, /caller token unavailable \(inject answered HTTP 500\)/);
  assert.deepEqual(v.deleted.length, 3, "the inject file is cleaned up even when the inject fails");
});

test("a thrown fetch (core-api down) degrades instead of throwing", async () => {
  const v = fakeVolume();
  const deps: OperatorTokenDeps = { ...v.deps, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } };
  assert.deepEqual(await withOperatorToken({}, deps), {});
  assert.match(v.warnings[0]!, /ECONNREFUSED/);
});

test("no inject is attempted without a mounted secrets volume or a core-api URL", async () => {
  const v = fakeVolume();
  assert.deepEqual(await withOperatorToken({}, { ...v.deps, dirExists: () => false }), {});
  assert.match(v.warnings[0]!, /secrets volume \/vol is not mounted/);
  resetOperatorTokenCache();
  assert.deepEqual(await withOperatorToken({}, { ...v.deps, env: { PANTHEON_SECRETS_SHARED_DIR: "/vol" } }), {});
  assert.match(v.warnings[1]!, /no core-api URL configured/);
  assert.equal(v.injects.length, 0);
});

test("MINERVA_OPERATOR_TOKEN_INJECT=off skips the inject silently", async () => {
  const v = fakeVolume();
  const deps = { ...v.deps, env: { ...v.deps.env, MINERVA_OPERATOR_TOKEN_INJECT: "off" } };
  assert.deepEqual(await withOperatorToken({}, deps), {});
  assert.equal(v.injects.length, 0);
  assert.deepEqual(v.warnings, []);
});

test("the core-api URL follows Minerva's precedence (MINERVA_PANTHEON_CORE_API_URL first)", async () => {
  const v = fakeVolume();
  const env = { ...v.deps.env, MINERVA_PANTHEON_CORE_API_URL: "http://override:1" };
  await withOperatorToken({}, { ...v.deps, env });
  assert.equal(v.injects[0]!.url, "http://override:1/api/secrets/inject");
});

// Pantheon first-cut-trust 1c: Minerva fetches its own caller token, never the operator token.

test("without MINERVA_OPERATOR_TOKEN_TAGS the selector is the runtime-agent caller token", () => {
  assert.equal(DEFAULT_CALLER_TOKEN_TAGS, "provider=pantheon,kind=caller-token,caller=runtime-agent");
  assert.deepEqual(callerTokenTags({}), { tags: DEFAULT_CALLER_TOKEN_TAGS });
  assert.deepEqual(callerTokenTags({ MINERVA_OPERATOR_TOKEN_TAGS: "  " }), { tags: DEFAULT_CALLER_TOKEN_TAGS });
});

test("MINERVA_OPERATOR_TOKEN_TAGS sets the selector Minerva injects", async () => {
  const v = fakeVolume();
  const env = { ...v.deps.env, MINERVA_OPERATOR_TOKEN_TAGS: " provider=pantheon, kind=caller-token, caller=minerva " };
  const headers = await withOperatorToken({}, { ...v.deps, env });
  assert.equal(headers[OPERATOR_TOKEN_HEADER], "tok-1");
  assert.equal(v.injects[0]!.body.tags, "provider=pantheon,kind=caller-token,caller=minerva");
});

test("a selector naming the operator token is never requested: no inject, no header, one warning", async () => {
  for (const tags of [
    "provider=pantheon,kind=operator-token",
    "kind=operator-token,project=pantheon",
    "provider=pantheon, KIND = Operator-Token",
  ]) {
    resetOperatorTokenCache();
    const v = fakeVolume();
    v.deps.refreshIntervalMs = 1;
    const deps = { ...v.deps, env: { ...v.deps.env, MINERVA_OPERATOR_TOKEN_TAGS: tags } };
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await withOperatorToken({ a: "b" }, deps), { a: "b" }, tags);
      v.advance(1);
    }
    assert.equal(v.injects.length, 0, `${tags} must not reach core-api`);
    assert.equal(v.warnings.length, 1, tags);
    assert.match(v.warnings[0]!, /names the operator token/);
  }
});

test("a selector that is not key=value pairs is refused before the inject", async () => {
  const v = fakeVolume();
  const deps = { ...v.deps, env: { ...v.deps.env, MINERVA_OPERATOR_TOKEN_TAGS: "runtime-agent" } };
  assert.deepEqual(await withOperatorToken({}, deps), {});
  assert.equal(v.injects.length, 0);
  assert.match(v.warnings[0]!, /not a tag selector/);
});

test("the inject goes to the caller's own dir from PANTHEON_SECRETS_SHARED_DIR", async () => {
  const v = fakeVolume();
  const env = { ...v.deps.env, PANTHEON_SECRETS_SHARED_DIR: "/pantheon-secrets/multica-runtime" };
  const deps = { ...v.deps, env, dirExists: (d: string) => d === "/pantheon-secrets/multica-runtime" };
  assert.equal((await withOperatorToken({}, deps))[OPERATOR_TOKEN_HEADER], "tok-1");
  assert.equal(v.injects[0]!.body.path, "/pantheon-secrets/multica-runtime/minerva-caller-token-uuid-1.env");
});

test("parseEnvFile tolerates export, quotes and surrounding lines", () => {
  assert.equal(parseEnvFile("A=1\nexport PANTHEON_OPERATOR_TOKEN=\"abc\"\n", "PANTHEON_OPERATOR_TOKEN"), "abc");
  assert.equal(parseEnvFile("PANTHEON_OPERATOR_TOKEN=\n", "PANTHEON_OPERATOR_TOKEN"), undefined);
  assert.equal(parseEnvFile("", "PANTHEON_OPERATOR_TOKEN"), undefined);
});
