# Research Brief: Fix Minerva's `startRun` (Heimdall Routing Failure Chain)

**Requirement:** Fix `startRun` (default `SpawnDriver`), which fails end-to-end in a stock
environment via four coupled defects: a non-fail-open Heimdall routing call, a task-type
mismatch between Minerva and Heimdall's real API, a debuggability bug that mislabels every
failure as `UNKNOWN_METHOD`, and an orphaned-run cleanup gap on first-turn failure.

**Method:** Findings below come from (a) two independent live black-box `startRun` invocations
against `dev` via Minerva's ABI (`npx tsx bin/minerva.ts`), one of which also stood up a real
Heimdall instance as a read-only diagnostic, and (b) this session's own follow-up source read of
`src/driver.ts`, `src/dispatch.ts`, `src/agnostic-plan-driver.ts`, `src/run-manager.ts`,
`src/kickoff-engine.ts`, `src/cleanup-ledger.ts`, `src/errors.ts`, and the existing test
`src/driver-route.test.ts`. No code was changed by either the live test or this brief.

---

## Summary

`startRun`'s first drive turn always calls `resolveRuntimeRoute()` (`src/driver.ts:153-178`) to
ask Heimdall which runtime/model to spawn. That call is **not fail-open**: any network failure,
non-2xx response, or malformed body throws, and nothing catches it before it reaches the ABI
caller. In a stock environment (no Heimdall running, the default on a fresh machine) this throws
immediately. Even with Heimdall running, the endpoint is called with a hardcoded
`task-type=kickoff` (`src/driver.ts:123`) that Heimdall's live API rejects with HTTP 400 — the
real Heimdall vocabulary is `planning`/`build`/`review`. Both failure modes are swallowed by
`src/dispatch.ts`'s generic catch-all (`src/dispatch.ts:74-85`) and re-labeled `UNKNOWN_METHOD`
regardless of cause, even though `startRun` is a recognized, correctly-dispatched method. Because
`allocateRun()` (`src/run-manager.ts:281-330`) durably writes the run record and creates the
workspace *before* `startRun` attempts its first turn (`src/kickoff-engine.ts:299` vs. `:320`),
every one of these failures leaves a permanently orphaned run stuck at `status: "in_progress"`
with no automatic transition to `aborted` and no ledger entry — even though the exact
"transition to `aborted` + emit ledger record" mechanism already exists and is unused on this
path (`abortRun` / `recordCleanup`, `src/cleanup-ledger.ts:43-77`).

This is not confined to `SpawnDriver`: `SubagentDriver.runTurn()` (`src/driver.ts:670`) and
`ForkedHiveDriver`'s `dispatchFresh`/`classify` (`src/driver.ts:871`, `:949`) all call the same
non-fail-open `resolveRuntimeRoute()` directly, so `MINERVA_DRIVER=subagent` and
`MINERVA_DRIVER=forked` are exposed to the identical failure mode, not just the default `spawn`
driver.

---

## Key files & surfaces

