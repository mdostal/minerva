// plan-defaults.test.ts — pure, live-API-free tests for the pre-baked-defaults resolver +
// config loader (prebaked-plan-defaults epic). No `claude` process is spawned; every function
// under test is deterministic. This is the fixed-point contract the auto-answer loop rests on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MinervaError } from "./errors.ts";
import {
  BUILTIN_PLAN_DEFAULTS,
  loadPlanDefaults,
  resolveDefaultAnswer,
  drivePromptSuffix,
  type PlanDefaults,
  type ResolvableQuestion,
} from "./plan-defaults.ts";

// Run a body with a clean, restored plan-defaults env, so tests never leak env into each other.
function withEnv(vars: Record<string, string | undefined>, body: () => void): void {
  const keys = ["MINERVA_PLAN_DEFAULTS", "MINERVA_PLAN_DEFAULTS_MODE"];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    body();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function q(overrides: Partial<ResolvableQuestion>): ResolvableQuestion {
  return { text: "some question", channel: "agent", ...overrides };
}

const AGENT: PlanDefaults = { ...BUILTIN_PLAN_DEFAULTS, mode: "agent" };
const AUTO: PlanDefaults = { ...BUILTIN_PLAN_DEFAULTS, mode: "auto" };

// --- loadPlanDefaults -----------------------------------------------------------------------

test("loadPlanDefaults: built-in default is mode:off (backwards-compatible)", () => {
  withEnv({}, () => {
    assert.equal(loadPlanDefaults().mode, "off");
  });
});

test("loadPlanDefaults: MINERVA_PLAN_DEFAULTS_MODE overrides the mode", () => {
  withEnv({ MINERVA_PLAN_DEFAULTS_MODE: "agent" }, () => {
    assert.equal(loadPlanDefaults().mode, "agent");
  });
});

test("loadPlanDefaults: per-run defaults override env", () => {
  withEnv({ MINERVA_PLAN_DEFAULTS_MODE: "agent" }, () => {
    assert.equal(loadPlanDefaults({ mode: "auto" }).mode, "auto");
  });
});

test("loadPlanDefaults: invalid mode fails loudly", () => {
  withEnv({}, () => {
    assert.throws(() => loadPlanDefaults({ mode: "banana" }), MinervaError);
  });
});

test("loadPlanDefaults: invalid MINERVA_PLAN_DEFAULTS_MODE fails loudly", () => {
  withEnv({ MINERVA_PLAN_DEFAULTS_MODE: "nope" }, () => {
    assert.throws(() => loadPlanDefaults(), MinervaError);
  });
});

test("loadPlanDefaults: per-run answers are prepended (higher priority) to file/built-in answers", () => {
  withEnv({}, () => {
    const cfg = loadPlanDefaults({
      mode: "agent",
      answers: [{ match: "tech stack", answer: "Rust" }],
    });
    assert.equal(cfg.answers.length, 1);
    assert.equal(cfg.answers[0]!.answer, "Rust");
  });
});

test("loadPlanDefaults: reads a YAML config file via MINERVA_PLAN_DEFAULTS, per-run still wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-defaults-file-"));
  const file = join(dir, "defaults.yaml");
  writeFileSync(
    file,
    "mode: agent\ntech_stack: TypeScript / Node.js\nanswers:\n  - match: database\n    answer: Postgres\n",
  );
  try {
    withEnv({ MINERVA_PLAN_DEFAULTS: file }, () => {
      const cfg = loadPlanDefaults({ tech_stack: "Go" });
      assert.equal(cfg.mode, "agent");
      assert.equal(cfg.tech_stack, "Go"); // per-run overrides file
      // file answer preserved, and file+per-run answers merge
      assert.ok(cfg.answers.some((a) => a.answer === "Postgres"));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPlanDefaults: unreadable config file fails loudly", () => {
  withEnv({ MINERVA_PLAN_DEFAULTS: "/no/such/plan-defaults-file.yaml" }, () => {
    assert.throws(() => loadPlanDefaults(), MinervaError);
  });
});

test("loadPlanDefaults: an answer rule with neither qid nor match is rejected", () => {
  withEnv({}, () => {
    assert.throws(() => loadPlanDefaults({ answers: [{ answer: "x" }] as any }), MinervaError);
  });
});

// --- resolveDefaultAnswer -------------------------------------------------------------------

test("resolve: mode off always parks (returns null)", () => {
  assert.equal(resolveDefaultAnswer(q({}), BUILTIN_PLAN_DEFAULTS, "idea"), null);
});

test("resolve: explicit qid match wins regardless of channel/mode", () => {
  const d: PlanDefaults = { ...AGENT, answers: [{ qid: "metrics", answer: "yes, enable metrics" }] };
  const got = resolveDefaultAnswer(q({ channel: "human", qid: "metrics", text: "Enable metrics?" }), d, "idea");
  assert.equal(got, "yes, enable metrics");
});

test("resolve: explicit substring match wins even on a human-channel question in agent mode", () => {
  const d: PlanDefaults = { ...AGENT, answers: [{ match: "sign-off", answer: "Approved by operator" }] };
  const got = resolveDefaultAnswer(q({ channel: "human", text: "Ready for sign-off on scope?" }), d, "idea");
  assert.equal(got, "Approved by operator");
});

test("resolve: agent mode parks a human-channel question with no explicit answer (AD-5 preserved)", () => {
  const got = resolveDefaultAnswer(q({ channel: "human", text: "What is the core strategy?" }), AGENT, "idea");
  assert.equal(got, null);
});

test("resolve: auto mode answers kickoff metrics opt-in with the protocol default off", () => {
  const got = resolveDefaultAnswer(
    q({ channel: "human", qid: "metrics-opt-in", text: "Enable metrics tracking?", kind: "single-select", options: ["yes", "no"] }),
    AUTO,
    "idea",
  );
  assert.equal(got, "no");
});

test("resolve: auto mode derives kickoff project type from the idea before generic option picking", () => {
  const got = resolveDefaultAnswer(
    q({
      channel: "human",
      qid: "project_type",
      text: "What type of project is this?",
      kind: "single-select",
      options: ["framework", "consumer-app", "service"],
    }),
    AUTO,
    "Plan a tiny internal CLI service that prints task status from a local JSON file",
  );
  assert.equal(got, "service");
});

test("resolve: auto mode derives kickoff UI and ship target defaults from the idea", () => {
  const hasUi = resolveDefaultAnswer(
    q({ channel: "agent", qid: "has_ui", text: "Does this project have a UI?", kind: "single-select", options: ["yes", "no"] }),
    AUTO,
    "Plan a headless backend service",
  );
  assert.equal(hasUi, "no");

  const shipKind = resolveDefaultAnswer(
    q({
      channel: "human",
      qid: "ship_kind",
      text: "What does shipping mean for this project?",
      kind: "single-select",
      options: ["app-store", "vercel", "github-release", "npm", "custom"],
    }),
    AUTO,
    "Plan a tiny internal CLI service",
  );
  assert.equal(shipKind, "github-release");
});

test("resolve: auto mode answers a human-channel free-text question via the free-text default", () => {
  const got = resolveDefaultAnswer(q({ channel: "human", text: "What is the core strategy?" }), AUTO, "a todo app");
  assert.ok(typeof got === "string" && got.length > 0);
});

test("resolve: sign-off gate picks the approving option", () => {
  const got = resolveDefaultAnswer(
    q({ text: "Do you approve this scope to proceed?", kind: "single-select", options: ["Yes, proceed", "No, revise"] }),
    AGENT,
    "idea",
  );
  assert.equal(got, "Yes, proceed");
});

test("resolve: sign-off gate with no options falls back to an affirmation string", () => {
  const got = resolveDefaultAnswer(q({ text: "Ready to finalize?" }), AGENT, "idea");
  assert.equal(got, "Approved — proceed.");
});

test("resolve: tech-stack question answered with configured stack", () => {
  const d: PlanDefaults = { ...AGENT, tech_stack: "TypeScript / Node.js" };
  const got = resolveDefaultAnswer(q({ text: "What language/framework should we use?" }), d, "idea");
  assert.equal(got, "TypeScript / Node.js");
});

test("resolve: single-select recommended strategy prefers the recommended option", () => {
  const got = resolveDefaultAnswer(
    q({ text: "Pick a persistence layer", kind: "single-select", options: ["SQLite", "Postgres (recommended)"] }),
    AGENT,
    "idea",
  );
  assert.equal(got, "Postgres (recommended)");
});

test("resolve: single-select first strategy takes the first option", () => {
  const d: PlanDefaults = { ...AGENT, select_strategy: "first" };
  const got = resolveDefaultAnswer(
    q({ text: "Pick a persistence layer", kind: "single-select", options: ["SQLite", "Postgres (recommended)"] }),
    d,
    "idea",
  );
  assert.equal(got, "SQLite");
});

test("resolve: multi-select returns a single-element array", () => {
  const got = resolveDefaultAnswer(
    q({ text: "Pick integrations", kind: "multi-select", options: ["Slack", "Email"] }),
    AGENT,
    "idea",
  );
  assert.deepEqual(got, ["Slack"]);
});

test("resolve: free-text default interpolates {idea}", () => {
  const d: PlanDefaults = { ...AGENT, free_text_default: "Proceed sensibly for: {idea}" };
  const got = resolveDefaultAnswer(q({ text: "Any other constraints?", kind: "free-text" }), d, "a habit tracker");
  assert.equal(got, "Proceed sensibly for: a habit tracker");
});

test("resolve: free_text_default null parks a free-text question", () => {
  const d: PlanDefaults = { ...AGENT, free_text_default: null };
  const got = resolveDefaultAnswer(q({ text: "Any other constraints?", kind: "free-text" }), d, "idea");
  assert.equal(got, null);
});

test("resolve: prose question with no kind uses the free-text default", () => {
  const got = resolveDefaultAnswer(q({ text: "What is your favorite fruit?" }), AGENT, "idea");
  assert.ok(typeof got === "string" && got.length > 0);
});

// --- drivePromptSuffix ----------------------------------------------------------------------

test("drivePromptSuffix: empty when unset, prefixed with a blank line when set", () => {
  assert.equal(drivePromptSuffix(BUILTIN_PLAN_DEFAULTS), "");
  assert.equal(drivePromptSuffix({ ...AGENT, drive_prompt_suffix: "skip sign-off" }), "\n\nskip sign-off");
});
