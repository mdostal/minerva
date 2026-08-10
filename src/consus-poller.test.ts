import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { allocateRun, updateRunRecord } from "./run-manager.ts";
import { fetchConsusQuestionStatus, findParkedConsusQuestions, pollConsusAnswers } from "./consus-poller.ts";

let minervaHome: string;
let seedRepo: string;

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-consus-poller-"));
  seedRepo = mkdtempSync(join(tmpdir(), "minerva-seed-repo-consus-poller-"));
  execFileSync("git", ["init", "-q", "-b", "dev", seedRepo]);
  execFileSync("git", ["-C", seedRepo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", seedRepo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", seedRepo, "commit", "-q", "--allow-empty", "-m", "seed init"]);
  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_SEED_REPO = seedRepo;
  process.env.MINERVA_CONSUS_POLL_TIMEOUT_MS = "200";
});

after(() => {
  delete process.env.MINERVA_HOME;
  delete process.env.MINERVA_SEED_REPO;
  delete process.env.CONSUS_URL;
  delete process.env.MINERVA_CONSUS_POLL_TIMEOUT_MS;
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
});

// Parks a run with one pending question already posted to Consus (consus_question_id set) --
// the exact state store-parked-mapping's story leaves behind.
function parkRunWithConsusQuestion(consusQuestionId: string): string {
  const { run_id: runId } = allocateRun("an idea needing a human gate", undefined);
  updateRunRecord(runId, {
    status: "awaiting-consus",
    questions: [
      {
        id: "q-1",
        text: "Which repo should own this?",
        suggested_channel: "human",
        confidence: 0.5,
        reason: "ambiguous",
        channel: "human",
        status: "pending",
        consus_question_id: consusQuestionId,
      },
    ],
  });
  return runId;
}

async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("findParkedConsusQuestions returns only pending questions carrying a consus_question_id", () => {
  const runId = parkRunWithConsusQuestion("consus-q-1");
  const { run_id: otherRunId } = allocateRun("another idea, never posted to Consus", undefined);

  const mappings = findParkedConsusQuestions();
  const forThisRun = mappings.filter((m) => m.run_id === runId);
  assert.equal(forThisRun.length, 1);
  assert.equal(forThisRun[0]?.question.consus_question_id, "consus-q-1");
  assert.equal(mappings.some((m) => m.run_id === otherRunId), false);
});

test("findParkedConsusQuestions can scope to a single run_id", () => {
  const runId = parkRunWithConsusQuestion("consus-q-scoped");
  parkRunWithConsusQuestion("consus-q-other");

  const mappings = findParkedConsusQuestions(runId);
  assert.equal(mappings.length, 1);
  assert.equal(mappings[0]?.run_id, runId);
});

test("findParkedConsusQuestions skips an already-answered question", () => {
  const { run_id: runId } = allocateRun("answered already", undefined);
  updateRunRecord(runId, {
    questions: [
      {
        id: "q-1",
        text: "Done already",
        suggested_channel: "human",
        confidence: 0.9,
        reason: "n/a",
        channel: "human",
        status: "answered",
        consus_question_id: "consus-q-answered",
      },
    ],
  });

  assert.equal(findParkedConsusQuestions(runId).length, 0);
});

test("fetchConsusQuestionStatus queries GET /api/questions/:id and returns the parsed status + item", async () => {
  await withServer(
    (req, res) => {
      assert.equal(req.method, "GET");
      assert.equal(req.url, "/api/questions/consus-q-1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "consus-q-1", status: "answered", answers: { "q-1": "Use mdostal/minerva" } }));
    },
    async (url) => {
      process.env.CONSUS_URL = url;
      const result = await fetchConsusQuestionStatus("consus-q-1");
      assert.equal(result.status, "answered");
      assert.deepEqual(result.item, { id: "consus-q-1", status: "answered", answers: { "q-1": "Use mdostal/minerva" } });
    },
  );
});

test("fetchConsusQuestionStatus reports status:error on a non-2xx response", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    },
    async (url) => {
      process.env.CONSUS_URL = url;
      const result = await fetchConsusQuestionStatus("missing");
      assert.equal(result.status, "error");
      assert.match(result.error ?? "", /HTTP 404/);
    },
  );
});

test("fetchConsusQuestionStatus reports status:error when Consus is unreachable", async () => {
  process.env.CONSUS_URL = "http://127.0.0.1:1";
  const result = await fetchConsusQuestionStatus("unreachable");
  assert.equal(result.status, "error");
  assert.ok(result.error);
});

test("pollConsusAnswers extracts the answer for a question Consus reports answered", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "answered", answers: { "q-1": "Use mdostal/minerva." } }));
    },
    async (url) => {
      process.env.CONSUS_URL = url;
      const runId = parkRunWithConsusQuestion("consus-q-answer");

      const result = (await pollConsusAnswers({ run_id: runId })) as {
        polled: number;
        answered: Array<Record<string, unknown>>;
        errors: unknown[];
      };

      assert.equal(result.polled, 1);
      assert.equal(result.errors.length, 0);
      assert.deepEqual(result.answered, [
        {
          run_id: runId,
          question_id: "q-1",
          consus_question_id: "consus-q-answer",
          channel: "human",
          answer: "Use mdostal/minerva.",
        },
      ]);
    },
  );
});

test("pollConsusAnswers leaves a still-open question out of both answered and errors", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "open" }));
    },
    async (url) => {
      process.env.CONSUS_URL = url;
      const runId = parkRunWithConsusQuestion("consus-q-open");

      const result = (await pollConsusAnswers({ run_id: runId })) as { polled: number; answered: unknown[]; errors: unknown[] };

      assert.equal(result.polled, 1);
      assert.deepEqual(result.answered, []);
      assert.deepEqual(result.errors, []);
    },
  );
});

test("pollConsusAnswers records a per-mapping error without throwing when Consus is unreachable", async () => {
  process.env.CONSUS_URL = "http://127.0.0.1:1";
  const runId = parkRunWithConsusQuestion("consus-q-down");

  const result = (await pollConsusAnswers({ run_id: runId })) as {
    polled: number;
    answered: unknown[];
    errors: Array<Record<string, unknown>>;
  };

  assert.equal(result.polled, 1);
  assert.deepEqual(result.answered, []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.run_id, runId);
  assert.equal(result.errors[0]?.consus_question_id, "consus-q-down");
});

test("pollConsusAnswers records an error when Consus says answered but no answer text can be extracted", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "answered" }));
    },
    async (url) => {
      process.env.CONSUS_URL = url;
      const runId = parkRunWithConsusQuestion("consus-q-no-answer");

      const result = (await pollConsusAnswers({ run_id: runId })) as {
        answered: unknown[];
        errors: Array<Record<string, unknown>>;
      };

      assert.deepEqual(result.answered, []);
      assert.equal(result.errors.length, 1);
      assert.match(String(result.errors[0]?.error), /no answer could be extracted/);
    },
  );
});
