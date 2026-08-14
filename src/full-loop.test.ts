import { test } from "node:test";
import { strict as assert } from "node:assert";
import { startRun, getQuestions, submitAnswers, __setDriverForTest } from "./kickoff-engine.ts";
import { getOutput } from "./output-emitter.ts";
import { mockHeimdallServer, createSeedRepo } from "./test-cli.ts";
import { resolve, dirname, join } from "node:path";
import { readRunRecord } from "./run-manager.ts";
import { fileURLToPath } from "node:url";
import { writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

function createFakeAgnosticCli(): string {
  const path = join(tmpdir(), "fake-agnostic-cli-" + Date.now() + ".js");
  const code = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const cwd = process.cwd();
const args = process.argv.slice(2);

if (args.includes("--idea")) {
  const result = JSON.stringify({
    question: "Should we proceed?",
    suggested_channel: "human",
    confidence: 0,
    reason: "need human approval",
    kind: "single-select"
  });
  console.log(JSON.stringify({ session_id: "fake-session", result }));
} else {
  const epicDir = join(cwd, ".pHive", "epics", "test-epic");
  mkdirSync(join(epicDir, "stories"), { recursive: true });
  writeFileSync(join(epicDir, "epic.yaml"), "id: test-epic\\ntitle: Test Epic\\nstatus: approved");
  writeFileSync(join(epicDir, "stories", "1.yaml"), "id: story-1\\ntitle: Story 1");
  const result = JSON.stringify({
    question: "",
    suggested_channel: "human",
    confidence: 0,
    reason: "done"
  });
  console.log(JSON.stringify({ session_id: "fake-session", result }));
}
`;
  writeFileSync(path, code);
  chmodSync(path, 0o755);
  return path;
}

class KickoffDriver {
  turns = 0;
  async runTurn(input: any) {
    this.turns++;
    if (this.turns === 1) {
      return {
        session_id: "kickoff-sess",
        raw_result: JSON.stringify({
          question: "Should we proceed?",
          suggested_channel: "human",
          confidence: 0,
          reason: "need human approval",
          kind: "single-select",
          options: ["yes", "no"]
        })
      };
    }
    return {
      session_id: "kickoff-sess",
      raw_result: JSON.stringify({
        question: "",
        suggested_channel: "human",
        confidence: 0,
        reason: "kickoff done"
      })
    };
  }
}

test("full autonomous loop: claude kickoff + gemini planning", async () => {
  const seedRepo = createSeedRepo();
  const fakeCli = createFakeAgnosticCli();

  const heimdall = await mockHeimdallServer({
    kickoff: { cli: "claude", model: "claude-sonnet-4-5" },
    planning: { runtime: "gemini", model: "gemini-2.0-flash-exp" },
  });
  
  const previousHeimdallUrl = process.env.MINERVA_HEIMDALL_URL;
  const previousExact = process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  const previousTestMode = process.env.MINERVA_TEST_MODE;
  const previousCli = process.env.HIVE_PLAN_AGNOSTIC_CLI;
  const previousOpencode = process.env.OPENCODE_BIN;
  // startRun's no-target_repo path (this test never passes target_repo, only the unused
  // repo_url) falls through to run-manager's resolveSeedRepo(), which otherwise defaults to
  // ~/repos/consus-seeds and fails hard on a machine without that directory. Self-provision the
  // same throwaway repo createSeedRepo() already built above as MINERVA_SEED_REPO.
  const previousSeedRepo = process.env.MINERVA_SEED_REPO;

  process.env.MINERVA_HEIMDALL_URL = heimdall.url;
  delete process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  delete process.env.MINERVA_TEST_MODE;
  process.env.OPENCODE_BIN = "echo";
  process.env.HIVE_PLAN_AGNOSTIC_CLI = fakeCli;
  process.env.MINERVA_SEED_REPO = seedRepo;

  const defaultDriver = __setDriverForTest(new KickoffDriver() as any);

  try {
    const { run_id } = await startRun({ idea: "test idea", target_repo: seedRepo });
    assert.ok(run_id, "startRun should return a run_id");

    let { questions } = await getQuestions({ run_id: run_id as string, channel: "human" }) as any;
    assert.equal(questions.length, 1, "Kickoff should surface 1 question");

    await submitAnswers({
      run_id: run_id as string, 
      channel: "human", 
      answers: [{ question_id: questions[0].id, answer: "yes" }] 
    });
    
    const record = readRunRecord(run_id as string);
    assert.equal(record.plan_runtime, "gemini", "plan_runtime should be frozen to gemini");
    assert.equal(record.plan_model, "gemini-2.0-flash-exp", "plan_model should be frozen");
    assert.equal(record.status, "complete", "run should be complete after planning finishes");
    
    const output = getOutput({ run_id: run_id as string }) as any;
    assert.ok(output.epic, "Epic should be produced");
    assert.ok(output.epic.stories.length > 0, "Stories should exist");
  } finally {
    heimdall.server.close();
    __setDriverForTest(defaultDriver);
    if (previousHeimdallUrl) process.env.MINERVA_HEIMDALL_URL = previousHeimdallUrl; else delete process.env.MINERVA_HEIMDALL_URL;
    if (previousExact) process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL = previousExact; else delete process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
    if (previousTestMode) process.env.MINERVA_TEST_MODE = previousTestMode; else delete process.env.MINERVA_TEST_MODE;
    if (previousCli) process.env.HIVE_PLAN_AGNOSTIC_CLI = previousCli; else delete process.env.HIVE_PLAN_AGNOSTIC_CLI;
    if (previousOpencode) process.env.OPENCODE_BIN = previousOpencode; else delete process.env.OPENCODE_BIN;
    if (previousSeedRepo) process.env.MINERVA_SEED_REPO = previousSeedRepo; else delete process.env.MINERVA_SEED_REPO;
  }
});

test("fallback path: Heimdall down -> claude/claude gracefully degrades", async () => {
  const seedRepo = createSeedRepo();
  const fakeCli = createFakeAgnosticCli();

  const previousHeimdallUrl = process.env.MINERVA_HEIMDALL_URL;
  const previousExact = process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  const previousTestMode = process.env.MINERVA_TEST_MODE;
  const previousCli = process.env.HIVE_PLAN_AGNOSTIC_CLI;
  const previousOpencode = process.env.OPENCODE_BIN;
  const previousSeedRepo = process.env.MINERVA_SEED_REPO;

  process.env.MINERVA_HEIMDALL_URL = "http://localhost:1";
  delete process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
  delete process.env.MINERVA_TEST_MODE;
  process.env.OPENCODE_BIN = "echo";
  process.env.HIVE_PLAN_AGNOSTIC_CLI = fakeCli;
  process.env.MINERVA_SEED_REPO = seedRepo;

  class FallbackDriver {
    turns = 0;
    async runTurn(input: any) {
      this.turns++;
      if (this.turns === 1) {
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const epicDir = join(input.cwd, ".pHive", "epics", "fb-epic");
        mkdirSync(join(epicDir, "stories"), { recursive: true });
        writeFileSync(join(epicDir, "epic.yaml"), "id: fb-epic\\ntitle: fb\\nstatus: approved\\n");
        writeFileSync(join(epicDir, "stories", "s1.yaml"), "id: s1\\ntitle: fb1\\n");
        
        return {
          session_id: "fb-sess",
          raw_result: JSON.stringify({ question: "", suggested_channel: "human", confidence: 0, reason: "done" })
        };
      }
      return {
        session_id: "fb-sess",
        raw_result: JSON.stringify({ question: "", suggested_channel: "human", confidence: 0, reason: "done" })
      };
    }
  }

  const defaultDriver = __setDriverForTest(new FallbackDriver() as any);

  try {
    const { run_id } = await startRun({ idea: "test idea", target_repo: seedRepo });
    assert.ok(run_id, "startRun should return a run_id");
    
    const record = readRunRecord(run_id as string);
    assert.equal(record.plan_runtime, undefined, "plan_runtime should be undefined on fallback");
    assert.equal(record.status, "complete", "run should be complete via fallback driver");
    
    const output = getOutput({ run_id: run_id as string }) as any;
    assert.ok(output.epic, "Epic should be produced");
    assert.ok(output.epic.stories.length > 0, "Stories should exist");
  } finally {
    __setDriverForTest(defaultDriver);
    if (previousHeimdallUrl) process.env.MINERVA_HEIMDALL_URL = previousHeimdallUrl; else delete process.env.MINERVA_HEIMDALL_URL;
    if (previousExact) process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL = previousExact; else delete process.env.MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL;
    if (previousTestMode) process.env.MINERVA_TEST_MODE = previousTestMode; else delete process.env.MINERVA_TEST_MODE;
    if (previousCli) process.env.HIVE_PLAN_AGNOSTIC_CLI = previousCli; else delete process.env.HIVE_PLAN_AGNOSTIC_CLI;
    if (previousOpencode) process.env.OPENCODE_BIN = previousOpencode; else delete process.env.OPENCODE_BIN;
    if (previousSeedRepo) process.env.MINERVA_SEED_REPO = previousSeedRepo; else delete process.env.MINERVA_SEED_REPO;
  }
});
