# Changelog

All notable changes to Minerva are documented in this file.

## [Unreleased]

### Added

- **Pre-baked plan defaults — fresh headless runs no longer hang** (`feat/prebaked-plan-defaults`): a new `plan-defaults` layer lets a fresh plan run supply operator-pre-decided answers to the standard kickoff/plan gate questions automatically, so an idea-build drives kickoff+plan to a finished epic+stories unattended instead of parking on the first gate. Three modes (`off` = classic park-everything default; `agent` = auto-answer routine/`agent`-channel gates, still escalate genuine strategic `human` gates per AD-5; `auto` = fully unattended). Config resolves from built-in → `MINERVA_PLAN_DEFAULTS` file → `MINERVA_PLAN_DEFAULTS_MODE` env → per-run `startRun params.defaults`, with sign-off/tech-stack/select-strategy/free-text/explicit-answer rules — all overridable per-run. Envelope questions now carry `kind`/`options`/`qid` end-to-end so selects get a real option picked, not just a free-text answer. See `docs/plan-defaults.example.yaml`.
- **Auriga-invokable headless-plan entry** (`bin/minerva-plan`): a router-facing one-shot command that turns a Multica ticket (or an idea-brief/idea) into a dependency-tracked epic + stories headlessly (pre-baked defaults, `mode: auto`), writes the `.pHive` epic+stories, and — with `--file-to-multica` — files the decomposed stories back to Multica as sub-issues linked to the origin ticket (left unassigned per standing policy). This is the interface Auriga routes an un-planned ticket to; only the resulting PLANNED stories then go to dev agents. Backed by `src/plan-runner.ts`; the core ABI stays Multica-agnostic. A `minerva-dev` Multica agent persona runs this on assigned tickets.

## [0.1.1] - 2026-07-26

**Minerva ships as an agent-drivable idea-to-spec engine — plugin-hive's kickoff+plan flow is now callable end-to-end over a stable subprocess ABI, with a swappable, orphan-resistant driver underneath.**

### Added

- **Subprocess ABI + Run Manager** (PR #1): Minerva now exposes a JSON-over-stdio ABI (`capabilities`, `startRun`, `getQuestions`, `submitAnswers`, `getOutput`, `abortRun`, `getRunStatus`, `listRuns`) that drives plugin-hive's kickoff+plan skills headlessly against an isolated, per-run git workspace — a fresh worktree branch cut from `dev` for an existing repo, or a scratch git-init for a greenfield idea.
- **Question extraction + escalation classification** (PR #1): each headless turn's question is extracted via a constrained `--json-schema` call and self-classified (`agent` vs `human`) against an escalate/absorb principle, so callers only ever see clean, routed questions rather than raw prose.
- **Output emission + cleanup ledger** (PR #1): a completed run's approved epic+stories are served through `getOutput` (never a partial artifact), and every run's completion or abort is durably recorded in an append-only cleanup ledger for external garbage collection — Minerva itself never deletes a workspace.
- **Swappable Driver abstraction** (PR #2): the mechanism that actually drives a headless turn is now a `Driver` interface with two implementations behind `MINERVA_DRIVER` — the existing `claude -p`/`--resume` spawn mechanism (now with real SIGINT/SIGTERM hardening), and an opt-in `claude --bg`-based driver that survives its own launching process being killed, closing the orphaned-subprocess failure mode that motivated this release. A configurable `MINERVA_TURN_TIMEOUT_MS` ceiling and automatic session cleanup on timeout round out the hardening.

### Fixed

- Orphaned `claude` subprocesses that survived Minerva's own process exiting on interrupt, with no way to resume or reap them, are eliminated for the opt-in `MINERVA_DRIVER=subagent` path, and gracefully interrupted (SIGINT/SIGTERM) for the default path (PR #2).
