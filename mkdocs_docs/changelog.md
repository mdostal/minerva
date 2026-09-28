# Changelog

All notable changes to Minerva are documented in this file.

## [Unreleased]

### Added

- **MkDocs documentation site** (PANT-188): a full MkDocs Material reference site under
  `mkdocs_docs/`, a custom landing page at `site/index.html`, and a two-zone GitHub Pages deploy
  workflow that only ever writes the `/docs/` subdirectory of `gh-pages`.
- **Docs-contract test** (PANT-907): `src/docs-contract.test.ts` fails if a method registered in
  `dispatch.ts` is missing from `mkdocs_docs/abi-reference.md` (or the reverse), and if the
  documented `submitAnswers` example no longer passes the handler's answer validation.
- **`stub-claude` test harness**: `bin/stub-claude.ts` is a fake `claude` CLI (`-p`, `--bg`,
  `agents --json`, `stop`). The test suite uses it when real Claude auth is unavailable, replacing
  35 skip guards so the full suite runs auth-free.

### Changed

- **Sibling-god calls go through Pantheon core-api** (PANT-255): `plan-runner.ts` no longer shells
  out to the Multica CLI; it uses core-api's `/api/backlog/issues` endpoints via
  `PANTHEON_CORE_API_URL`. `driver.ts` and `agnostic-plan-driver.ts` no longer call Heimdall over
  HTTP; route selection is `POST /api/route/select` via `MINERVA_PANTHEON_ROUTE_SELECT_URL` or
  `MINERVA_PANTHEON_CORE_API_URL`. The old `MINERVA_HEIMDALL_URL` and
  `MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL` variables are no longer read.

### Fixed

- **Stale worktree base**: `startRun` now fetches and fast-forwards `origin/dev` in the target repo
  before cutting the run's worktree (non-fatal if offline or diverged).
- **Docs drift** (PANT-907): the ABI reference, quickstart, architecture page, README and VISION
  now match the code. Covers the `submitAnswers` `question_id` field, the `capabilities` result,
  the removed `startRun.constraints`, seed-repo workspace allocation, `getRunStatus.metrics`,
  `getOutput.epics`, the `ForkedHiveDriver` status, the version and in-process auto-answering.

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
