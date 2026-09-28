import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePantheonCoreApiUrl } from "./pantheon-core-api.ts";
import { resolveRuntimeRoute } from "./driver.ts";
import { resolvePlanningRoute } from "./agnostic-plan-driver.ts";
import { resolveIdeaFromTicket, __setPantheonFetchForTest } from "./plan-runner.ts";

const URL_VARS = [
  "MINERVA_PANTHEON_CORE_API_URL",
  "PANTHEON_CORE_API_URL",
  "PANTHEON_API_URL",
  "MINERVA_PANTHEON_ROUTE_SELECT_URL",
  "MINERVA_FALLBACK_CLI",
  "MINERVA_FALLBACK_MODEL",
] as const;

// Run fn with exactly `vars` set among the core-api/route env vars; everything else in URL_VARS is
// cleared (the Pantheon runtime itself exports PANTHEON_API_URL, so the ambient env is not clean).
async function withEnv(vars: Partial<Record<(typeof URL_VARS)[number], string>>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(URL_VARS.map((k) => [k, process.env[k]]));
  for (const k of URL_VARS) delete process.env[k];
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("resolvePantheonCoreApiUrl precedence: MINERVA_PANTHEON_CORE_API_URL > PANTHEON_CORE_API_URL > PANTHEON_API_URL", () => {
  const all = {
    MINERVA_PANTHEON_CORE_API_URL: "http://minerva.test",
    PANTHEON_CORE_API_URL: "http://core.test",
    PANTHEON_API_URL: "http://runtime.test",
  };
  assert.equal(resolvePantheonCoreApiUrl(all), "http://minerva.test");
  assert.equal(resolvePantheonCoreApiUrl({ ...all, MINERVA_PANTHEON_CORE_API_URL: undefined }), "http://core.test");
  assert.equal(resolvePantheonCoreApiUrl({ PANTHEON_API_URL: "http://runtime.test" }), "http://runtime.test");
  assert.equal(resolvePantheonCoreApiUrl({}), null);
});

test("resolvePantheonCoreApiUrl treats blank values as unset", () => {
  assert.equal(
    resolvePantheonCoreApiUrl({ MINERVA_PANTHEON_CORE_API_URL: "  ", PANTHEON_CORE_API_URL: "", PANTHEON_API_URL: "http://runtime.test" }),
    "http://runtime.test",
  );
  assert.equal(resolvePantheonCoreApiUrl({ PANTHEON_API_URL: " " }), null);
});

test("with only PANTHEON_API_URL set, driver route select hits that base URL", async () => {
  await withEnv({ PANTHEON_API_URL: "http://core-api:3012/" }, async () => {
    const urls: string[] = [];
    const route = await resolveRuntimeRoute(async (url) => {
      urls.push(url);
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ runtime: "claude", model: "claude-sonnet-5" }) };
    });
    assert.deepEqual(urls, ["http://core-api:3012/api/route/select"]);
    assert.equal(route.model, "claude-sonnet-5");
  });
});

test("with only PANTHEON_API_URL set, agnostic planning route select hits that base URL", async () => {
  await withEnv({ PANTHEON_API_URL: "http://core-api:3012" }, async () => {
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ runtime: "gemini", model: "gemini-2.5-pro" }), { status: 200 });
    }) as typeof fetch;
    try {
      assert.deepEqual(await resolvePlanningRoute(), { runtime: "gemini", model: "gemini-2.5-pro" });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(urls, ["http://core-api:3012/api/route/select"]);
  });
});

test("with only PANTHEON_API_URL set, backlog calls hit that base URL", async () => {
  await withEnv({ PANTHEON_API_URL: "http://core-api:3012" }, async () => {
    const urls: string[] = [];
    const prev = __setPantheonFetchForTest(async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "PANT-1", title: "Plan me", description: "details" }) };
    });
    try {
      const { idea } = await resolveIdeaFromTicket("PANT-1");
      assert.equal(idea, "Plan me\n\ndetails");
    } finally {
      __setPantheonFetchForTest(prev);
    }
    assert.deepEqual(urls, ["http://core-api:3012/api/backlog/issues/PANT-1"]);
  });
});

test("an explicit override still wins over the runtime's PANTHEON_API_URL", async () => {
  await withEnv({ PANTHEON_API_URL: "http://core-api:3012", MINERVA_PANTHEON_CORE_API_URL: "http://override.test" }, async () => {
    const urls: string[] = [];
    const prev = __setPantheonFetchForTest(async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ title: "t", description: "d" }) };
    });
    try {
      await resolveIdeaFromTicket("X");
    } finally {
      __setPantheonFetchForTest(prev);
    }
    assert.deepEqual(urls, ["http://override.test/api/backlog/issues/X"]);
  });
});
