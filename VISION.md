# Minerva — Vision

**Headline:** Minerva grows from a *driven* idea-to-spec engine into a **self-tuning planning
brain** — one that auto-detects the right methodology per idea, scores the quality of the plans it
produces, and A/B-tests whole planning strategies against real build outcomes.

Minerva is one god in [Pantheon](https://github.com/mdostal/pantheon-v2). The platform-wide
direction applies here too: **everything is swappable, and you can toggle any language / model /
plugin / god on and off and compare metrics at every step.** Minerva's `Driver` abstraction is the
first concrete expression of that — the mechanism that drives a planning turn is a selectable
implementation, not a hard-wired call.

Pick a rung and jump in.

---

## ① Current — what runs today

Minerva is real, tested code (TDD, `npm run ci`), version `0.2.0`. It is **not** a long-running
service — it's a subprocess driven one JSON call at a time.

- **Runs where you invoke it.** No daemon, no server, no port. `bin/minerva.ts` reads one JSON
  request from stdin, dispatches, writes one JSON response to stdout, and exits `0`/`1`. Run state
  persists on the **filesystem** under `~/.minerva/runs` (override with `MINERVA_HOME`). There is
  **no external DB**.
- **The subprocess ABI works end-to-end.** `capabilities`, `startRun`, `getRunStatus`, `listRuns`,
  `getQuestions`, `submitAnswers`, `getOutput`, `abortRun` — the `{method, params}` →
  `{result}` / `{error}` envelope, wire-compatible with plugin-hive's task-tracking adapter ABI
  (v1.0.0).
- **It really drives plugin-hive.** The Kickoff+Plan engine invokes plugin-hive's `kickoff` +
  `plan` skills headlessly against a **per-run isolated git workspace** — a worktree cut from the
  target repo's `dev` branch for an existing codebase, or a fresh `git init` scratch repo for a
  greenfield idea.
- **Questions are extracted and routed.** Each headless turn's question is pulled via a constrained
  `--json-schema` call and self-classified `agent` vs `human`, so callers only ever see clean,
  routed questions.
- **No autonomous progress.** A run advances **only** when a caller invokes `submitAnswers`.
  `getRunStatus: in_progress` between calls does not mean background work is happening.
- **Swappable Driver (working):**
  - `SpawnDriver` (default) — `claude -p` / `--resume`, with real SIGINT/SIGTERM hardening.
  - `SubagentDriver` (opt-in, `MINERVA_DRIVER=subagent`) — `claude --bg` + poll + stop + resume,
    which survives its launching process being killed, closing the orphaned-subprocess failure mode.
  - `ForkedHiveDriver` — **an intentional stub that throws.** plugin-hive-fork does not exist yet;
    it fails loudly rather than fabricating a result.
- **Cleanup is external.** Every run's completion or abort is recorded in an append-only cleanup
  ledger for outside garbage collection — **Minerva itself never deletes a workspace.**

**Honest status: working (wip).** The core loop and both live drivers are proven and tested; the
fork-based driver is a stub, and Minerva does not yet run as a hosted service.

## ② Goals — near-term next steps

- **Headless / structured-question planning with pre-baked defaults.** Today's question loop still
  leans on a caller answering interactively; the next step is fully headless planning where common
  questions carry sensible pre-baked defaults so a run can complete without a human in the loop when
  nothing genuinely needs a decision — only true `human`-channel questions escalate.
- **Land `ForkedHiveDriver` for real.** Consume plugin-hive-fork's structured headless-question
  protocol directly (no spawn-and-parse), turning the stub into a first-class driver.
- **Wire the decision surface.** Connect the `human`-channel questions to the live Delphi / Consus
  surface so escalations become real decision threads, and answers flow straight back into
  `submitAnswers`.
- **Emit planning metrics.** `hive.config.yaml` already turns metrics on; surface per-run planning
  metrics (turns, escalations, time-to-spec, driver used) for comparison.

## ③ Long-term vision — where it grows

- **Methodology auto-detect.** Instead of a fixed `default_methodology`, Minerva reads the idea and
  the target codebase and picks the right approach per run (TDD, spike-first, design-first, thin
  slice) — and can explain why.
- **Plan-quality metrics.** Score the plans Minerva emits — story granularity, dependency-graph
  health, estimate realism, downstream rework — and feed that score back so planning improves from
  its own build outcomes rather than from vibes.
- **Plan A/B.** Because the `Driver` and the whole planning strategy are swappable, run the *same*
  idea through two planners/models/methodologies and compare the resulting plans (and, eventually,
  the builds they produce) head-to-head on those quality metrics. This is Minerva's take on the
  platform-wide **toggle-and-compare** principle: no planning approach is privileged; the metrics
  decide.
- **Many ideas, in parallel, self-tuning.** The end state is a planner you fire a stream of ideas
  at — each getting its own run, its own escalations, and its own scored plan — where the planner
  is continuously learning which strategy wins for which kind of idea.

---

## Good first contributions

- **Add a `--help` / usage banner** to `bin/minerva.ts` and a `docs/abi.md` reference listing every
  method, its params, and its result shape (much of it is already implied by `src/dispatch.ts`).
- **Expand pre-baked question defaults** so more of the common kickoff/plan questions can resolve on
  the `agent` channel without escalating.
- **Add a smoke-test harness** that exercises the full ABI (`startRun` → `getQuestions` →
  `submitAnswers` → `getOutput`) end-to-end against a cheap synthetic drive prompt
  (`MINERVA_TEST_DRIVE_PROMPT`).
- **Surface a per-run metrics summary** (turns, escalations, driver, elapsed) — a first step toward
  the plan-quality scoring in §③.
- **Prototype the `ForkedHiveDriver`** against plugin-hive-fork's structured-question protocol once
  it lands (see `docs/minerva-next-tests-and-driver-paths.md`).

See [README.md](./README.md) for how to run Minerva, and
[pantheon-v2](https://github.com/mdostal/pantheon-v2) for the host it plugs into.
