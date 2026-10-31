// tool-descriptor.test.ts — p2-01-minerva-tool-descriptor (PANT-1248). startRun takes a TOOL
// DESCRIPTOR; plugin-hive is its default value rather than a constant in the code path. Driven
// in-process by a recording fake Driver against real temp git repos and real file I/O -- no live
// runtime, no network (MINERVA_PLAN_AGNOSTIC=off keeps the agnostic route lookup offline).

import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRun, submitAnswers, getQuestions, __setDriverForTest } from "./kickoff-engine.ts";
import { readRunRecord, type RunRecord } from "./run-manager.ts";
import { findCompletedEpics, getOutput } from "./output-emitter.ts";
import { listEnvelopes } from "./envelope-detection.ts";
import { drivePromptSuffix } from "./plan-defaults.ts";
import { createSeedRepo } from "./test-cli.ts";
import {
  PLUGIN_HIVE_TOOL,
  PLUGIN_HIVE_TOOL_ID,
  resolveTool,
  toolForRecord,
  baseBranchForRecord,
  type ToolDescriptor,
} from "./tool-descriptor.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

const ENV_KEYS = [
  "MINERVA_HOME",
  "MINERVA_SEED_REPO",
  "MINERVA_PLAN_AGNOSTIC",
  "MINERVA_TEST_DRIVE_PROMPT",
  "MINERVA_DRIVE_PROMPT",
  "MINERVA_BASE_BRANCH",
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let minervaHome: string;
let seedRepo: string;
let savedDriver: Driver;

// Records every DriverInput; each turn's behaviour is scripted by the test.
class RecordingDriver implements Driver {
  inputs: DriverInput[] = [];
  constructor(private readonly onTurn: (input: DriverInput, turn: number) => void = () => {}) {}
  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.inputs.push(input);
    this.onTurn(input, this.inputs.length);
    return {
      session_id: "sess",
      raw_result: JSON.stringify({
        question: "What should the tool name be?",
        suggested_channel: "human",
        confidence: 0.2,
        reason: "needs a human",
      }),
    };
  }
}

function useDriver(d: Driver): void {
  const prev = __setDriverForTest(d);
  if (savedDriver === undefined) savedDriver = prev;
}

function fakeTool(overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    id: "fake-tool",
    invoke: "fake-tool run --brief {idea}",
    state_path: ".fake-state",
    completion_detector: { kind: "epics-dir", epics_dir: "out/plans", worktree_roots: [] },
    question_source: { kind: "response" },
    ...overrides,
  };
}

function writeNestedEpic(root: string, epicsDir: string, id: string): void {
  const dir = join(root, epicsDir, id);
  mkdirSync(join(dir, "stories"), { recursive: true });
  writeFileSync(join(dir, "epic.yaml"), `id: ${id}\ntitle: ${id} epic\n`);
  writeFileSync(join(dir, "stories", "s1.yaml"), "id: s1\ntitle: first story\n");
}

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-tool-descriptor-"));
  seedRepo = createSeedRepo();
});

beforeEach(() => {
  process.env.MINERVA_HOME = minervaHome;
  process.env.MINERVA_SEED_REPO = seedRepo;
  process.env.MINERVA_PLAN_AGNOSTIC = "off";
  delete process.env.MINERVA_TEST_DRIVE_PROMPT;
  delete process.env.MINERVA_DRIVE_PROMPT;
  delete process.env.MINERVA_BASE_BRANCH;
});

afterEach(() => {
  if (savedDriver !== undefined) __setDriverForTest(savedDriver);
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
});

// --- AC1: no descriptor => identical to today ----------------------------------------------------

