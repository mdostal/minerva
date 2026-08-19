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
import { allocateRun } from "./run-manager.ts";
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

// validate-run-id-uuid-shape story -- mcp-server.ts's CallToolRequestSchema handler is the other
// of the two ABI boundaries (alongside dispatch.ts's method routing) that must reject a non-UUID
// run_id with VALIDATION_FAILED before forwarding to dispatch() at all, for exactly these five
// tools.
const RUN_ID_TOOLS = ["getRunStatus", "getQuestions", "submitAnswers", "getOutput", "abortRun"] as const;
const NON_UUID_RUN_IDS = ["x", "", "../../etc/passwd", "not-a-uuid-at-all", "12345"];

// Every one of these tools declares other required params too (channel, answers) -- pass
// well-formed values for those so a rejection can only be attributed to run_id shape.
function fullArgsFor(runId: string): Record<string, unknown> {
  return {
    run_id: runId,
    channel: "agent",
    answers: [{ question_id: "q1", answer: "an answer" }],
  };
}

for (const toolName of RUN_ID_TOOLS) {
  for (const badRunId of NON_UUID_RUN_IDS) {
    test(`MCP ${toolName} rejects non-UUID run_id ${JSON.stringify(badRunId)} as VALIDATION_FAILED naming run_id`, async () => {
      const result = await client.callTool({ name: toolName, arguments: fullArgsFor(badRunId) });
      assert.equal(result.isError, true, `expected isError true, got ${JSON.stringify(result)}`);
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text);
      assert.equal(parsed.code, "VALIDATION_FAILED");
      assert.match(parsed.message, /run_id/);
    });
  }
}

test("MCP: a valid-UUID run_id round-trips unchanged through all five tools (no regression)", async () => {
  const { run_id: runId } = allocateRun("an idea for the mcp-server UUID regression test", undefined);

  const status = await client.callTool({ name: "getRunStatus", arguments: { run_id: runId } });
  assert.equal(status.isError, undefined, `expected success, got ${JSON.stringify(status)}`);
  const statusBody = JSON.parse((status.content as Array<{ text: string }>)[0]!.text);
  assert.equal(statusBody.status, "in_progress");

  const questions = await client.callTool({ name: "getQuestions", arguments: { run_id: runId, channel: "agent" } });
  assert.equal(questions.isError, undefined, `expected success, got ${JSON.stringify(questions)}`);
  const questionsBody = JSON.parse((questions.content as Array<{ text: string }>)[0]!.text);
  assert.deepEqual(questionsBody.questions, []);

  const output = await client.callTool({ name: "getOutput", arguments: { run_id: runId } });
  assert.equal(output.isError, true, `expected an error, got ${JSON.stringify(output)}`);
  const outputBody = JSON.parse((output.content as Array<{ text: string }>)[0]!.text);
  assert.equal(outputBody.code, "NOT_READY", "a real run_id must reach run-manager, not be rejected as VALIDATION_FAILED");

  const submit = await client.callTool({
    name: "submitAnswers",
    arguments: { run_id: runId, channel: "agent", answers: [{ question_id: "no-such-question", answer: "x" }] },
  });
  assert.equal(submit.isError, true, `expected an error, got ${JSON.stringify(submit)}`);
  const submitBody = JSON.parse((submit.content as Array<{ text: string }>)[0]!.text);
  assert.equal(submitBody.code, "NOT_FOUND", "a real run_id must reach kickoff-engine, not be rejected as VALIDATION_FAILED");

  const abort = await client.callTool({ name: "abortRun", arguments: { run_id: runId } });
  assert.equal(abort.isError, undefined, `expected success, got ${JSON.stringify(abort)}`);
});
