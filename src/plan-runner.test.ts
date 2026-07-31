// plan-runner.test.ts — the Auriga-facing headless-plan orchestration (prebaked-plan-defaults
// epic, integration slice). Fake-driver driven, no `claude` and no `multica` process. Proves the
// "plan this idea -> epic+stories" entry drives to completion unattended and hands back the
// decomposed stories a router would file.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __setDriverForTest } from "./kickoff-engine.ts";
import {
  runHeadlessPlan,
  storyToIssueFields,
  parseStoryDependsOn,
  fileStoriesToMultica,
  __setMulticaRunnerForTest,
} from "./plan-runner.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

let minervaHome: string;
let savedDriver: Driver;

// Emits N agent-channel single-select gates, then writes a real epic.yaml + two stories.
class PlanScriptedDriver implements Driver {
  turns = 0;
  constructor(private readonly gates: number) {}
  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.turns++;
    if (this.turns > this.gates) {
      const epicDir = join(input.cwd, ".pHive", "epics", "planned-epic");
      mkdirSync(join(epicDir, "stories"), { recursive: true });
      writeFileSync(join(epicDir, "epic.yaml"), "id: planned-epic\ntitle: Planned epic\n");
      writeFileSync(join(epicDir, "stories", "s1.yaml"), "id: s1\ntitle: First story\ndepends_on: []\n");
      writeFileSync(join(epicDir, "stories", "s2.yaml"), "id: s2\ntitle: Second story\ndepends_on: [s1]\n");
      return { session_id: "sess", raw_result: JSON.stringify({ question: "(none)", suggested_channel: "human", confidence: 0, reason: "done" }) };
    }
    return {
      session_id: "sess",
      raw_result: JSON.stringify({
        question: `Pick for gate ${this.turns}`,
        suggested_channel: "agent",
        confidence: 0.9,
        reason: "routine",
        kind: "single-select",
        options: ["Recommended: A", "B"],
        qid: `gate-${this.turns}`,
      }),
    };
  }
}

before(() => {
  minervaHome = mkdtempSync(join(tmpdir(), "minerva-home-planrunner-"));
  process.env.MINERVA_HOME = minervaHome;
  savedDriver = __setDriverForTest(new PlanScriptedDriver(0));
});

after(() => {
  __setDriverForTest(savedDriver);
  rmSync(minervaHome, { recursive: true, force: true });
});

test("runHeadlessPlan: auto mode drives an idea to a complete epic+stories, unattended", async () => {
  __setDriverForTest(new PlanScriptedDriver(2));
  const result = await runHeadlessPlan({ idea: "a small analytics dashboard", mode: "auto" });

  assert.equal(result.status, "complete");
  assert.ok(result.epic);
  assert.equal(result.epic!.epic_id, "planned-epic");
  assert.equal(result.epic!.stories.length, 2);
  assert.equal(result.pending_questions.length, 0);
});

test("runHeadlessPlan: parks (status waiting_on_human, epic null) when a gate has no default", async () => {
  // A human-channel gate + agent mode => parks. Never completes, but must not hang.
  class HumanGate implements Driver {
    async runTurn(): Promise<DriverResult> {
      return {
        session_id: "sess",
        raw_result: JSON.stringify({ question: "Core strategy?", suggested_channel: "human", confidence: 0.1, reason: "strategic", kind: "free-text", options: null }),
      };
    }
  }
  __setDriverForTest(new HumanGate());
  const result = await runHeadlessPlan({ idea: "a marketplace", mode: "agent" });

  assert.equal(result.status, "waiting_on_human");
  assert.equal(result.epic, null);
  assert.equal(result.pending_questions.length, 1);
});