test("given no descriptor, the drive prompt is today's literal plugin-hive plan command", async () => {
  const d = new RecordingDriver();
  useDriver(d);
  const idea = "a tiny CLI todo app";
  const { run_id } = await startRun({ idea });
  const record = readRunRecord(run_id as string);

  assert.equal(d.inputs.length, 1);
  assert.equal(d.inputs[0]!.prompt, `/plugin-hive:plan ${idea} --skip-sign-off --lite` + drivePromptSuffix(record.defaults!));
  assert.equal(d.inputs[0]!.sessionId, null);
  assert.equal(record.state_path, join(record.workspace_path, ".pHive"));
  assert.ok(existsSync(record.state_path));
  assert.equal(record.tool_id, PLUGIN_HIVE_TOOL_ID);
  assert.equal(record.base_branch, "dev");
  assert.equal(record.status, "waiting_on_human");
});

test("given no descriptor, an idea containing $-patterns is passed through literally", async () => {
  const d = new RecordingDriver();
  useDriver(d);
  const idea = "price it at $& or $1 per $$";
  const { run_id } = await startRun({ idea });
  const record = readRunRecord(run_id as string);
  assert.equal(d.inputs[0]!.prompt, `/plugin-hive:plan ${idea} --skip-sign-off --lite` + drivePromptSuffix(record.defaults!));
});

test("given no descriptor, plugin-hive completion (nested .pHive/epics and .claude/worktrees) still marks the run complete", async () => {
  const d = new RecordingDriver((input) => writeNestedEpic(join(input.cwd, ".claude", "worktrees", "wt-1"), ".pHive/epics", "hive-epic"));
  useDriver(d);
  const { run_id } = await startRun({ idea: "a habit tracker" });
  const record = readRunRecord(run_id as string);
  assert.equal(record.status, "complete");
  const out = getOutput({ run_id }) as { epics: Array<{ epic_id: string }> };
  assert.deepEqual(out.epics.map((e) => e.epic_id), ["hive-epic"]);
});

test("the plugin-hive descriptor is the default value of resolveTool", () => {
  assert.deepEqual(resolveTool(undefined), PLUGIN_HIVE_TOOL);
  assert.deepEqual(resolveTool(PLUGIN_HIVE_TOOL_ID), PLUGIN_HIVE_TOOL);
  assert.equal(PLUGIN_HIVE_TOOL.invoke, "/plugin-hive:plan {idea} --skip-sign-off --lite");
  assert.equal(PLUGIN_HIVE_TOOL.state_path, ".pHive");
});

// --- config: MINERVA_DRIVE_PROMPT promoted from the old test seam -------------------------------

test("MINERVA_DRIVE_PROMPT overrides the default invoke; MINERVA_TEST_DRIVE_PROMPT keeps working; the real name wins", async () => {
  process.env.MINERVA_TEST_DRIVE_PROMPT = "legacy seam for {idea}";
  let d = new RecordingDriver();
  useDriver(d);
  let rec = readRunRecord((await startRun({ idea: "x1" })).run_id as string);
  assert.equal(d.inputs[0]!.prompt, "legacy seam for x1" + drivePromptSuffix(rec.defaults!));

  process.env.MINERVA_DRIVE_PROMPT = "configured {idea} and {idea}";
  d = new RecordingDriver();
  useDriver(d);
  rec = readRunRecord((await startRun({ idea: "x2" })).run_id as string);
  assert.equal(d.inputs[0]!.prompt, "configured x2 and x2" + drivePromptSuffix(rec.defaults!));
  assert.equal(rec.tool_id, PLUGIN_HIVE_TOOL_ID);
});

// --- AC2 + AC3 + AC4: a non-plugin-hive tool -----------------------------------------------------

test("given a non-plugin-hive descriptor, its invoke string is used and plugin-hive is never referenced", async () => {
  process.env.MINERVA_TEST_DRIVE_PROMPT = "legacy seam for {idea}"; // an explicit descriptor wins over env
  const d = new RecordingDriver();
  useDriver(d);
  const { run_id } = await startRun({ idea: "lint the docs", tool: fakeTool(), defaults: { mode: "off" } });
  const record = readRunRecord(run_id as string);

  assert.equal(d.inputs[0]!.prompt, "fake-tool run --brief lint the docs");
  for (const input of d.inputs) {
    assert.doesNotMatch(input.prompt, /plugin-hive/);
    assert.equal(input.questions_dir, undefined);
  }
  assert.equal(record.state_path, join(record.workspace_path, ".fake-state"));
  assert.ok(existsSync(record.state_path));
  assert.ok(!existsSync(join(record.workspace_path, ".pHive")), "no .pHive dir is created for a non-hive tool");
  assert.equal(record.tool_id, "fake-tool");
  assert.doesNotMatch(JSON.stringify(record.tool), /pHive|plugin-hive|\.claude/);
});

