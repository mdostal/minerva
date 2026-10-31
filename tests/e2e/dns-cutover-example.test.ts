// dns-cutover-example.test.ts -- PANT-1262. Runs the worked example in docs/integrations.md
// literally: a fresh `bin/minerva.ts` process per call, the descriptor from
// docs/examples/dns-cutover/tool.json, the turn runner docs/examples/dns-cutover/turn-runner.sh in
// place of `claude`, and a fake `dig` on PATH standing in for DNS. Nothing from src/ is imported
// to shortcut the loop, and no Pantheon service is reachable.
//
// It also fails if the descriptor shown on that page stops matching tool.json, so the page cannot
// drift from what this test executes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { call, createSeedRepo } from "../../src/test-cli.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXAMPLE = join(REPO, "docs", "examples", "dns-cutover");
const TURN_RUNNER = join(EXAMPLE, "turn-runner.sh");
const TOOL = JSON.parse(readFileSync(join(EXAMPLE, "tool.json"), "utf8"));
const IDEA = "_cutover.example.com v=cutover-2026";

let scratch: string;
let seedRepo: string;
let minervaHome: string;
let dnsAnswer: string;

function env(): Record<string, string> {
  return {
    MINERVA_HOME: minervaHome,
    MINERVA_SEED_REPO: seedRepo,
    MINERVA_PANTHEON_ROUTE_SELECT_URL: `data:application/json,${JSON.stringify({ cli: TURN_RUNNER, model: "none" })}`,
    PATH: `${join(scratch, "bin")}:${process.env.PATH}`,
    FAKE_DNS: dnsAnswer,
  };
}

function ok(method: string, params: Record<string, unknown> = {}): any {
  const res = call(method, params, env());
  assert.equal(res.status, 0, `${method} exited ${res.status}: ${JSON.stringify(res.error)}`);
  return res.result;
}

function propagated(visible: boolean): void {
  if (visible) writeFileSync(dnsAnswer, '"v=cutover-2026"\n');
  else rmSync(dnsAnswer, { force: true });
}

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "minerva-dns-cutover-"));
  minervaHome = join(scratch, "home");
  dnsAnswer = join(scratch, "dns-answer");
  mkdirSync(join(scratch, "bin"));
  // `dig +short TXT ...` prints whatever the test says the resolver currently sees.
  writeFileSync(join(scratch, "bin", "dig"), '#!/bin/sh\ncat "$FAKE_DNS" 2>/dev/null || true\n');
  chmodSync(join(scratch, "bin", "dig"), 0o755);
  seedRepo = createSeedRepo("minerva-seed-dns-cutover-");
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
});

test("docs/integrations.md shows tool.json verbatim", () => {
  const page = readFileSync(join(REPO, "docs", "integrations.md"), "utf8");
  const block = page.match(/<!-- from: docs\/examples\/dns-cutover\/tool\.json -->\n```json\n([\s\S]*?)```/);
  assert.ok(block, "docs/integrations.md has no tool.json block");
  assert.equal(block[1], readFileSync(join(EXAMPLE, "tool.json"), "utf8"));
});

test("worked example: a non-plugin-hive tool parks while the check cannot finish, then resumes from disk", () => {
  propagated(false);

  // Step 1: start the run with the descriptor. The check cannot finish, so the run parks.
  const { run_id: runId } = ok("startRun", { idea: IDEA, tool: TOOL, defaults: { mode: "off" } });
  assert.equal(ok("getRunStatus", { run_id: runId }).status, "waiting_on_human");

  const workspace = join(minervaHome, "runs", runId, "workspace");
  assert.equal(readFileSync(join(workspace, ".dns-cutover", "target"), "utf8"), "_cutover.example.com\nv=cutover-2026\n");
  assert.ok(!existsSync(join(workspace, ".pHive")), "a non-plugin-hive run creates no .pHive dir");

  // Step 2: the question is the only thing the caller sees.
  let [question] = ok("getQuestions", { run_id: runId, channel: "human" }).questions;
  assert.equal(question.id, "q-1");
  assert.match(question.text, /does not show v=cutover-2026 from 1\.1\.1\.1 yet/);

  // Step 3: re-checked too early -- it parks again on a new question.
  ok("submitAnswers", { run_id: runId, channel: "human", answers: [{ question_id: question.id, answer: "recheck" }] });
  assert.equal(ok("getRunStatus", { run_id: runId }).status, "waiting_on_human");
  [question] = ok("getQuestions", { run_id: runId, channel: "human" }).questions;
  assert.equal(question.id, "q-2");

  // Step 4: the record has propagated -- the resumed turn writes the plan and the run completes.
  propagated(true);
  ok("submitAnswers", { run_id: runId, channel: "human", answers: [{ question_id: question.id, answer: "recheck" }] });
  const status = ok("getRunStatus", { run_id: runId });
  assert.equal(status.status, "complete");
  assert.equal(status.metrics.turns, 3);

  // Step 5: the plan.
  const out = ok("getOutput", { run_id: runId });
  assert.equal(out.epic.epic_id, "cutover-_cutover.example.com");
  assert.deepEqual(
    out.epic.stories.map((s: { id: string }) => s.id),
    ["01-lower-ttl", "02-switch-records"],
  );
});