// Real headless plugin-hive /plan runs write the FLAT layout: one `.pHive/epics/NN-name.yaml` per
// epic with an embedded `stories:` list, and a single run produces MANY epics. This driver
// reproduces that exact shape (2 flat epics, 2 + 3 stories) to prove runHeadlessPlan detects flat
// completion and hands back EVERY epic, not just the first -- the two bugs that blocked automatic
// filing of the 7-epic/34-story Votum plan.
class FlatMultiEpicDriver implements Driver {
  turns = 0;
  constructor(private readonly gates: number) {}
  async runTurn(input: DriverInput): Promise<DriverResult> {
    this.turns++;
    if (this.turns > this.gates) {
      const epicsDir = join(input.cwd, ".pHive", "epics");
      mkdirSync(epicsDir, { recursive: true });
      writeFileSync(
        join(epicsDir, "01-domain-model-store.yaml"),
        "id: domain-model-store\ntitle: Domain Model\nstories:\n" +
          "  - id: domain-types\n    title: Define domain types\n" +
          "  - id: append-only-store\n    title: Append-only store\n",
      );
      writeFileSync(
        join(epicsDir, "02-quorum-engine-rules.yaml"),
        "id: quorum-engine-rules\ntitle: Quorum Rules\nstories:\n" +
          "  - id: majority-rule\n    title: Majority rule\n" +
          "  - id: supermajority-rule\n    title: Supermajority rule\n" +
          "  - id: quorum-floor\n    title: Quorum floor\n",
      );
      return { session_id: "sess", raw_result: JSON.stringify({ question: "(none)", suggested_channel: "human", confidence: 0, reason: "done" }) };
    }
    return {
      session_id: "sess",
      raw_result: JSON.stringify({
        question: `Pick for gate ${this.turns}`, suggested_channel: "agent", confidence: 0.9,
        reason: "routine", kind: "single-select", options: ["Recommended: A", "B"], qid: `gate-${this.turns}`,
      }),
    };
  }
}

test("runHeadlessPlan: FLAT multi-epic plan is detected complete and returns EVERY epic + all stories", async () => {
  __setDriverForTest(new FlatMultiEpicDriver(1));
  const result = await runHeadlessPlan({ idea: "a decision engine", mode: "auto" });

  assert.equal(result.status, "complete");
  assert.equal(result.epics.length, 2, "both flat epics must be returned, not just the first");
  assert.deepEqual(result.epics.map((e) => e.epic_id), ["domain-model-store", "quorum-engine-rules"]);
  // Backward-compat singular field is the first epic.
  assert.equal(result.epic!.epic_id, "domain-model-store");
  const totalStories = result.epics.reduce((n, e) => n + e.stories.length, 0);
  assert.equal(totalStories, 5, "every story across both epics is available to file (2 + 3)");
  assert.equal(result.pending_questions.length, 0);
});

test("storyToIssueFields: derives title from story YAML, keeps full content as description", () => {
  const f = storyToIssueFields({ id: "s1", content: "id: s1\ntitle: Build the API\n" });
  assert.equal(f.title, "[s1] Build the API");
  assert.match(f.description, /Build the API/);
});

test("storyToIssueFields: falls back to the story id when YAML has no title", () => {
  const f = storyToIssueFields({ id: "s9", content: "not: really\n" });
  assert.equal(f.title, "[s9] s9");
});

test("parseStoryDependsOn: reads top-level depends_on list, ignores step-level depends_on", () => {
  assert.deepEqual(parseStoryDependsOn({ id: "s2", content: "id: s2\ndepends_on: [s1, s0]\n" }), ["s1", "s0"]);
  assert.deepEqual(parseStoryDependsOn({ id: "s1", content: "id: s1\ndepends_on: []\n" }), []);
  // Only the TOP-LEVEL depends_on counts; a step-level depends_on must NOT be picked up.
  assert.deepEqual(
    parseStoryDependsOn({ id: "s0", content: "id: s0\nsteps:\n  - id: a\n    depends_on: [b]\n" }),
    [],
  );
  assert.deepEqual(parseStoryDependsOn({ id: "s0", content: "not: yaml: [broken" }), []);
});

