// mcp-server.test.ts — real MCP protocol round-trips over a linked in-memory transport pair
// (Client <-> Server), not just createServer() returning an object. Exercises the same wire
// contract a real Claude Code / Codex connection would use. Uses the existing __setDriverForTest
// scripted-driver seam (same pattern as prebaked-plan-defaults.test.ts) for the full round-trip
// test -- no live `claude` subprocess, deterministic, fast; this file is about the MCP wiring,
// not re-testing the planning loop's own business logic (already covered elsewhere).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./mcp-server.ts";
import { createSeedRepo } from "./test-cli.ts";
import { __setDriverForTest } from "./kickoff-engine.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

class ScriptedDriver implements Driver {
  async runTurn(input: DriverInput): Promise<DriverResult> {
    const epicDir = join(input.cwd, ".pHive", "epics", "demo");
    mkdirSync(join(epicDir, "stories"), { recursive: true });
    writeFileSync(join(epicDir, "epic.yaml"), "id: demo\ntitle: Demo epic\n");
    writeFileSync(join(epicDir, "stories", "s1.yaml"), "id: s1\ntitle: first story\n");
    return {
      session_id: "sess",
      raw_result: JSON.stringify({ question: "(none)", suggested_channel: "human", confidence: 0, reason: "done" }),
    };
  }
}

let minervaHome: string;
let seedRepo: string;
let previousHome: string | undefined;
let previousSeedRepo: string | undefined;
let savedDriver: Driver;
let client: Client;

before(async () => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-mcp-"));
  seedRepo = createSeedRepo();
  previousHome = process.env.MINERVA_HOME;
  previousSeedRepo = process.env.MINERVA_SEED_REPO;
  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_SEED_REPO = seedRepo;
  savedDriver = __setDriverForTest(new ScriptedDriver());

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  __setDriverForTest(savedDriver);
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
  if (previousHome) process.env.MINERVA_HOME = previousHome; else delete process.env.MINERVA_HOME;
  if (previousSeedRepo) process.env.MINERVA_SEED_REPO = previousSeedRepo; else delete process.env.MINERVA_SEED_REPO;
});

test("listTools returns all 8 ABI methods as real MCP tools with names + descriptions + schemas", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "abortRun",
    "capabilities",
    "getOutput",
    "getQuestions",
    "getRunStatus",
    "listRuns",
    "startRun",
    "submitAnswers",
  ]);
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 0, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, "object");
  }
});

test("calling capabilities via MCP returns the real ABI version, not a stub", async () => {
  const result = await client.callTool({ name: "capabilities", arguments: {} });
  assert.equal(result.isError, undefined);
  const content = result.content as Array<{ type: string; text: string }>;
  const parsed = JSON.parse(content[0]!.text);
  assert.equal(parsed.abi_version, "1.0.0");
});

test("an invalid tool call (missing required param) surfaces dispatch.ts's real VALIDATION_FAILED error, isError true", async () => {
  const result = await client.callTool({ name: "getRunStatus", arguments: {} });
  assert.equal(result.isError, true);
  const content = result.content as Array<{ type: string; text: string }>;
  const parsed = JSON.parse(content[0]!.text);
  assert.equal(parsed.code, "VALIDATION_FAILED");
});

test("a full startRun -> getRunStatus -> listRuns round trip works identically to the stdin-JSON ABI", async () => {
  const started = await client.callTool({
    name: "startRun",
    arguments: { idea: "a tiny CLI todo app" },
  });
  assert.equal(started.isError, undefined);
  const startedBody = JSON.parse((started.content as Array<{ text: string }>)[0]!.text);
  const runId = startedBody.run_id;
  assert.ok(runId);

  const status = await client.callTool({ name: "getRunStatus", arguments: { run_id: runId } });
  const statusBody = JSON.parse((status.content as Array<{ text: string }>)[0]!.text);
  assert.equal(statusBody.status, "complete");

  const listed = await client.callTool({ name: "listRuns", arguments: {} });
  const listedBody = JSON.parse((listed.content as Array<{ text: string }>)[0]!.text);
  assert.ok(listedBody.runs.some((r: { run_id: string }) => r.run_id === runId));
});