| File | Surface | Role in the bug chain |
|---|---|---|
| `src/driver.ts:119-124` | `availableRouteUrl()` | Hardcodes `task-type=kickoff` in the query string; only the base URL is configurable (`MINERVA_HEIMDALL_URL`/`HEIMDALL_URL`/`MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL`). |
| `src/driver.ts:153-178` | `resolveRuntimeRoute()` | The non-fail-open Heimdall lookup. No try/catch-and-fallback; throws on fetch failure, non-2xx, non-JSON, or a payload missing `cli`/`model`. |
| `src/driver.ts:594-600` | `SpawnDriver.runTurn()` | Calls `resolveRuntimeRoute()` at line 595 with no error handling — the default driver's exposure point. |
| `src/driver.ts:668-697` | `SubagentDriver.runTurn()` | Calls the same `resolveRuntimeRoute()` at line 670 — same exposure, confirmed by direct read (not covered by the original live test, which only exercised the default `spawn` driver). |
| `src/driver.ts:855-960` | `ForkedHiveDriver` | `dispatchFresh()` (line 871) and `classify()` (line 949) both call `resolveRuntimeRoute()` — same exposure a third time. |
| `src/agnostic-plan-driver.ts:80-102` | `resolvePlanningRoute()` | The sibling Heimdall lookup for planning. Explicitly fail-open by design — doc comment "BULLETPROOF CLAUDE FALLBACK ... returns null on ANY doubt" (lines 13-16); implementation wraps the fetch in try/catch returning `null` on any error (lines 84-102). Calls `/available-route?task-type=planning` (line 88) — the correct Heimdall vocabulary. |
| `src/dispatch.ts:71-85` | `dispatch()`'s handler try/catch | Any non-`MinervaError` exception thrown by a handler (including everything inside `startRun`'s call chain) is coerced to `{code: "UNKNOWN_METHOD", message: e.message}` at lines 78-84 — regardless of whether the method name was actually unrecognized. The *only* other branch that produces `UNKNOWN_METHOD` is the real "unrecognized method" case at lines 60-69. Both are indistinguishable to the caller. |
| `src/errors.ts:1-6` | `ErrorCode` union | Only 5 values exist: `NOT_FOUND`, `VALIDATION_FAILED`, `WRONG_CHANNEL`, `NOT_READY`, `UNKNOWN_METHOD`. There is no code for "an internal/upstream dependency call failed" — `UNKNOWN_METHOD` is arguably the closest available label today, not merely a lazy choice among equals. |
| `src/run-manager.ts:281-330` | `allocateRun()` | Creates the git worktree (or fresh-init repo) and durably writes `run.yaml` with `status: "in_progress"` (line 309) synchronously, before any drive turn is attempted. |
| `src/kickoff-engine.ts:278-336` | `startRun()` | Line 299 calls `allocateRun()`; line 320 calls `runTurnResumable(driver, ...)` for the first turn. No try/catch wraps the turn call — an exception here propagates straight out of `startRun` with the run record already persisted. |
| `src/kickoff-engine.ts:90-101` | `runTurnResumable()` | Retries **only** on `TurnTimeoutError` (line 96: `if (!(e instanceof TurnTimeoutError)) throw e;`). A `resolveRuntimeRoute()` failure is a plain `Error`, not `TurnTimeoutError`, so it is never retried — it propagates on the first attempt. |
| `src/kickoff-engine.ts:375-421` | `submitAnswers()` | Also calls `runTurnResumable(driverForRecord(record), ...)` at line 418, using `driverForRecord()` (lines 111-117), which falls back to the same module-level `driver` (default `SpawnDriver`) whenever the run wasn't routed to an agnostic planning driver. Confirms `submitAnswers` hits the identical `resolveRuntimeRoute()` failure mode as `startRun` on any run using the default driver. |
| `src/cleanup-ledger.ts:1-5, 43-77` | `abortRun()` / `recordCleanup()` | The existing, already-callable mechanism for terminal-state transition + ledger recording (`status: "aborted"`, `finalizeRunMetrics`, one `CleanupLedgerRecord` + one `cleanup_needed` event). Never invoked automatically on a `startRun` first-turn failure. Doc comment: "Minerva never deletes `workspace_path` or `state_path` itself — record and signal only; an external system is responsible for cleanup" (AD-4). |
| `src/driver-route.test.ts:97-103` | Existing test coverage | `resolveRuntimeRoute()`'s fail-loudly behavior on non-2xx/non-JSON Heimdall responses **is already asserted by an existing test** (`assert.rejects(...)`). This is the answer to "does `resolveRuntimeRoute()` have tests exercising its failure paths": yes, but the assertion encodes today's throw-through behavior as intentional/expected, not as a gap the test suite failed to notice. Any fix that changes this to fail-open must update this test consciously. |

---

## Patterns & conventions