test("fileStoriesToMultica: files into the SEED ticket's project (not the CLI default) and carries depends_on", () => {
  const calls: string[][] = [];
  const prev = __setMulticaRunnerForTest((args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "get") {
      // The seed ticket lives in Pantheon Core — filed stories must inherit THIS project.
      return { id: "SEED", project_id: "d8ecfab4-pantheon-core", status: "todo" };
    }
    if (args[0] === "issue" && args[1] === "create") {
      const title = String(args[args.indexOf("--title") + 1] ?? "");
      // Return a distinct id per story so the depends_on map can resolve.
      return { id: title.includes("s1") ? "ISSUE-1" : "ISSUE-2" };
    }
    if (args[0] === "issue" && args[1] === "metadata") return { ok: true };
    return null;
  });
  try {
    const epic = {
      epic_id: "e1",
      stories: [
        { id: "s1", content: "id: s1\ntitle: First\ndepends_on: []\n" },
        { id: "s2", content: "id: s2\ntitle: Second\ndepends_on: [s1]\n" },
      ],
    } as any;
    const r = fileStoriesToMultica("SEED", epic);

    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.deepEqual(r.filed.map((f) => f.issue_id).sort(), ["ISSUE-1", "ISSUE-2"]);

    // Every create carried --project = the seed's own project and --status todo.
    const creates = calls.filter((a) => a[0] === "issue" && a[1] === "create");
    assert.equal(creates.length, 2);
    for (const c of creates) {
      assert.equal(c[c.indexOf("--project") + 1], "d8ecfab4-pantheon-core");
      assert.equal(c[c.indexOf("--status") + 1], "todo");
      assert.equal(c[c.indexOf("--parent") + 1], "SEED");
    }

    // s2's depends_on [s1] was carried as metadata pointing at s1's RESOLVED issue id.
    const meta = calls.find((a) => a[0] === "issue" && a[1] === "metadata" && a[2] === "set");
    assert.ok(meta, "expected a depends_on metadata set for the dependent story");
    assert.equal(meta![meta!.indexOf("--key") + 1], "depends_on");
    assert.equal(meta![meta!.indexOf("--value") + 1], "ISSUE-1");
    // s1 has no deps -> no metadata call for it (only one metadata set total).
    assert.equal(calls.filter((a) => a[1] === "metadata").length, 1);
  } finally {
    __setMulticaRunnerForTest(prev);
  }
});

test("fileStoriesToMultica: stamps opts.targetRepo onto each child story (description + metadata)", () => {
  const calls: string[][] = [];
  const descs: Record<string, string> = {};
  const prev = __setMulticaRunnerForTest((args: string[]) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "get") return { id: "SEED", project_id: "proj" };
    if (args[0] === "issue" && args[1] === "create") {
      // capture the description file contents the create was given
      const df = args[args.indexOf("--description-file") + 1];
      if (df) { try { descs[df] = readFileSync(df, "utf8"); } catch {} }
      const title = String(args[args.indexOf("--title") + 1] ?? "");
      return { id: title.includes("s1") ? "ISSUE-1" : "ISSUE-2" };
    }
    if (args[0] === "issue" && args[1] === "metadata") return { ok: true };
    return null;
  });
  try {
    const epic = {
      epic_id: "e1",
      stories: [
        { id: "s1", content: "id: s1\ntitle: First\ndepends_on: []\n" },
        { id: "s2", content: "id: s2\ntitle: Second\ndepends_on: []\n" },
      ],
    } as any;
    const r = fileStoriesToMultica("SEED", epic, { targetRepo: "mdostal/cron-maker" });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));

    // Every filed story's DESCRIPTION carried the build-lane target_repo signal.
    const bodies = Object.values(descs);
    assert.equal(bodies.length, 2);
    for (const b of bodies) assert.match(b, /target_repo:\s*mdostal\/cron-maker/, `desc must carry target_repo: ${b}`);

    // And each was ALSO set as ticket metadata target_repo (build lane's secondary signal).
    const metaSets = calls.filter((a) => a[1] === "metadata" && a[2] === "set" && a[a.indexOf("--key") + 1] === "target_repo");
    assert.equal(metaSets.length, 2, "one target_repo metadata set per filed story");
    for (const m of metaSets) assert.equal(m[m.indexOf("--value") + 1], "mdostal/cron-maker");
  } finally {
    __setMulticaRunnerForTest(prev);
  }
});

test("fileStoriesToMultica: explicit opts.project overrides the seed's project", () => {
  const creates: string[][] = [];
  const prev = __setMulticaRunnerForTest((args: string[]) => {
    if (args[0] === "issue" && args[1] === "get") return { id: "SEED", project_id: "seed-proj" };
    if (args[0] === "issue" && args[1] === "create") { creates.push(args); return { id: "X" }; }
    return null;
  });
  try {
    const epic = { epic_id: "e1", stories: [{ id: "s1", content: "id: s1\ntitle: One\ndepends_on: []\n" }] } as any;
    fileStoriesToMultica("SEED", epic, { project: "explicit-proj" });
    const create = creates[0]!;
    assert.equal(create[create.indexOf("--project") + 1], "explicit-proj");
  } finally {
    __setMulticaRunnerForTest(prev);
  }
});
