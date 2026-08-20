# Design Discussion: driver-telemetry-and-allowlist-fix

## 0. Prelude

Source: triage `t-009` (prioritized p3/low) + `t-011` (prioritized p3/low), bundled into one small
epic. Both discretionary, both surfaced via backlog archaeology (a stale abandoned PR and a
round-2 grill pass), neither urgent or blocking. Picked up per operator direction to keep
iterating on the triaged backlog after the v0.2.1 release.

No PRIOR DECISIONS or NORTH STAR entries found.

## 1. Goal

1. **Driver lifecycle telemetry** — emit `driver_started`/`driver_succeeded`/`driver_failed`
   events from `ForkedHiveDriver.runTurn()` to a flat, operator-tailable JSONL log, genuinely new
   observability (not duplicating the existing per-run `RunMetrics`).
2. **Allowlist perf/hygiene fix** — stop shelling out to `git` for local-path
   `MINERVA_ALLOWED_TARGET_REPOS` entries that don't need slug derivation.

## 2. Proposed approach

### 2a. `src/telemetry.ts` (new)

```ts
export function emitTelemetryEvent(event: string, payload: Record<string, unknown> = {}): void
```

Appends one JSON line (`{event, emitted_at, ...payload}`) to
`<MINERVA_HOME>/events/<event>.jsonl`, creating the directory if needed. `MINERVA_HOME` resolution
matches the existing convention (`process.env.MINERVA_HOME ?? join(homedir(), ".minerva")`,
already used in `run-manager.ts`).

**Test isolation (confirmed by grill round 1, finding H1):** `src/real-forked-hive-driver.test.ts`
does NOT currently set `MINERVA_HOME` (verified — its `before()`/`after()` hooks only touch
`MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL`/`MINERVA_HIVE_PLUGIN_DIR`). The test-spec step must ADD a
`MINERVA_HOME` override (`mkdtempSync`-based temp dir, matching the pattern already used in
`run-manager.test.ts`) to this file's `before()`/`after()` hooks — otherwise a test exercising
`ForkedHiveDriver.runTurn()` would write real JSONL files into the developer's actual
`~/.minerva/events/` directory.

### 2b. Wire into `ForkedHiveDriver.runTurn()` (`src/driver.ts`)

Around the existing `spawnRuntime()` call: `driver_started` before, `driver_succeeded` after,
`driver_failed` (with `err.message`) in a catch that rethrows unchanged — telemetry must never
swallow or alter the original error/control flow.

### 2c. `isTargetRepoAllowed()` fix (`src/kickoff-engine.ts`)

Before calling `normalizeTargetRepoValue(entry)` for slug comparison, check whether `entry` is
"clearly a local path" (starts with `/` or `~`) — if so, skip slug derivation for that entry
entirely (the exact-string match above it already covers local paths; if it didn't match exactly,
a local path entry can't match by slug either, since local paths don't carry a derivable slug
without a live git remote read — so skipping is behavior-preserving, not a semantic change, just
removes dead work).

## 3. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Telemetry write failure (disk full, permissions) crashes a driver turn | low | `emitTelemetryEvent` should not be wrapped in try/catch that swallows errors silently, but also must not become a new failure mode for `runTurn` — keep the call synchronous and let a genuine fs error surface (matches this codebase's fail-loud discipline); this is opt-in observability, not core to correctness, so a real fs error here is worth knowing about, not hiding. |
| `isTargetRepoAllowed`'s local-path detection (`starts with / or ~`) misses a local-path shape and still shells out | low | Behavior-preserving either way — worst case is the unnecessary subprocess call still happens for an edge-case path shape, not a correctness regression. Exact-match still catches the common case first. |

## 4. Dependencies

None external.

## 5. Open questions

None — both fixes are narrowly scoped per the research brief's non-goals.

## 6. Scale assessment

**Small.** Two small, independent, well-scoped additions across 3 files (`telemetry.ts` new,
`driver.ts`, `kickoff-engine.ts`), no cross-layer coordination, no UI. Design discussion is
sufficient — no H/V planning or structured outline needed.