- **Fail-open precedent already exists in this codebase**, one file away: `agnostic-plan-driver.ts`'s `resolvePlanningRoute()` wraps its Heimdall fetch in try/catch, returns `null` on any doubt, and documents the rationale inline (`src/agnostic-plan-driver.ts:13-16, 80-102`). It calls the same kind of endpoint (`/available-route?task-type=...`) with the same kind of base-URL env-var resolution (`MINERVA_HEIMDALL_URL` / `HEIMDALL_URL`, line 25) that `driver.ts`'s `resolveRuntimeRoute()` uses (`driver.ts:122`). This is the pattern the two live-test agents flagged as a plausible template — see Open Questions for why it should not be assumed to transfer as-is.
- **"Fail loudly, never guess" is an explicit, repeated design philosophy elsewhere in this codebase** — `MINERVA_DRIVER`'s unrecognized-value handling (`kickoff-engine.ts:28-44`), `MINERVA_TURN_TIMEOUT_MS` (`driver.ts:55-72`), and `MINERVA_TURN_RETRY_LIMIT` (`kickoff-engine.ts:60-81`) all throw on bad/unexpected input rather than silently defaulting. `resolveRuntimeRoute()`'s current throw-through behavior is consistent with that house style, which is exactly why it's covered by an explicit test (`driver-route.test.ts:97-103`) rather than being an obvious oversight.
- **Retry scope is narrowly and deliberately typed**: `runTurnResumable()` (`kickoff-engine.ts:90-101`) retries only `TurnTimeoutError`, with an explicit comment that any other error "propagates immediately, unchanged, exactly as before this fix" (line 89). A Heimdall-routing error is intentionally excluded from this retry path today.
- **The cleanup-ledger module already establishes the vocabulary and mechanism for terminal-run handling** (`cleanup-ledger.ts`): `abortRun()` is idempotent on an already-terminal run (lines 69-71), and `recordCleanup()` guarantees exactly one `CleanupLedgerRecord` per terminal transition. Any orphaned-run fix has an existing, tested seam to plug into rather than needing a new mechanism.
- **`baseline_epic_ids` (`run-manager.ts:79-86`) and `defaults`/`plan_runtime` freezing at `allocateRun`/`startRun` time** show the codebase's established pattern of snapshotting state early and immutably per-run — relevant context for reasoning about what "partial state" exists by the time a first-turn failure occurs.

---

## Constraints

- **AD-4 (documented in `cleanup-ledger.ts:1-5`): Minerva never deletes `workspace_path` or `state_path` itself.** Any fix for the orphaned-run gap that involves deleting the git worktree or `.pHive` state directory directly would contradict this standing architectural decision. The existing pattern is record + signal (ledger + `cleanup_needed` event), with actual deletion left to an external system.
- **`ErrorCode` is a closed union of 5 values** (`errors.ts:1-6`) with none suited to "internal/upstream dependency call failed." Fixing the debuggability bug (misleading `UNKNOWN_METHOD`) requires either adding a new `ErrorCode` value or otherwise changing `dispatch.ts`'s catch-all (`dispatch.ts:78-84`) to distinguish "real unknown method" (line 61-69, checked before the handler even runs) from "handler threw" (line 71-85) — these are already two structurally distinct code paths in `dispatch()`, just currently mapped to the same code.
- **The task-type mismatch is corroborated against a live, running Heimdall instance**, not inferred: the raw findings report Heimdall's `/available-route` returning `HTTP 400 {"error":"invalid_task_type","allowed_task_types":["planning","build","review"]}` for `task-type=kickoff`, confirmed via direct `curl` outside of Minerva. `kickoff` is not a valid Heimdall task type today; `agnostic-plan-driver.ts` already uses the valid `planning` value for its own turn kind. There is no equivalent-validated value for a "startRun kickoff/build turn" in the raw findings — see Open Questions.
- **Even a corrected task-type value would not be sufficient to unblock a live run in the tested environment**: the same live Heimdall instance reported the local `claude@mathew.dostal` execution lane as `"down"` / `"unconfigured — no status recorded yet"`. This is explicitly a Heimdall-side/deployment-side configuration gap outside Minerva's own code, per the raw findings — it bounds what "fixed" can mean for this epic (Minerva can stop mis-calling Heimdall and stop mislabeling the result, but cannot make an unconfigured Heimdall lane report as up).
- **Three driver implementations, not one, share the vulnerable call**: `SpawnDriver` (`driver.ts:595`), `SubagentDriver` (`driver.ts:670`), and `ForkedHiveDriver` (`driver.ts:871`, `:949`) all call `resolveRuntimeRoute()` directly with no fail-open wrapper. A fix scoped only to `SpawnDriver`/`startRun` would leave `MINERVA_DRIVER=subagent`/`forked` and `submitAnswers` (`kickoff-engine.ts:418`, via `driverForRecord()` falling back to the same default driver) exposed to the same failure mode.

