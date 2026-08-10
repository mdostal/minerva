// e2e-auto-resume.test.ts (minerva-auto-resume epic, e2e-verification story) -- drives
// runHeadlessPlan through a REAL `mode: "off"` park -> post-to-Consus -> poll -> human-answers ->
// auto-resume cycle against a real local HTTP server standing in for Consus, replicating the exact
// response shapes confirmed live against a running Consus instance (both `/api/questions/:id` and
// `/api/workflows/pw-:id/status`). A local stand-in (not the shared dev Consus) keeps this
// hermetic and avoids the flakiness risk the story's own risk register calls out (concurrent
// runs on a shared Consus instance).
//
// This test caught a real bug: runHeadlessPlan's inline pollConsusForAnswers loop polled
// `/api/workflows/pw-:id/status`, whose "resumed" response never carries the answer text (only
// `/api/questions/:id` does) -- so after a human answered, the loop looped forever, silently, and
// the run never resumed. Fixed in plan-runner.ts to reuse the already-tested
// fetchConsusQuestionStatus/extractAnswerFromItem pair the poll-consus-answers/resume-run-execution
// stories built.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __setDriverForTest } from "./kickoff-engine.ts";
import { runHeadlessPlan } from "./plan-runner.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

let minervaHome: string;
let savedDriver: Driver;

interface FakeQuestion {
  id: number;
  item_id: string;
  minerva_question_id: string;
  text: string;
  channel: string;
  answer: string | null;
  status: "pending" | "answered";
}

function startFakeConsus(): {
  url: string;
  close: () => Promise<void>;
  questions: Map<number, FakeQuestion>;
  answer: (minervaQuestionId: string, answerText: string) => void;
} {
  const questions = new Map<number, FakeQuestion>();
  let nextId = 1;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST" && url.pathname === "/api/questions") {
        const payload = body ? JSON.parse(body) : {};
        const id = nextId++;
        questions.set(id, {
          id,
          item_id: String(payload.item_id ?? ""),
          minerva_question_id: String(payload.minerva_question_id ?? ""),
          text: String(payload.text ?? ""),
          channel: String(payload.channel ?? ""),
          answer: null,
          status: "pending",
        });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, minerva_question_id: payload.minerva_question_id, parked: true }));
        return;
      }

      const questionMatch = url.pathname.match(/^\/api\/questions\/(\d+)$/);
      if (req.method === "GET" && questionMatch) {
        const q = questions.get(Number(questionMatch[1]));
        if (!q) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "question not found" }));
          return;
        }
        // Real shape confirmed live: top-level `answer` string once answered.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(q));
        return;
      }

      const workflowMatch = url.pathname.match(/^\/api\/workflows\/pw-(\d+)\/status$/);
      if (req.method === "GET" && workflowMatch) {
        const q = questions.get(Number(workflowMatch[1]));
        if (!q) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Workflow not found" }));
          return;
        }
        // Real shape confirmed live: this endpoint's `answer` field is ALWAYS null, even once
        // the question is answered -- it only ever reflects status ("parked" | "resumed").
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: q.status === "answered" ? "resumed" : "parked", question_id: String(q.id), answer: null }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });

  server.listen(0);
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    questions,
    answer: (minervaQuestionId, answerText) => {
      for (const q of questions.values()) {
        if (q.minerva_question_id === minervaQuestionId) {
          q.answer = answerText;
          q.status = "answered";
        }
      }
    },
  };
}

// Turn 1: an unresolvable human-channel gate (mode "off" never auto-answers, so this always
// parks). Turn 2 (the resumed turn): asserts the human's answer arrived as the driven prompt,
// then completes the plan -- proving the resumed run actually executes using the answer, not
// just that state flipped.
class ParkThenUseAnswerDriver implements Driver {
  turns = 0;
  resumedPrompt: string | null = null;
  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.turns++;
    if (this.turns === 1) {
      return {
        session_id: "sess-1",
        raw_result: JSON.stringify({
          question: "What theme should the app default to?",
          suggested_channel: "human",
          confidence: 0.2,
          reason: "product decision, no safe default",
          kind: "free-text",
          options: null,
        }),
      };
    }
    this.resumedPrompt = input.prompt;
    const epicDir = join(input.cwd, ".pHive", "epics", "themed-app");
    mkdirSync(join(epicDir, "stories"), { recursive: true });
    writeFileSync(join(epicDir, "epic.yaml"), "id: themed-app\ntitle: Themed app\n");
    writeFileSync(
      join(epicDir, "stories", "apply-theme.yaml"),
      `id: apply-theme\ntitle: Apply theme: ${input.prompt}\ndepends_on: []\n`,
    );
    return {
      session_id: "sess-2",
      raw_result: JSON.stringify({ question: "(none)", suggested_channel: "human", confidence: 0, reason: "done" }),
    };
  }
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-e2e-auto-resume-"));
  process.env.MINERVA_HOME = minervaHome;
  savedDriver = __setDriverForTest(new ParkThenUseAnswerDriver());
});

after(() => {
  __setDriverForTest(savedDriver);
  delete process.env.MINERVA_HOME;
  delete process.env.CONSUS_URL;
  rmSync(minervaHome, { recursive: true, force: true });
});

test("real mode=off run: parks to Consus without silent failure, then auto-resumes with the human's answer once answered", async () => {
  const consus = startFakeConsus();
  process.env.CONSUS_URL = consus.url;
  const driver = new ParkThenUseAnswerDriver();
  __setDriverForTest(driver);

  const planPromise = runHeadlessPlan({
    idea: "a themed note-taking app",
    mode: "off",
    pollConsusForAnswers: true,
    ticketId: "e2e-verification-ticket",
  });

  // Wait for the park to reach Consus (real HTTP round trip -- proves no silent failure).
  const deadline = Date.now() + 5000;
  while (consus.questions.size === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(consus.questions.size, 1, "the parked question must reach Consus, not fail silently");
  const posted = [...consus.questions.values()][0];
  assert.ok(posted);
  assert.equal(posted!.text, "What theme should the app default to?");
  assert.equal(posted!.status, "pending");

  // Simulate the human answering via Consus.
  consus.answer("q-1", "solarized dark");

  const result = await planPromise;

  assert.equal(result.status, "complete", "the run must auto-resume to completion, not park forever");
  assert.equal(result.pending_questions.length, 0);
  assert.equal(driver.turns, 2, "the resumed turn must actually re-drive the plan engine");
  assert.equal(driver.resumedPrompt, "solarized dark", "the human's answer must be injected into the resumed turn");
  assert.ok(result.epic);
  assert.equal(result.epic!.epic_id, "themed-app");

  await consus.close();
});
