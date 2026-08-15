import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAvailableRoutePayload, resolveRuntimeRoute, HeimdallRouteError, TurnTimeoutError } from "./driver.ts";

// MINERVA_FALLBACK_CLI/MINERVA_FALLBACK_MODEL are new operator-declared env vars this story
// introduces. Every test below that touches them must save/restore, matching this file's own
// MINERVA_HEIMDALL_URL convention above, so no test leaks fallback config into another.
function withFallbackEnv(cli: string | undefined, model: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previousCli = process.env.MINERVA_FALLBACK_CLI;
  const previousModel = process.env.MINERVA_FALLBACK_MODEL;
  if (cli === undefined) delete process.env.MINERVA_FALLBACK_CLI;
  else process.env.MINERVA_FALLBACK_CLI = cli;
  if (model === undefined) delete process.env.MINERVA_FALLBACK_MODEL;
  else process.env.MINERVA_FALLBACK_MODEL = model;
  return fn().finally(() => {
    if (previousCli === undefined) delete process.env.MINERVA_FALLBACK_CLI;
    else process.env.MINERVA_FALLBACK_CLI = previousCli;
    if (previousModel === undefined) delete process.env.MINERVA_FALLBACK_MODEL;
    else process.env.MINERVA_FALLBACK_MODEL = previousModel;
  });
}

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
    // task-type=planning, not "kickoff" -- Heimdall's TASK_TYPES is a closed
    // planning|build|review enum (heimdall/src/core/task-type.ts) that never included "kickoff"
    // and rejects it with HTTP 400 invalid_task_type. startRun exclusively drives kickoff+plan
    // (research/design/story-decomposition), a planning-shaped activity -- see
    // src/plan-runner.ts and this file's other task-type test below.
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

// fix-heimdall-route-fail-fast-with-fallback: this test used to assert today's untyped-Error
// throw-through as intentional. That is no longer the intended behavior -- rewritten below (not
// left alongside the new cases) to assert the typed HeimdallRouteError default, per this story's
// acceptance criteria.
test("resolveRuntimeRoute throws a distinguishable HeimdallRouteError (not a plain Error) on non-2xx or non-JSON Heimdall responses when no fallback is configured", async () => {
  await withFallbackEnv(undefined, undefined, async () => {
    await assert.rejects(
      () => resolveRuntimeRoute(async () => response("capacity exhausted", { ok: false, status: 503, statusText: "Service Unavailable" })),
      (err: unknown) => {
        assert.ok(err instanceof HeimdallRouteError, `expected a HeimdallRouteError, got ${err}`);
        assert.ok(!(err instanceof TypeError), "HeimdallRouteError must not be some unrelated builtin error type");
        assert.equal(Object.getPrototypeOf(err), HeimdallRouteError.prototype);
        assert.match((err as Error).message, /HTTP 503 Service Unavailable: capacity exhausted/);
        return true;
      },
    );
    await assert.rejects(
      () => resolveRuntimeRoute(async () => response("not-json")),
      (err: unknown) => {
        assert.ok(err instanceof HeimdallRouteError, `expected a HeimdallRouteError, got ${err}`);
        assert.match((err as Error).message, /non-JSON output/);
        return true;
      },
    );
  });
});

test("resolveRuntimeRoute returns the operator's declared MINERVA_FALLBACK_CLI/MODEL pair verbatim when Heimdall fails and both are set to valid values", async () => {
  await withFallbackEnv("codex", "gpt-5-codex", async () => {
    const route = await resolveRuntimeRoute(async () =>
      response("capacity exhausted", { ok: false, status: 503, statusText: "Service Unavailable" }),
    );
    assert.deepEqual(route, { cli: "codex", model: "gpt-5-codex" });
  });
});

test("resolveRuntimeRoute does NOT use the fallback pair when Heimdall succeeds -- fallback is a failure-path escape hatch only", async () => {
  await withFallbackEnv("codex", "gpt-5-codex", async () => {
    const route = await resolveRuntimeRoute(async () => response(JSON.stringify({ cli: "claude", model: "claude-sonnet-4-5" })));
    assert.deepEqual(route, { cli: "claude", model: "claude-sonnet-4-5" });
  });
});

test("resolveRuntimeRoute fails loudly when only MINERVA_FALLBACK_CLI is set, even if Heimdall is reachable -- partial config is never silently ignored", async () => {
  await withFallbackEnv("codex", undefined, async () => {
    await assert.rejects(
      () => resolveRuntimeRoute(async () => response(JSON.stringify({ cli: "claude", model: "claude-sonnet-4-5" }))),
      /MINERVA_FALLBACK_CLI.*MINERVA_FALLBACK_MODEL/,
    );
  });
});

test("resolveRuntimeRoute fails loudly when only MINERVA_FALLBACK_MODEL is set, even if Heimdall is reachable -- partial config is never silently ignored", async () => {
  await withFallbackEnv(undefined, "gpt-5-codex", async () => {
    await assert.rejects(
      () => resolveRuntimeRoute(async () => response(JSON.stringify({ cli: "claude", model: "claude-sonnet-4-5" }))),
      /MINERVA_FALLBACK_CLI.*MINERVA_FALLBACK_MODEL/,
    );
  });
});

test("resolveRuntimeRoute rejects an unrecognized MINERVA_FALLBACK_CLI value at config-read time, even if Heimdall is reachable -- never silently falls through to ClaudeAdapter", async () => {
  await withFallbackEnv("gemini-direct-cli", "some-model", async () => {
    await assert.rejects(
      () => resolveRuntimeRoute(async () => response(JSON.stringify({ cli: "claude", model: "claude-sonnet-4-5" }))),
      /Unrecognized MINERVA_FALLBACK_CLI/,
    );
  });
});

test("resolveRuntimeRoute accepts each of getAdapter()'s known fallback CLIs (opencode, codex, claude)", async () => {
  for (const cli of ["opencode", "codex", "claude"]) {
    await withFallbackEnv(cli, "some-model", async () => {
      const route = await resolveRuntimeRoute(async () => response("down", { ok: false, status: 500, statusText: "Internal Server Error" }));
      assert.deepEqual(route, { cli, model: "some-model" });
    });
  }
});

test("HeimdallRouteError does not extend TurnTimeoutError, so kickoff-engine's runTurnResumable retry gating (instanceof TurnTimeoutError) never sweeps it into a retry", () => {
  const err = new HeimdallRouteError("Heimdall routing failed and no fallback is configured");
  assert.ok(err instanceof Error);
  assert.ok(!(err instanceof TurnTimeoutError), "HeimdallRouteError must not extend TurnTimeoutError");
});
