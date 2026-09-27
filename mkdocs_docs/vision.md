# Vision & Roadmap

**Headline:** Minerva grows from a *driven* idea-to-spec engine into a **self-tuning planning
brain** — one that auto-detects the right methodology per idea, scores the quality of the plans it
produces, and A/B-tests whole planning strategies against real build outcomes.

Minerva is one god in [Pantheon](https://github.com/mdostal/pantheon-v2). The platform-wide
direction applies here too: **everything is swappable, and you can toggle any language / model /
plugin / god on and off and compare metrics at every step.** Minerva's `Driver` abstraction is the
first concrete expression of that — the mechanism that drives a planning turn is a selectable
implementation, not a hard-wired call.

---

## ① Current — what runs today

Minerva is real, tested code (TDD, `npm run ci`), version `0.3.0`. It is **not** a long-running
service — it's a subprocess driven one JSON call at a time.

- **Runs where you invoke it.** No daemon, no server, no port. `bin/minerva.ts` reads one JSON
  request from stdin, dispatches, writes one JSON response to stdout, and exits. Run state
  persists on the filesystem under `~/.minerva/runs`.
- **The subprocess ABI works end-to-end.** All 8 methods (`capabilities`, `startRun`,
  `getRunStatus`, `listRuns`, `getQuestions`, `submitAnswers`, `getOutput`, `abortRun`) are real,
  tested, and wire-compatible with plugin-hive's task-tracking adapter ABI (v1.0.0).
- **It really drives plugin-hive.** The Kickoff+Plan engine invokes plugin-hive's `kickoff` +
  `plan` skills headlessly against a per-run isolated git workspace.
- **Questions are extracted and routed.** Each headless turn's question is pulled via a constrained
  `--json-schema` call and self-classified `agent` vs `human`, so callers only ever see clean,
  routed questions.
- **Swappable Driver:** SpawnDriver (default), SubagentDriver (orphan-resistant), and
  ForkedHiveDriver (headless-question protocol, needs `MINERVA_HIVE_PLUGIN_DIR` until
  plugin-hive#341 merges).
- **Pre-baked defaults:** `MINERVA_PLAN_DEFAULTS_MODE=auto` for fully unattended planning.

## ② Near-term goals

- **Land `ForkedHiveDriver` for real.** Consume plugin-hive-fork's structured headless-question
  protocol directly (no spawn-and-parse), turning the stub into a first-class driver, once
  `hive-workshop#127` merges.
- **Wire the decision surface.** Connect `human`-channel questions to the live Delphi / Consus
  surface so escalations become real decision threads, and answers flow back into `submitAnswers`.
- **Emit planning metrics.** Surface per-run planning metrics (turns, escalations, time-to-spec,
  driver used) for comparison — `hive.config.yaml` already has `metrics.enabled: true`.

## ③ Long-term vision

- **Methodology auto-detect.** Instead of a fixed `default_methodology`, Minerva reads the idea
  and the target codebase and picks the right approach per run (TDD, spike-first, design-first,
  thin slice) — and explains why.
- **Plan-quality metrics.** Score the plans Minerva emits — story granularity, dependency-graph
  health, estimate realism, downstream rework — and feed that score back so planning improves from
  its own build outcomes.
- **Plan A/B.** Run the *same* idea through two planners/models/methodologies and compare the
  resulting plans (and the builds they produce) head-to-head. This is Minerva's take on the
  platform-wide **toggle-and-compare** principle: no planning approach is privileged; the metrics
  decide.
- **Many ideas, in parallel, self-tuning.** The end state is a planner you fire a stream of ideas
  at — each getting its own run, its own escalations, and its own scored plan — where the planner
  continuously learns which strategy wins for which kind of idea.

---

## Good first contributions

- **Add a `--help` / usage banner** to `bin/minerva.ts`.
- **Expand `docs/abi.md`** with an ABI reference listing every method, its params, and its result
  shape (much of it is already implied by `src/dispatch.ts`).
- **Expand pre-baked question defaults** so more of the common kickoff/plan questions resolve on
  the `agent` channel without escalating.
- **Add a smoke-test harness** that exercises the full ABI (`startRun` → `getQuestions` →
  `submitAnswers` → `getOutput`) end-to-end against a cheap synthetic drive prompt
  (`MINERVA_TEST_DRIVE_PROMPT`).
- **Surface a per-run metrics summary** (turns, escalations, driver, elapsed) — a first step
  toward the plan-quality scoring in §③.
- **Prototype the `ForkedHiveDriver`** against plugin-hive-fork's structured-question protocol
  once `hive-workshop#127` lands.

See [Contributing](contributing.md) for how to get started.
