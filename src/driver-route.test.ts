import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAvailableRoutePayload, resolveRuntimeRoute, HeimdallRouteError, TurnTimeoutError } from "./driver.ts";

// Every test that exercises resolveRuntimeRoute with a custom fetch mock must also set
// MINERVA_PANTHEON_CORE_API_URL so getPantheonRouteSelectUrl() can build a URL to pass to the
// mock -- without it, the function throws before ever calling fetch, masking the test intent.
function withPantheonUrl(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.MINERVA_PANTHEON_CORE_API_URL;
  process.env.MINERVA_PANTHEON_CORE_API_URL = "http://pantheon.test:3000";
  return fn().finally(() => {
    if (prev === undefined) delete process.env.MINERVA_PANTHEON_CORE_API_URL;
    else process.env.MINERVA_PANTHEON_CORE_API_URL = prev;
  });
}

// MINERVA_FALLBACK_CLI/MINERVA_FALLBACK_MODEL are operator-declared env vars for routing fallback.
// Every test below that touches them must save/restore so no test leaks fallback config into another.
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

test("resolveRuntimeRoute POSTs to Pantheon /api/route/select and returns the routed CLI/model", async () => {
  const previous = process.env.MINERVA_PANTHEON_CORE_API_URL;
  const previousExact = process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL;
  delete process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL;
  process.env.MINERVA_PANTHEON_CORE_API_URL = "http://pantheon.local:3000/base";
  try {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const route = await resolveRuntimeRoute(async (url, init) => {
      calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : null });
      return response(JSON.stringify({ runtime: "gemini", model: "gemini-2.5-pro" }));
    });

    assert.deepEqual(route, { cli: "opencode", model: "gemini-2.5-pro" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.url, "http://pantheon.local:3000/base/api/route/select");
    // task_type must be "planning" — the only valid task type for Minerva's kickoff+plan turns
    assert.equal((calls[0]!.body as Record<string, unknown>).task_type, "planning");
    assert.equal(typeof (calls[0]!.body as Record<string, unknown>).task_id, "string");
  } finally {
    if (previous === undefined) {
      delete process.env.MINERVA_PANTHEON_CORE_API_URL;
    } else {
      process.env.MINERVA_PANTHEON_CORE_API_URL = previous;
    }
    if (previousExact === undefined) {
      delete process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL;
    } else {
      process.env.MINERVA_PANTHEON_ROUTE_SELECT_URL = previousExact;
    }
  }
});

test("resolveRuntimeRoute throws a distinguishable HeimdallRouteError (not a plain Error) on non-2xx or non-JSON Pantheon responses when no fallback is configured", async () => {
  await withFallbackEnv(undefined, undefined, async () => {
    const prevUrl = process.env.MINERVA_PANTHEON_CORE_API_URL;
    process.env.MINERVA_PANTHEON_CORE_API_URL = "http://pantheon.local:3000";
    try {
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
    } finally {
      if (prevUrl === undefined) delete process.env.MINERVA_PANTHEON_CORE_API_URL;
      else process.env.MINERVA_PANTHEON_CORE_API_URL = prevUrl;
    }
  });
});

test("resolveRuntimeRoute returns the operator's declared MINERVA_FALLBACK_CLI/MODEL pair verbatim when route selection fails and both are set to valid values", async () => {
  await withPantheonUrl(() => withFallbackEnv("codex", "gpt-5-codex", async () => {
    const route = await resolveRuntimeRoute(async () =>
      response("capacity exhausted", { ok: false, status: 503, statusText: "Service Unavailable" }),
    );
    assert.deepEqual(route, { cli: "codex", model: "gpt-5-codex" });
  }));
});

test("resolveRuntimeRoute does NOT use the fallback pair when route selection succeeds -- fallback is a failure-path escape hatch only", async () => {
  await withPantheonUrl(() => withFallbackEnv("codex", "gpt-5-codex", async () => {
    const route = await resolveRuntimeRoute(async () => response(JSON.stringify({ cli: "claude", model: "claude-sonnet-4-5" })));
    assert.deepEqual(route, { cli: "claude", model: "claude-sonnet-4-5" });
  }));
});

test("resolveRuntimeRoute fails loudly when only MINERVA_FALLBACK_CLI is set, even if Pantheon is reachable -- partial config is never silently ignored", async () => {
  await withPantheonUrl(() => withFallbackEnv("codex", undefined, async () => {
    await assert.rejects(
      () => resolveRuntimeRoute(async () => response(JSON.stringify({ cli: "claude", model: "claude-sonnet-4-5" }))),
      /MINERVA_FALLBACK_CLI.*MINERVA_FALLBACK_MODEL/,
    );
  }));
});

test("resolveRuntimeRoute fails loudly when only MINERVA_FALLBACK_MODEL is set, even if Pantheon is reachable -- partial config is never silently ignored", async () => {
  await withPantheonUrl(() => withFallbackEnv(undefined, "gpt-5-codex", async () => {
    await assert.rejects(
      () => resolveRuntimeRoute(async () => response(JSON.stringify({ cli: "claude", model: "claude-sonnet-4-5" }))),
      /MINERVA_FALLBACK_CLI.*MINERVA_FALLBACK_MODEL/,
    );
  }));
});

test("resolveRuntimeRoute rejects an unrecognized MINERVA_FALLBACK_CLI value at config-read time, even if Pantheon is reachable -- never silently falls through to ClaudeAdapter", async () => {
  await withPantheonUrl(() => withFallbackEnv("gemini-direct-cli", "some-model", async () => {
    await assert.rejects(
      () => resolveRuntimeRoute(async () => response(JSON.stringify({ cli: "claude", model: "claude-sonnet-4-5" }))),
      /Unrecognized MINERVA_FALLBACK_CLI/,
    );
  }));
});

test("resolveRuntimeRoute accepts each of getAdapter()'s known fallback CLIs (opencode, codex, claude)", async () => {
  for (const cli of ["opencode", "codex", "claude"]) {
    await withPantheonUrl(() => withFallbackEnv(cli, "some-model", async () => {
      const route = await resolveRuntimeRoute(async () => response("down", { ok: false, status: 500, statusText: "Internal Server Error" }));
      assert.deepEqual(route, { cli, model: "some-model" });
    }));
  }
});

test("HeimdallRouteError does not extend TurnTimeoutError, so kickoff-engine's runTurnResumable retry gating (instanceof TurnTimeoutError) never sweeps it into a retry", () => {
  const err = new HeimdallRouteError("Heimdall routing failed and no fallback is configured");
  assert.ok(err instanceof Error);
  assert.ok(!(err instanceof TurnTimeoutError), "HeimdallRouteError must not extend TurnTimeoutError");
});
