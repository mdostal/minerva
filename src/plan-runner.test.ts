// plan-runner.test.ts — the Auriga-facing headless-plan orchestration (prebaked-plan-defaults
// epic, integration slice). Fake-driver driven, no `claude` and no `multica` process. Proves the
// "plan this idea -> epic+stories" entry drives to completion unattended and hands back the
// decomposed stories a router would file.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { __setDriverForTest } from "./kickoff-engine.ts";
import {
  runHeadlessPlan,
  storyToIssueFields,
  parseStoryDependsOn,
  fileStoriesToMultica,
  __setPantheonFetchForTest,
} from "./plan-runner.ts";
import type { Driver, DriverInput, DriverResult } from "./driver.ts";

let minervaHome: string;
let seedRepo: string; // throwaway repo self-provisioned as MINERVA_SEED_REPO -- startRun's
// no-target_repo path (exercised by every runHeadlessPlan call here, which never passes
// targetRepo) falls through to run-manager's resolveSeedRepo(), which otherwise defaults to
// ~/repos/consus-seeds and fails hard on a machine without that directory.
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

  seedRepo = mkdtempSync(join(tmpdir(), "minerva-seed-repo-planrunner-"));
  execFileSync("git", ["init", "-q", "-b", "dev", seedRepo]);
  execFileSync("git", ["-C", seedRepo, "config", "user.name", "Test User"]);
  execFileSync("git", ["-C", seedRepo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", seedRepo, "commit", "-q", "--allow-empty", "-m", "seed init"]);
  process.env.MINERVA_SEED_REPO = seedRepo;

  // Pantheon core-api base URL required by fileStoriesToMultica/resolveIdeaFromTicket.
  process.env.PANTHEON_CORE_API_URL = "http://pantheon.test:3000";

  savedDriver = __setDriverForTest(new PlanScriptedDriver(0));
});

after(() => {
  __setDriverForTest(savedDriver);
  rmSync(minervaHome, { recursive: true, force: true });
  rmSync(seedRepo, { recursive: true, force: true });
  delete process.env.PANTHEON_CORE_API_URL;
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

test("fileStoriesToMultica: files into the SEED ticket's project (not the API default) and carries depends_on", async () => {
  type Call = { method: string; url: string; body: unknown };
  const calls: Call[] = [];
  const prev = __setPantheonFetchForTest(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, url, body });
    if (init.method === "GET" && url.includes("/api/backlog/issues/SEED")) {
      // The seed ticket lives in Pantheon Core — filed stories must inherit THIS project.
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "SEED", project_id: "d8ecfab4-pantheon-core", status: "todo" }) };
    }
    if (init.method === "POST" && url.includes("/api/backlog/issues")) {
      const title = String((body as Record<string, unknown>).title ?? "");
      // Return a distinct id per story so the depends_on map can resolve.
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: title.includes("s1") ? "ISSUE-1" : "ISSUE-2" }) };
    }
    if (init.method === "PUT" && url.includes("/metadata")) {
      return { ok: true, status: 204, text: async () => "" };
    }
    return { ok: false, status: 500, text: async () => "unexpected call" };
  });
  try {
    const epic = {
      epic_id: "e1",
      stories: [
        { id: "s1", content: "id: s1\ntitle: First\ndepends_on: []\n" },
        { id: "s2", content: "id: s2\ntitle: Second\ndepends_on: [s1]\n" },
      ],
    } as any;
    const r = await fileStoriesToMultica("SEED", epic);

    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.deepEqual(r.filed.map((f) => f.issue_id).sort(), ["ISSUE-1", "ISSUE-2"]);

    // Every create used the seed's own project and status todo, parented to SEED.
    const creates = calls.filter((c) => c.method === "POST" && c.url.includes("/api/backlog/issues"));
    assert.equal(creates.length, 2);
    for (const c of creates) {
      const b = c.body as Record<string, unknown>;
      assert.equal(b.project, "d8ecfab4-pantheon-core");
      assert.equal(b.status, "todo");
      assert.equal(b.parent, "SEED");
    }

    // s2's depends_on [s1] was carried as metadata pointing at s1's RESOLVED issue id.
    const metaPuts = calls.filter((c) => c.method === "PUT" && c.url.includes("/metadata"));
    assert.equal(metaPuts.length, 1, "only one metadata PUT (for s2's depends_on)");
    const metaBody = metaPuts[0]!.body as Record<string, unknown>;
    assert.equal(metaBody.depends_on, "ISSUE-1");
    // s1 has no deps -> no metadata PUT for it (only one metadata PUT total).
  } finally {
    __setPantheonFetchForTest(prev);
  }
});

