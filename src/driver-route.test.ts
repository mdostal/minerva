import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAvailableRoutePayload, resolveRuntimeRoute } from "./driver.ts";

function response(body: string, init: { ok?: boolean; status?: number; statusText?: string } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? "OK",
    async text() {
      return body;
    },
  };
}

test("parseAvailableRoutePayload accepts the direct Heimdall cli/model shape", () => {
  assert.deepEqual(parseAvailableRoutePayload({ cli: "gemini", model: "gemini-2.5-pro" }), {
    cli: "gemini",
    model: "gemini-2.5-pro",
  });
});

test("parseAvailableRoutePayload accepts nested route/runtime shapes and command aliases", () => {
  assert.deepEqual(parseAvailableRoutePayload({ route: { command: "kimi", model_name: "kimi-k2" } }), {
    cli: "kimi",
    model: "kimi-k2",
  });
  assert.deepEqual(parseAvailableRoutePayload({ runtime: { executable: "claude", modelName: "claude-sonnet-4-5" } }), {
    cli: "claude",
    model: "claude-sonnet-4-5",
  });
  assert.deepEqual(parseAvailableRoutePayload({ selected_route: { provider: "gemini", model: "gemini-2.5-flash" } }), {
    cli: "gemini",
    model: "gemini-2.5-flash",
  });
});

test("parseAvailableRoutePayload rejects routes without both CLI and model", () => {
  assert.throws(() => parseAvailableRoutePayload({ cli: "gemini" }), /cli and model/);
  assert.throws(() => parseAvailableRoutePayload({ model: "gemini-2.5-pro" }), /cli and model/);
});

test("resolveRuntimeRoute GETs /available-route and returns the routed CLI/model", async () => {
  const previous = process.env.MINERVA_HEIMDALL_URL;
  const previousExact = process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  delete process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  process.env.MINERVA_HEIMDALL_URL = "http://heimdall.local:9999/base";
  try {
    const calls: string[] = [];
    const route = await resolveRuntimeRoute(async (url, init) => {
      calls.push(`${init.method} ${url}`);
      return response(JSON.stringify({ route: { cli: "gemini", model: "gemini-2.5-pro" } }));
    });

    assert.deepEqual(route, { cli: "gemini", model: "gemini-2.5-pro" });
    assert.deepEqual(calls, ["GET http://heimdall.local:9999/available-route"]);
  } finally {
    if (previous === undefined) {
      delete process.env.MINERVA_HEIMDALL_URL;
    } else {
      process.env.MINERVA_HEIMDALL_URL = previous;
    }
    if (previousExact === undefined) {
      delete process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
    } else {
      process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL = previousExact;
    }
  }
});

test("resolveRuntimeRoute fails loudly on non-2xx or non-JSON Heimdall responses", async () => {
  await assert.rejects(
    () => resolveRuntimeRoute(async () => response("capacity exhausted", { ok: false, status: 503, statusText: "Service Unavailable" })),
    /HTTP 503 Service Unavailable: capacity exhausted/,
  );
  await assert.rejects(() => resolveRuntimeRoute(async () => response("not-json")), /non-JSON output/);
});
