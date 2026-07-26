# Changelog

All notable changes to Minerva are documented in this file.

## [Unreleased]

## [0.1.1] - 2026-07-26

**Minerva ships as an agent-drivable idea-to-spec engine — plugin-hive's kickoff+plan flow is now callable end-to-end over a stable subprocess ABI, with a swappable, orphan-resistant driver underneath.**

### Added

- **Subprocess ABI + Run Manager** (PR #1): Minerva now exposes a JSON-over-stdio ABI (`capabilities`, `startRun`, `getQuestions`, `submitAnswers`, `getOutput`, `abortRun`, `getRunStatus`, `listRuns`) that drives plugin-hive's kickoff+plan skills headlessly against an isolated, per-run git workspace — a fresh worktree branch cut from `dev` for an existing repo, or a scratch git-init for a greenfield idea.
- **Question extraction + escalation classification** (PR #1): each headless turn's question is extracted via a constrained `--json-schema` call and self-classified (`agent` vs `human`) against an escalate/absorb principle, so callers only ever see clean, routed questions rather than raw prose.
- **Output emission + cleanup ledger** (PR #1): a completed run's approved epic+stories are served through `getOutput` (never a partial artifact), and every run's completion or abort is durably recorded in an append-only cleanup ledger for external garbage collection — Minerva itself never deletes a workspace.
- **Swappable Driver abstraction** (PR #2): the mechanism that actually drives a headless turn is now a `Driver` interface with two implementations behind `MINERVA_DRIVER` — the existing `claude -p`/`--resume` spawn mechanism (now with real SIGINT/SIGTERM hardening), and an opt-in `claude --bg`-based driver that survives its own launching process being killed, closing the orphaned-subprocess failure mode that motivated this release. A configurable `MINERVA_TURN_TIMEOUT_MS` ceiling and automatic session cleanup on timeout round out the hardening.

### Fixed

- Orphaned `claude` subprocesses that survived Minerva's own process exiting on interrupt, with no way to resume or reap them, are eliminated for the opt-in `MINERVA_DRIVER=subagent` path, and gracefully interrupted (SIGINT/SIGTERM) for the default path (PR #2).
