import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateRun, readRunRecord } from "./run-manager.ts";
import { buildConsusDecisionRequest } from "./consus-decisions.ts";
import { recordTurn } from "./kickoff-engine.ts";

let minervaHome: string;
let seedRepo: string;

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-consus-decisions-"));
  seedRepo = mkdtempSync(join(tmpdir(), "minerva-seed-repo-consus-decisions-"));
  execFileSync("git", ["init", "-q", "-b", "dev", seedRepo]);
  execFileSync("git", ["-C", seedRepo, "commit", "-q", "--allow-empty", "-m", "seed init"]);
  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_SEED_REPO = seedRepo;
  process.env.MINERVA_CONSUS_POST_TIMEOUT_MS = "100";
});

after(() => {
  delete process.env.MINERVA_HOME;
  delete process.env.MINERVA_SEED_REPO;
  delete process.env.MINERVA_CONSUS_DECISIONS_URL;
  delete process.env.MINERVA_CONSUS_POST_TIMEOUT_MS;
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
});

async function withCaptureServer(
  fn: (url: string, bodies: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/decisions");
      bodies.push(JSON.parse(raw));
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await fn(`http://127.0.0.1:${address.port}/api/decisions`, bodies);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("buildConsusDecisionRequest carries run/question ids for resume and preserves the agent channel", () => {
  const body = buildConsusDecisionRequest("run-1", {
    id: "q-1",
    text: "Which repo should own this epic?",
    suggested_channel: "agent",
    confidence: 0.82,
    reason: "The agent can inspect repo ownership metadata.",
    channel: "agent",
    status: "pending",
  });

  assert.equal(body.id, "human_request:run-1:q-1");
  assert.equal(body.channel, "agent");
  assert.deepEqual((body as any).decision_payload.run_id, "run-1");
  assert.deepEqual((body as any).decision_payload.question_id, "q-1");
  assert.deepEqual((body as any).decision_payload.channel, "agent");
  assert.equal((body as any).question.suggestedChannel, "agent");
});

test("recordTurn posts agent-channel gates to Consus and marks the run awaiting-consus", async () => {
  await withCaptureServer(async (url, bodies) => {
    process.env.MINERVA_CONSUS_DECISIONS_URL = url;
    const { run_id: runId } = allocateRun("ambiguous multi-repo epic", undefined);

    await recordTurn(
      runId,
      JSON.stringify({
        question: "Which repository should own this multi-repo epic?",
        suggested_channel: "agent",
        confidence: 0.86,
        reason: "Repo ownership can be resolved by an agent from project metadata.",
      }),
    );

    const record = readRunRecord(runId);
    assert.equal(record.status, "awaiting-consus");
    assert.equal(record.questions[0]?.channel, "agent");
    assert.equal(bodies.length, 1);
    assert.equal((bodies[0] as any).decision_payload.run_id, runId);
    assert.equal((bodies[0] as any).decision_payload.channel, "agent");
  });
});

test("recordTurn preserves human-only gates on the human channel when posting to Consus", async () => {
  await withCaptureServer(async (url, bodies) => {
    process.env.MINERVA_CONSUS_DECISIONS_URL = url;
    const { run_id: runId } = allocateRun("strategic launch decision", undefined);

    await recordTurn(
      runId,
      JSON.stringify({
        question: "Should we cut scope for the v1 launch?",
        suggested_channel: "human",
        confidence: 0.94,
        reason: "This is a strategic product tradeoff.",
      }),
    );

    const record = readRunRecord(runId);
    assert.equal(record.status, "awaiting-consus");
    assert.equal(record.questions[0]?.channel, "human");
    assert.equal((bodies[0] as any).decision_payload.channel, "human");
  });
});

test("recordTurn falls back to waiting_on_human when Consus is unavailable", async () => {
  process.env.MINERVA_CONSUS_DECISIONS_URL = "http://127.0.0.1:1/api/decisions";
  const { run_id: runId } = allocateRun("offline consus", undefined);

  await recordTurn(
    runId,
    JSON.stringify({
      question: "What should happen while Consus is down?",
      suggested_channel: "human",
      confidence: 0.5,
      reason: "test",
    }),
  );

  const record = readRunRecord(runId);
  assert.equal(record.status, "waiting_on_human");
  assert.equal(record.questions.length, 1);
});