test("given a custom state_path + completion_detector, completion ignores .pHive and .claude/worktrees", async () => {
  // Turn 1: the tool writes decoys in the plugin-hive locations only -> must NOT complete.
  // Turn 2 (the continuation, after an answer): the tool writes its own plan dir -> completes.
  const d = new RecordingDriver((input, turn) => {
    if (turn === 1) {
      writeNestedEpic(input.cwd, ".pHive/epics", "decoy-hive");
      writeNestedEpic(join(input.cwd, ".claude", "worktrees", "wt"), "out/plans", "decoy-worktree");
    } else {
      writeNestedEpic(input.cwd, "out/plans", "real-plan");
    }
  });
  useDriver(d);
  const { run_id } = await startRun({ idea: "plan a migration", tool: fakeTool(), defaults: { mode: "off" } });
  assert.equal(readRunRecord(run_id as string).status, "waiting_on_human");

  const q = (getQuestions({ run_id, channel: "human" }) as { questions: Array<{ id: string }> }).questions[0]!;
  await submitAnswers({ run_id, channel: "human", answers: [{ question_id: q.id, answer: "migrator" }] });

  const record = readRunRecord(run_id as string);
  assert.equal(record.status, "complete");
  assert.equal(d.inputs[1]!.prompt, "migrator");
  const out = getOutput({ run_id }) as { epics: Array<{ epic_id: string }> };
  assert.deepEqual(out.epics.map((e) => e.epic_id), ["real-plan"]);
});

test("given a continuation turn, the descriptor is read back from the run record", async () => {
  const d = new RecordingDriver();
  useDriver(d);
  const tool = fakeTool({ id: "envelope-tool", question_source: { kind: "envelope-dir", path: ".tool/asks" } });
  const { run_id } = await startRun({ idea: "persist me", tool, defaults: { mode: "off" } });
  const record = readRunRecord(run_id as string);
  assert.equal(record.tool_id, "envelope-tool");
  assert.deepEqual(toolForRecord(record), tool);

  const q = (getQuestions({ run_id, channel: "human" }) as { questions: Array<{ id: string }> }).questions[0]!;
  await submitAnswers({ run_id, channel: "human", answers: [{ question_id: q.id, answer: "ok" }] });
  // Both the first turn and the continuation turn get the tool's own question source.
  assert.deepEqual(d.inputs.map((i) => i.questions_dir), [".tool/asks", ".tool/asks"]);
});

test("a run record written before descriptors existed resolves to the plugin-hive default", () => {
  const legacy = { run_id: "r", workspace_path: "/w" } as RunRecord;
  assert.deepEqual(toolForRecord(legacy), PLUGIN_HIVE_TOOL);
  assert.equal(baseBranchForRecord(legacy), "dev");
  // An id with no frozen descriptor resolves through the registry.
  assert.deepEqual(toolForRecord({ ...legacy, tool_id: PLUGIN_HIVE_TOOL_ID }), PLUGIN_HIVE_TOOL);
});

// --- validation: fail loud, never guess ----------------------------------------------------------

