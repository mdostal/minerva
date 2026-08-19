# Design Discussion: harden-run-id-and-target-repo-boundaries

## 0. Prelude

Source: triage `t-008`, prioritized p3/low. Two informational hardening notes surfaced by the
pre-public-release security review (the same review that found and fixed the Critical
git-clone-injection issue, already shipped in v0.2.0). Neither finding blocks the release; both
were filed to surface at standup rather than get lost. Picked up now as the last item in the
pre-open-source-release backlog sweep.

No PRIOR DECISIONS or NORTH STAR entries found (`.pHive/project-profile.yaml` has no `north_star`
block; no matching `/hive:why` history for this topic).

## 1. Goal

Close two informational-severity gaps in Minerva's ABI trust boundary before they accumulate as
long-standing "known, accepted" debt:

1. **`run_id` format validation** — reject non-UUID `run_id` values at the ABI boundary instead of
   letting an arbitrary string reach a filesystem path join.
2. **`target_repo` allowlist (opt-in)** — give operators of less-trusted deployments a way to
   constrain which local repo paths `startRun` is allowed to target, without changing the default
   (unconstrained) behavior for the common trusted-operator case.

Both are pure hardening — no user-facing behavior changes for any caller already passing a valid
UUID `run_id` or an already-intended `target_repo`.

## 2. Proposed approach

### 2a. `run_id` UUID validation

Add a `isValidRunId(value: unknown): value is string` guard (regex: standard UUID v4 shape,
matching what `randomUUID()` produces) to `src/run-manager.ts` (co-located with `runDir`/
`runRecordPath`, the functions it protects) and call it at every external entry point *before* the
value reaches `run-manager.ts`'s path-join functions:

- `src/dispatch.ts` — the stdin-JSON ABI's per-method routing, for `getRunStatus`, `getQuestions`,
  `submitAnswers`, `getOutput`, `abortRun`.
- `src/mcp-server.ts` — same five tools, at the `CallToolRequestSchema` handler before it forwards
  to `dispatch()`.

Reject with the existing `VALIDATION_FAILED` error code (already the established code for
malformed-input rejection throughout both files — no new error code needed) and a message naming
the offending field, matching the existing style (e.g. `channel` validation in `dispatch.ts`).

**Placement constraint (confirmed by grill round 1, finding H1):** the guard belongs *only* at the
`dispatch.ts`/`mcp-server.ts` ABI boundary — do not push it deeper into `run-manager.ts`'s own
functions. `src/output-emitter.test.ts:536` calls `commitAndPushPlan({ run_id: "x", ... })`
directly, bypassing the ABI boundary entirely, and is a legitimate internal-function test, not a
loophole to close. Validating at the boundary catches every external caller while leaving
internal/test call sites that construct records directly untouched.

### 2b. `target_repo` allowlist

Add an optional `MINERVA_ALLOWED_TARGET_REPOS` env var (comma-separated list of `owner/repo` slugs
and/or absolute local paths — matching the two shapes `target_repo` already accepts per
`src/target-repo-signal.ts`'s `normalizeTargetRepoValue`). When unset (the default), behavior is
unchanged — this preserves the documented, intended "plan against any local repo" behavior for the
common case. When set, `startRun` checks the resolved `target_repo` (slug or local path) against
the list before proceeding to `resolveLocalCheckout`/worktree creation, rejecting with
`VALIDATION_FAILED` on a miss.

Reuse `normalizeTargetRepoValue`'s existing slug/path classification rather than inventing a new
one — the allowlist compares against the same normalized shape the rest of the target-repo pipeline
already uses.

## 3. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| UUID regex is stricter than some legitimate existing caller's `run_id` shape | low | `allocateRun()` is the only producer and always uses `randomUUID()` — verified via research brief; no legitimate non-UUID `run_id` exists anywhere in the codebase or tests. |
| Allowlist env var breaks an existing deployment that relies on unconstrained `target_repo` | none | Opt-in only — absent env var = identical behavior to today. |
| Allowlist slug/path comparison has a subtle normalization mismatch (e.g. trailing slash, `.git` suffix) | low | Reuse `normalizeTargetRepoValue` rather than a new ad-hoc comparison — same normalization the rest of the pipeline already trusts. |

## 4. Dependencies

None external. Both fixes are additive validation in existing, already-tested modules
(`run-manager.ts`, `dispatch.ts`, `mcp-server.ts`, `target-repo-signal.ts`).

## 5. Open questions

1. Should the UUID regex be v4-specific or accept any RFC 4122 UUID version? — **Recommendation:**
   accept any valid UUID shape (all versions), not just v4, in case `randomUUID()`'s output format
   ever changes across Node versions. Validate *shape*, not *provenance*.
2. Should `MINERVA_ALLOWED_TARGET_REPOS` support glob patterns, or exact-match only? —
   **Recommendation:** exact-match only for v1 (matches the "two hardening notes," not "build a
   policy engine" scope t-008 itself set). Globs can be a future triage item if ever needed.

## 6. Scale assessment

**Small.** Two isolated, well-scoped validation additions across 3-4 files, no cross-layer
coordination, no UI, no external dependency, each independently testable and shippable. Design
discussion is sufficient context — no H/V planning or structured outline needed.
