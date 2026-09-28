# Changelog

All notable changes to Minerva are documented in this file.

## [Unreleased]

### Added

- **`getMetrics` ABI method** (PANT-906): cross-run planning KPIs from local run records only
  (no network), overall, by driver and by route lane: run count by status, completion rate, and
  median/p90 turns, escalations, auto-resolutions and time-to-spec. Also exposed as an MCP tool
  and as `minerva metrics`. Runs now record their route lane (`metrics.lane`, `"<cli>:<model>"`).
- **Driver lifecycle telemetry for every driver**: `SpawnDriver` and `SubagentDriver` now emit
  the same `driver_started`/`driver_succeeded`/`driver_failed` events as `ForkedHiveDriver`.
  Events carry a `driver` field; `driver_succeeded` carries `lane`.

### Fixed

- **Escalations no longer inflate on polling** (PANT-906): `metrics.escalations` counted every
  `getQuestions(channel: "human")` call that returned questions, so polling a parked run counted
  the same escalation many times. Each human-channel question now counts once, when it is parked
  on the human queue (stamped `escalated_at`); `getQuestions` is read-only.

## [0.3.0] - 2026-08-20

### Added

- **Driver lifecycle telemetry for `ForkedHiveDriver`** (triage `t-009`): a new `src/telemetry.ts`
  (`emitTelemetryEvent`) emits `driver_started`/`driver_succeeded`/`driver_failed` JSONL events
  to `<MINERVA_HOME>/events/` — a flat cross-run operational log an operator can tail/ship
  externally, deliberately separate from the per-run `RunMetrics` system. Scoped to
  `ForkedHiveDriver` only. Telemetry never swallows or alters the original error path.

### Fixed

- **`target_repo` allowlist no longer shells out to git unnecessarily** (triage `t-011`):
  `isTargetRepoAllowed()` skips slug derivation for `MINERVA_ALLOWED_TARGET_REPOS` entries that
  are clearly local paths — the pre-existing exact-string match already covers them. Behavior-
  preserving.

---

## [0.2.1] - 2026-08-19

### Security

- **`run_id` validated as UUID-shaped at ABI boundaries** (`dispatch.ts`, `mcp-server.ts`) before
  it can reach a filesystem path join. Scoped deliberately to the boundary, not `run-manager.ts`
  itself, so internal call sites with non-UUID placeholder values keep working.
- **`MINERVA_ALLOWED_TARGET_REPOS`** opt-in env var lets operators constrain which local repo
  paths `startRun` may target. Unset (the default), behavior is completely unchanged.

---

## [0.2.0] - 2026-08-19

### Added

- **Pre-baked plan defaults — fresh headless runs no longer hang**: `MINERVA_PLAN_DEFAULTS_MODE`
  (`off`/`agent`/`auto`) lets a fresh plan run auto-answer standard kickoff/plan gate questions.
  `mode: agent` auto-answers routine `agent`-channel gates while still parking genuine strategic
  `human` gates. Config resolves from built-in → `MINERVA_PLAN_DEFAULTS` file → env var →
  per-run `startRun params.defaults`. See [`docs/plan-defaults.example.yaml`](https://github.com/mdostal/minerva/blob/main/docs/plan-defaults.example.yaml).
- **`bin/minerva-plan`** — router-facing one-shot command: Multica ticket (or idea-brief) →
  dependency-tracked epic + stories headlessly, with `--file-to-multica` to file decomposed
  stories back as sub-issues.
- **One-command agent/harness onboarding**: `minerva mcp` exposes the 8-method ABI as MCP tools.
  `minerva agent init`/`minerva agent status` detect installed harnesses, register the MCP server,
  and install the `minerva-plan` usage skill.
- **Live public GitHub Pages landing site** at `https://mdostal.github.io/minerva/`.

### Security

- **Git-clone-injection in `resolveLocalCheckout` closed**: `target_repo` from a Multica ticket
  is untrusted. Scope the `git clone` subprocess to `GIT_ALLOW_PROTOCOL=file:https:ssh` rather
  than hand-rolling a URL-shape regex. Verified with a real regression test.

### Fixed

- **`startRun` no longer fails in a stock environment**: `resolveRuntimeRoute()` fails fast with
  a typed `HeimdallRouteError` (new `UPSTREAM_ERROR` ABI code). Hardcoded invalid
  `task-type=kickoff` Heimdall query param corrected to `task-type=planning`. A run whose first
  drive turn fails is now automatically transitioned to `aborted` instead of left orphaned.

### Removed

- **All direct Consus/Delphi coupling ripped out** of Minerva's core. `resumeFromConsusAnswer`,
  `resumeAnsweredConsusDecision`, `pollConsusAnswers`, `pollAndResumeConsusAnswers` methods and
  their 4 dedicated modules deleted. `awaiting-consus` run status removed.
- **`bin/ideate-to-consus.mjs` removed**: the idea↔decision-surface round trip is Pantheon-layer
  integration glue, not Minerva's.

---

## [0.1.1] - 2026-07-26

**Minerva ships as an agent-drivable idea-to-spec engine.**

### Added

- **Subprocess ABI + Run Manager**: `capabilities`, `startRun`, `getQuestions`, `submitAnswers`,
  `getOutput`, `abortRun`, `getRunStatus`, `listRuns` — drives plugin-hive's kickoff+plan skills
  headlessly against an isolated, per-run git workspace.
- **Question extraction + escalation classification**: each headless turn's question extracted
  via `--json-schema` and self-classified (`agent` vs `human`).
- **Output emission + cleanup ledger**: approved epic+stories via `getOutput`; every run
  completion/abort recorded in an append-only cleanup ledger.
- **Swappable Driver abstraction**: `SpawnDriver` (default, `claude -p`/`--resume` with
  SIGINT/SIGTERM hardening) and `SubagentDriver` (opt-in `MINERVA_DRIVER=subagent`, orphan-
  resistant via `claude --bg`). Configurable `MINERVA_TURN_TIMEOUT_MS` ceiling.
