// PANT-1093: every Minerva write to core-api carries x-pantheon-operator-token. Since Pantheon
// first-cut-trust 1c the token is Minerva's own caller token (runtime-agent), never the operator
// token; the fake core-api only hands out the selector it was asked for. A real HTTP fake
// core-api serves /api/secrets/inject by writing the token onto a temp "secrets volume", exactly as
// the live one does, and records the headers each write arrives with.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetOperatorTokenCache, OPERATOR_TOKEN_HEADER } from "./operator-token.ts";
import { resolveRuntimeRoute } from "./driver.ts";
import { resolvePlanningRoute } from "./agnostic-plan-driver.ts";
import { promoteParkedStories, resolveIdeaFromTicket } from "./plan-runner.ts";

const ENV_KEYS = [
  "MINERVA_OPERATOR_TOKEN_INJECT",
  "MINERVA_OPERATOR_TOKEN_TAGS",
  "PANTHEON_SECRETS_SHARED_DIR",
  "MINERVA_PANTHEON_CORE_API_URL",
  "MINERVA_PANTHEON_ROUTE_SELECT_URL",
  "MINERVA_FALLBACK_CLI",
  "MINERVA_FALLBACK_MODEL",
] as const;

let server: Server;
const injectedTags: string[] = [];
let volume: string;
let saved: Map<string, string | undefined>;
const seen: Array<{ method: string; url: string; token: string | undefined }> = [];

beforeEach(async () => {
  seen.length = 0;
  injectedTags.length = 0;
  resetOperatorTokenCache();
  volume = mkdtempSync(join(tmpdir(), "minerva-secrets-"));
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const token = req.headers[OPERATOR_TOKEN_HEADER] as string | undefined;
      seen.push({ method: req.method!, url: req.url!, token });
      if (req.url === "/api/secrets/inject") {
        const body = JSON.parse(raw) as { tags: string; path: string; key: string };
        injectedTags.push(body.tags);
        // As core-api does for a runtime's own dir: only the runtime-agent selector is delivered.
        if (body.tags !== "provider=pantheon,kind=caller-token,caller=runtime-agent") {
          res.writeHead(403, { "content-type": "application/json" }).end("{}");
          return;
        }
        writeFileSync(body.path, `${body.key}=caller-token-xyz\n`);
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      } else if (req.url === "/api/route/select") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ runtime: "gemini", model: "gemini-2.5-pro" }));
      } else if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ title: "t", description: "d" }));
      } else {
        res.writeHead(204).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PANTHEON_SECRETS_SHARED_DIR = volume;
  process.env.MINERVA_PANTHEON_CORE_API_URL = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetOperatorTokenCache();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(volume, { recursive: true, force: true });
});

test("resolveRuntimeRoute sends the runtime-agent caller token on POST /api/route/select", async () => {
  const route = await resolveRuntimeRoute();
  assert.deepEqual(route, { cli: "opencode", model: "gemini-2.5-pro" });
  const select = seen.find((s) => s.url === "/api/route/select");
  assert.equal(select?.token, "caller-token-xyz");
  assert.deepEqual(readdirSync(volume), [], "the injected token file is deleted after reading");
  assert.deepEqual(injectedTags, ["provider=pantheon,kind=caller-token,caller=runtime-agent"]);
});

test("MINERVA_OPERATOR_TOKEN_TAGS set to the operator token: nothing is injected, writes go out bare", async () => {
  process.env.MINERVA_OPERATOR_TOKEN_TAGS = "provider=pantheon,kind=operator-token";
  const route = await resolveRuntimeRoute();
  assert.deepEqual(route, { cli: "opencode", model: "gemini-2.5-pro" });
  assert.deepEqual(injectedTags, [], "the operator token's selector never reaches core-api");
  assert.equal(seen.find((s) => s.url === "/api/route/select")?.token, undefined);
});

test("the token is injected once and reused across route/select calls", async () => {
  await resolveRuntimeRoute();
  await resolvePlanningRoute();
  assert.equal(seen.filter((s) => s.url === "/api/secrets/inject").length, 1);
  assert.deepEqual(
    seen.filter((s) => s.url === "/api/route/select").map((s) => s.token),
    ["caller-token-xyz", "caller-token-xyz"],
  );
});

test("plan-runner backlog writes carry the token; reads don't need it", async () => {
  await resolveIdeaFromTicket("ISSUE-1");
  const r = await promoteParkedStories(["ISSUE-1"]);
  assert.deepEqual(r.errors, []);
  const read = seen.find((s) => s.method === "GET");
  const write = seen.find((s) => s.url === "/api/backlog/issues/ISSUE-1/status");
  assert.equal(read?.token, undefined);
  assert.equal(write?.token, "caller-token-xyz");
});

test("without a resolvable token route/select still goes out (degrade, not hard-fail)", async () => {
  process.env.PANTHEON_SECRETS_SHARED_DIR = join(volume, "not-mounted");
  const route = await resolveRuntimeRoute();
  assert.deepEqual(route, { cli: "opencode", model: "gemini-2.5-pro" });
  assert.equal(seen.filter((s) => s.url === "/api/secrets/inject").length, 0);
  assert.equal(seen.find((s) => s.url === "/api/route/select")?.token, undefined);
});
