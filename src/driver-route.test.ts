import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeRuntimeAdapter,
  parseAvailableRoutePayload,
  resolveRuntimeRoute,
  type RuntimeAdapter,
  type TurnResult,
} from "./driver.ts";

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

test("claudeRuntimeAdapter exposes turn/background args and parsers through the RuntimeAdapter contract", () => {
  const adapter: RuntimeAdapter = claudeRuntimeAdapter;
  const route = { cli: "claude", model: "claude-sonnet-4-5" };

  assert.deepEqual(
    adapter.formatTurnArgs(route, {
      freshSessionId: "fresh-1",
      schemaArgs: ["--json-schema", "{}"],
      prompt: "ask one question",
    }),
    [
      "-p",
      "--model",
      "claude-sonnet-4-5",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--session-id",
      "fresh-1",
      "--json-schema",
      "{}",
      "ask one question",
    ],
  );

  assert.deepEqual(
    adapter.formatTurnArgs(route, {
      sessionId: "session-1",
      extraArgs: ["--plugin-dir", "/tmp/plugin-hive"],
      prompt: "continue",
    }),
    [
      "-p",
      "--model",
      "claude-sonnet-4-5",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--plugin-dir",
      "/tmp/plugin-hive",
      "--resume",
      "session-1",
      "continue",
    ],
  );

  const parsed: TurnResult = adapter.parseTurnResult(
    JSON.stringify({ is_error: false, stop_reason: "end_turn", session_id: "session-2", result: "ok" }),
  );
  assert.deepEqual(parsed, { is_error: false, stop_reason: "end_turn", session_id: "session-2", result: "ok" });

  assert.deepEqual(adapter.formatBackgroundArgs(route, { sessionId: "session-2", prompt: "work" }), [
    "--bg",
    "--model",
    "claude-sonnet-4-5",
    "--permission-mode",
    "bypassPermissions",
    "--resume",
    "session-2",
    "work",
  ]);
  assert.equal(adapter.parseBackgroundDispatch("backgrounded: bg-1\n", route), "bg-1");
  assert.deepEqual(
    adapter.parseListAgents(
      JSON.stringify([
        { id: "bg-1", kind: "background", state: "blocked" },
        { id: "fg-1", kind: "foreground", state: "running" },
      ]),
    ),
    [{ id: "bg-1", kind: "background", state: "blocked" }],
  );
  assert.deepEqual(adapter.formatListAgentsArgs(), ["agents", "--json"]);
  assert.deepEqual(adapter.formatStopAgentArgs("bg-1"), ["stop", "bg-1"]);
});

test("parseAvailableRoutePayload maps Heimdall runtime/model responses to spawnable CLIs", () => {
  assert.deepEqual(parseAvailableRoutePayload({ runtime: "gemini", model: "gemini-2.5-pro" }), {
    cli: "opencode",
    model: "gemini-2.5-pro",
  });
  assert.deepEqual(parseAvailableRoutePayload({ runtime: "codex", model: "gpt-5-codex" }), {
    cli: "codex",
    model: "gpt-5-codex",
  });
  assert.deepEqual(parseAvailableRoutePayload({ runtime: "grok", model: "grok-4" }), {
    cli: "opencode",
    model: "grok-4",
  });
  assert.deepEqual(parseAvailableRoutePayload({ runtime: " claude ", model: "claude-sonnet-4-5" }), {
    cli: "claude",
    model: "claude-sonnet-4-5",
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
    cli: "opencode",
    model: "gemini-2.5-flash",
  });
});

test("parseAvailableRoutePayload rejects routes without both CLI and model", () => {
  assert.throws(() => parseAvailableRoutePayload({ cli: "gemini" }), /cli and model/);
  assert.throws(() => parseAvailableRoutePayload({ model: "gemini-2.5-pro" }), /cli and model/);
});

test("parseAvailableRoutePayload rejects empty, missing-runtime, and non-object payloads", () => {
  assert.throws(() => parseAvailableRoutePayload({}), /cli and model/);
  assert.throws(() => parseAvailableRoutePayload(null), /cli and model/);
  assert.throws(() => parseAvailableRoutePayload(undefined), /cli and model/);
  assert.throws(() => parseAvailableRoutePayload({ runtime: "   ", model: "gemini-2.5-pro" }), /cli and model/);
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
      return response(JSON.stringify({ runtime: "gemini", model: "gemini-2.5-pro" }));
    });

    assert.deepEqual(route, { cli: "opencode", model: "gemini-2.5-pro" });
    assert.deepEqual(calls, ["GET http://heimdall.local:9999/available-route?task-type=planning"]);
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