---

## Risks

- **Copying `agnostic-plan-driver.ts`'s fail-open pattern verbatim may be the wrong fix for a *live* run.** Planning's fallback path (silently keep using the built-in `claude` driver) is safe because Claude is always a valid, spawnable fallback runtime. `resolveRuntimeRoute()` in `driver.ts` has no equivalently safe fallback documented in the raw material — the Driver contract doc comment (`driver.ts:191-198`) doesn't specify one, and there's no evidence in the codebase of what CLI/model `SpawnDriver` should silently default to if Heimdall is unreachable. A naive fail-open change risks masking a genuine "no runtime is actually available" state as a false success, or spawning against an unintended CLI/model — this needs a real decision, not an assumption. (Echoes the raw findings' third open question.)
- **The existing test `driver-route.test.ts:97-103` explicitly asserts today's throw-through behavior.** Any change to `resolveRuntimeRoute()`'s error handling will need this test consciously rewritten, not just left passing/failing incidentally — a silent regression here would remove the only current signal that Heimdall-failure behavior is intentional and specified.
- **`runTurnResumable()`'s retry scope is type-gated to `TurnTimeoutError` only** (`kickoff-engine.ts:96`). If the fix for "debuggability" or "fail-open" involves introducing a new distinguishable error type for routing failures, it must be deliberate about whether that new type should or should not also flow through the retry path — an accidental widening (or narrowing) here has behavior implications beyond just `startRun`.
- **Orphaned-run cleanup on first-turn failure touches state that's already partially "real"** (a git worktree may already exist via `allocateWorktreeWorkspace`, `run-manager.ts:236-253`). A cleanup fix that transitions the run to `aborted` via the existing `abortRun`/`recordCleanup` path (`cleanup-ledger.ts:59-77`) would be consistent with AD-4 (record + signal, no deletion) — but per the raw findings, the exact desired scope ("mark aborted" vs. "leave for manual `abortRun`" vs. something else) is a real design decision not yet made, and guessing wrong risks either leaving the gap effectively unfixed (still requires a human/external call to `abortRun`) or overreaching into deletion behavior AD-4 explicitly forbids.
- **Fixing the task-type value requires knowing which of Heimdall's three valid values (`planning`/`build`/`review`) actually corresponds to a "kickoff" drive turn** — this is not established in the raw findings or in `driver.ts` itself (the hardcoded value is just the string `"kickoff"`, which isn't even a candidate in Heimdall's allowed list). Guessing wrong (e.g., `build` when `review` was intended, or vice versa) would silently misroute production traffic to the wrong Heimdall-side capacity/eligibility pool rather than fail loudly, which is a worse outcome than today's clear 400.

---

## Open questions

(Carried forward from the raw findings, refined against source-level confirmation gathered in this session.)

1. **What is the correct Heimdall task-type value for `startRun`'s kickoff/drive turn?** Confirmed invalid: `"kickoff"` (not in Heimdall's `["planning","build","review"]`). Not established by any source read in this session: which of the three valid values Heimdall's owners intend for this call site, or whether a fourth value needs to be added Heimdall-side. This needs an answer from Heimdall's API contract/owners, not a guess from Minerva's side.
2. **What should `resolveRuntimeRoute()` do on failure, given it has no obvious safe fallback runtime (unlike planning's "just use claude")?** Is silent fail-open ever correct for a live drive turn, or does the fix need to be "fail fast, but with an honest, unambiguous error" rather than "fail open"? This determines whether the fix looks like `agnostic-plan-driver.ts`'s pattern at all, or is a different shape entirely (e.g., a distinct, correctly-labeled error code instead of a fallback).
3. **What is the intended scope of orphaned-run cleanup on a first-turn failure?** Confirmed: `abortRun`/`recordCleanup` (`cleanup-ledger.ts:59-77`) is the existing mechanism and is AD-4-compliant (record + signal, no deletion) — but whether `startRun` should call it automatically on first-turn failure, what run status a partially-allocated-but-never-driven run should end up in, and whether the worktree that `allocateWorktreeWorkspace` already created should be surfaced differently, are unresolved design decisions, not established by any raw finding or source read.
4. **Is there a design record (ADR or story doc) explaining why `resolveRuntimeRoute()` was deliberately made non-fail-open**, distinct from `resolvePlanningRoute()`? `driver-route.test.ts:97-103` confirms the throw-through behavior is *tested and intentional*, but no comment in `driver.ts` explains *why* the planning and runtime-route lookups diverge in fail-open-ness. This should be checked against `docs/architecture.md` or per-epic story notes before assuming the divergence is a bug rather than a considered choice this epic needs to consciously override.
5. **Should the fix extend to `SubagentDriver` and `ForkedHiveDriver` (both confirmed via source read to share the identical unguarded `resolveRuntimeRoute()` call), or is this epic scoped to `SpawnDriver`/`startRun` only?** The requirement text names `startRun (default SpawnDriver)` specifically; whether the other two drivers are in-scope for this epic or tracked separately is a scoping decision, not a technical unknown.
6. **What new `ErrorCode` (or dispatch-layer distinction) is the intended fix for the `UNKNOWN_METHOD` mislabeling?** `dispatch.ts` already structurally separates "no such method" (lines 60-69) from "handler threw" (lines 71-85); the raw material and this session's read confirm the mechanism but not the intended target shape (new enum value vs. restructured `Response` type vs. something else).

---

## Recommendation (synthesis — not sourced from raw findings; for the planner's judgment only)

The four defects in the requirement are not equally coupled and could plausibly land as separable
stories:

1. **Task-type fix** is the most bounded and least ambiguous of the four *mechanically*, but per Open Question #1 it cannot be done blind — the correct value needs to come from Heimdall's contract, not be guessed from its error message's allowed-list.
2. **Debuggability fix** (a distinct error code/path for "handler threw an internal error" vs. "no such method") looks safely separable from the routing-behavior questions and could ship independently — `dispatch.ts`'s two branches are already structurally distinct (lines 60-69 vs. 71-85), so this is closer to plumbing than design.
3. **Fail-open vs. fail-fast-with-honest-error for `resolveRuntimeRoute()`** is the one item that genuinely needs an architecture decision before implementation (Open Questions #2 and #4) — recommend resolving this explicitly (possibly via a short design note) before writing code, rather than defaulting to "copy `agnostic-plan-driver.ts`," given that pattern's fallback safety property (claude is always valid) doesn't obviously hold for a live drive turn.
4. **Orphaned-run cleanup** has a ready-made, AD-4-compliant mechanism to hook into (`abortRun`/`recordCleanup`) — the remaining work is deciding *when* `startRun` should call it automatically (Open Question #3), which is a small, scoped design decision rather than new infrastructure.

Given `submitAnswers` and the `subagent`/`forked` drivers share the identical unguarded call
(Constraints, Key files table), recommend the planner explicitly decide the scope boundary (Open
Question #5) up front rather than let it surface mid-implementation.
