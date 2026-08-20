# Research Brief: driver-telemetry-and-allowlist-fix

Source: triage `t-009` (driver lifecycle telemetry) and `t-011` (allowlist unnecessary git
shell-out). Bundled into one small epic — both are src/ hardening/observability additions
surfaced during the post-v0.2.1-release backlog sweep, neither urgent, neither blocking anything
shipped.

## t-009 — Driver lifecycle telemetry

Surfaced closing out stale PR #57 (opened 2026-08-11, never merged — predates and would conflict
with the `fix-test-suite-flakiness-t006` fix to `real-forked-hive-driver.test.ts`'s `FORK_PATH`
handling). The PR's actual diff (`gh pr diff 57`) is a useful reference for intent, not something
to merge:

- New `src/telemetry.ts`: `emitTelemetryEvent(event, payload)` appends a JSON line to
  `~/.minerva/events/<event>.jsonl` (respecting `MINERVA_HOME` override, matching the existing
  test-isolation convention used throughout this codebase).
- `src/driver.ts`'s `ForkedHiveDriver.runTurn()` (the class lives in `driver.ts`, not a separate
  file — confirmed by reading current `driver.ts`) wraps its `spawnRuntime()` call: emits
  `driver_started` before, `driver_succeeded` after success, `driver_failed` (with the error
  message) on catch, then rethrows.

**Important distinction from an existing mechanism (do not duplicate/confuse):**
`src/run-manager.ts` already has a `RunMetrics` system (`recordDriverTurn`,
`updateRunMetricsDriver`, `finalizeRunMetrics`, surfaced via `getRunStatus`/`getOutput`) — but
that's per-RUN introspection embedded in the run record (turns/driver/elapsed for THIS run),
not an operational event stream. What t-009 proposes is a flat, cross-run JSONL log an operator
could tail/ship to external monitoring — a genuinely different, complementary concern, not a
duplicate. Scope stays narrow: `ForkedHiveDriver` only, matching what was actually proposed and
what the triage entry documented — not all three driver implementations.

## t-011 — Allowlist unnecessary git shell-out

Surfaced by a round-2 `/grill` pass on the just-shipped `harden-run-id-and-target-repo-boundaries`
epic. `src/kickoff-engine.ts:108-118`'s `isTargetRepoAllowed()` calls
`normalizeTargetRepoValue(entry)` for every configured `MINERVA_ALLOWED_TARGET_REPOS` entry that
doesn't exact-string-match the `target_repo` being checked. For local-path entries, this triggers
a real `execFileSync("git", ["-C", localPath, "remote", "get-url", "origin"], ...)` subprocess
call (`src/target-repo-signal.ts:57-72`'s local-path branch) — unnecessary work, and makes the
allowlist outcome depend on live filesystem/git state of *other* configured paths that have
nothing to do with the `target_repo` actually being validated.

Fix: skip slug-derivation entirely when an allowlist entry is clearly a local path (starts with
`/` or `~`) — exact-string match is the only mechanism ever intended for local-path entries.

## Non-goals

- t-009 does not touch `SpawnDriver`/`SubagentDriver` — scope is `ForkedHiveDriver` only, per what
  was actually proposed/discovered.
- t-009 does not replace or refactor the existing `RunMetrics` system — additive, separate concern.
- t-011 does not change the allowlist's semantics — same accept/reject outcomes, just without the
  unnecessary subprocess call for path-shaped entries.

## Validation note

No third-party library/SDK involved. context7 validation not applicable.