test("fileStoriesToMultica: stamps opts.targetRepo onto each child story (description + metadata)", async () => {
  type Call = { method: string; url: string; body: unknown };
  const calls: Call[] = [];
  const prev = __setPantheonFetchForTest(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, url, body });
    if (init.method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify({ id: "SEED", project_id: "proj" }) };
    if (init.method === "POST") {
      const title = String((body as Record<string, unknown>).title ?? "");
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: title.includes("s1") ? "ISSUE-1" : "ISSUE-2" }) };
    }
    return { ok: true, status: 204, text: async () => "" };
  });
  try {
    const epic = {
      epic_id: "e1",
      stories: [
        { id: "s1", content: "id: s1\ntitle: First\ndepends_on: []\n" },
        { id: "s2", content: "id: s2\ntitle: Second\ndepends_on: []\n" },
      ],
    } as any;
    const r = await fileStoriesToMultica("SEED", epic, { targetRepo: "mdostal/cron-maker" });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));

    // Every filed story's DESCRIPTION carried the build-lane target_repo signal.
    const creates = calls.filter((c) => c.method === "POST");
    assert.equal(creates.length, 2);
    for (const c of creates) {
      const b = c.body as Record<string, unknown>;
      assert.match(String(b.description ?? ""), /target_repo:\s*mdostal\/cron-maker/, `desc must carry target_repo`);
      // target_repo also carried as ticket metadata (the build lane's secondary signal).
      assert.equal((b.metadata as Record<string, unknown> | undefined)?.target_repo, "mdostal/cron-maker");
    }
  } finally {
    __setPantheonFetchForTest(prev);
  }
});

test("fileStoriesToMultica: falls back to the WORKSPACE origin remote for target_repo when none is declared", async () => {
  // A seed that never declared an explicit target_repo still plans inside a real run workspace whose
  // git origin IS the build target. Every child story must carry that workspace-derived target_repo,
  // so the build lane never blocks with "missing target_repo" (the regression this closes forward).
  const gitRepo = mkdtempSync(join(tmpdir(), "minerva-ws-origin-"));
  execFileSync("git", ["-C", gitRepo, "init", "-q"]);
  execFileSync("git", ["-C", gitRepo, "remote", "add", "origin", "git@github.com:mdostal/janus.git"]);

  type Call = { method: string; url: string; body: unknown };
  const calls: Call[] = [];
  const prev = __setPantheonFetchForTest(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, url, body });
    if (init.method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify({ id: "SEED", project_id: "proj" }) };
    if (init.method === "POST") {
      const title = String((body as Record<string, unknown>).title ?? "");
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: title.includes("s1") ? "ISSUE-1" : "ISSUE-2" }) };
    }
    return { ok: true, status: 204, text: async () => "" };
  });
  try {
    const epic = {
      epic_id: "e1",
      stories: [
        { id: "s1", content: "id: s1\ntitle: First\ndepends_on: []\n" },
        { id: "s2", content: "id: s2\ntitle: Second\ndepends_on: []\n" },
      ],
    } as any;
    // NOTE: no opts.targetRepo is passed — only the run workspace path.
    const r = await fileStoriesToMultica("SEED", epic, { workspacePath: gitRepo });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));

    const creates = calls.filter((c) => c.method === "POST");
    assert.equal(creates.length, 2, "both child stories filed");
    for (const c of creates) {
      const b = c.body as Record<string, unknown>;
      assert.match(String(b.description ?? ""), /target_repo:\s*mdostal\/janus/, `child story must carry workspace-derived target_repo`);
      // Also carried as ticket metadata (the build lane's secondary signal).
      assert.equal((b.metadata as Record<string, unknown> | undefined)?.target_repo, "mdostal/janus");
    }
  } finally {
    __setPantheonFetchForTest(prev);
    rmSync(gitRepo, { recursive: true, force: true });
  }
});

test("fileStoriesToMultica: explicit opts.project overrides the seed's project", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const prev = __setPantheonFetchForTest(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === "GET") return { ok: true, status: 200, text: async () => JSON.stringify({ id: "SEED", project_id: "seed-proj" }) };
    if (init.method === "POST") { creates.push(body as Record<string, unknown>); return { ok: true, status: 201, text: async () => JSON.stringify({ id: "X" }) }; }
    return { ok: true, status: 204, text: async () => "" };
  });
  try {
    const epic = { epic_id: "e1", stories: [{ id: "s1", content: "id: s1\ntitle: One\ndepends_on: []\n" }] } as any;
    await fileStoriesToMultica("SEED", epic, { project: "explicit-proj" });
    assert.equal(creates.length, 1);
    assert.equal(creates[0]!.project, "explicit-proj");
  } finally {
    __setPantheonFetchForTest(prev);
  }
});