test("an invalid descriptor fails loudly with VALIDATION_FAILED before any workspace is allocated", () => {
  const bad: unknown[] = [
    "no-such-tool",
    42,
    { ...fakeTool(), id: "" },
    { ...fakeTool(), invoke: "" },
    { ...fakeTool(), state_path: "/abs/path" },
    { ...fakeTool(), state_path: "../escape" },
    { ...fakeTool(), completion_detector: { kind: "magic" } },
    { ...fakeTool(), completion_detector: { kind: "epics-dir", epics_dir: "../x", worktree_roots: [] } },
    { ...fakeTool(), completion_detector: { kind: "epics-dir", epics_dir: "x", worktree_roots: ["/abs"] } },
    { ...fakeTool(), question_source: { kind: "envelope-dir" } },
    { ...fakeTool(), question_source: { kind: "carrier-pigeon" } },
    { ...fakeTool(), base_branch: "-rf" },
    { ...fakeTool(), base_branch: "a..b" },
    (({ question_source: _q, ...rest }) => rest)(fakeTool()),
  ];
  for (const tool of bad) {
    assert.throws(() => resolveTool(tool), (e: any) => e?.code === "VALIDATION_FAILED", `expected rejection: ${JSON.stringify(tool)}`);
  }
});

test("startRun rejects an invalid descriptor without driving a turn", async () => {
  const d = new RecordingDriver();
  useDriver(d);
  await assert.rejects(startRun({ idea: "x", tool: { ...fakeTool(), state_path: "../../etc" } }), (e: any) => e?.code === "VALIDATION_FAILED");
  assert.equal(d.inputs.length, 0);
});

// --- base branch: descriptor- or config-supplied, `dev` by default --------------------------------

function addBranch(repo: string, branch: string): string {
  execFileSync("git", ["-C", repo, "branch", branch, "dev"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", branch]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", `only on ${branch}`]);
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repo, "checkout", "-q", "dev"]);
  return sha;
}

function workspaceBaseSha(record: RunRecord): string {
  return execFileSync("git", ["-C", record.workspace_path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

test("a descriptor's base_branch is where the run worktree is cut from, and is persisted", async () => {
  const repo = createSeedRepo("minerva-tool-base-");
  try {
    const mainSha = addBranch(repo, "main");
    useDriver(new RecordingDriver());
    const { run_id } = await startRun({ idea: "x", target_repo: repo, tool: fakeTool({ base_branch: "main" }), defaults: { mode: "off" } });
    const record = readRunRecord(run_id as string);
    assert.equal(record.base_branch, "main");
    assert.equal(workspaceBaseSha(record), mainSha);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("MINERVA_BASE_BRANCH configures the base branch when the descriptor does not", async () => {
  const repo = createSeedRepo("minerva-tool-base-env-");
  try {
    const trunkSha = addBranch(repo, "trunk");
    process.env.MINERVA_BASE_BRANCH = "trunk";
    useDriver(new RecordingDriver());
    const { run_id } = await startRun({ idea: "x", target_repo: repo });
    const record = readRunRecord(run_id as string);
    assert.equal(record.base_branch, "trunk");
    assert.equal(workspaceBaseSha(record), trunkSha);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// --- the detectors themselves ---------------------------------------------------------------------

test("findCompletedEpics honours a custom detector's epics_dir and worktree_roots", () => {
  const root = mkdtempSync(join(tmpdir(), "minerva-detector-"));
  try {
    writeNestedEpic(root, ".pHive/epics", "hive");
    writeNestedEpic(join(root, "wt-root", "a"), "plans", "nested-in-root");
    writeNestedEpic(root, "plans", "top");
    const detector = { kind: "epics-dir" as const, epics_dir: "plans", worktree_roots: ["wt-root"] };
    assert.deepEqual(findCompletedEpics(root, new Set(), detector).map((e) => e.epic_id), ["top", "nested-in-root"]);
    assert.deepEqual(findCompletedEpics(root).map((e) => e.epic_id), ["hive"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listEnvelopes reads a custom questions dir", () => {
  const root = mkdtempSync(join(tmpdir(), "minerva-envelopes-"));
  try {
    mkdirSync(join(root, ".tool", "asks"), { recursive: true });
    writeFileSync(join(root, ".tool", "asks", "e.yaml"), "id: e1\nskill: s\nphase: p\nstatus: pending\nquestions: []\n");
    assert.deepEqual(listEnvelopes(root, ".tool/asks").map((e) => e.id), ["e1"]);
    assert.deepEqual(listEnvelopes(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
