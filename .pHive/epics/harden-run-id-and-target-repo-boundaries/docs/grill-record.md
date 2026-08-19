# Grill Record — harden-run-id-and-target-repo-boundaries

**Source draft:** .pHive/epics/harden-run-id-and-target-repo-boundaries/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass — research brief predates this story's `inconsistency_risk_signals` wiring)
**round_number:** 2
**unresolved_count:** 1
**Generated:** 2026-08-19T23:45:00Z

> Round 2 runs post-implementation, ahead of shipping — the "draft" being checked is now the
> design discussion cross-referenced against the actual merged code (`src/kickoff-engine.ts`,
> `src/run-manager.ts`, `src/target-repo-signal.ts`), not just the prose. Round 1's finding (H1)
> stays resolved; round 1's record is preserved as history below round 2's findings.

## Round 2 summary

- Vocabulary mismatches: clean
- Hidden assumptions: 1 new finding (H2)
- Unresolved tensions: clean
- Convention violations: clean
- Posture mismatches: clean

## Round 2 — Hidden assumptions

- **H2** — §2b / §3's Risk table only considers normalization mismatches on the *target_repo side*
  of the allowlist comparison ("Allowlist slug/path comparison has a subtle normalization
  mismatch... mitigation: reuse normalizeTargetRepoValue"). It doesn't examine the cost/side-effect
  of normalizing the *allowlist entries themselves*.
  - Code location: `src/kickoff-engine.ts:108-118` (`isTargetRepoAllowed`), calling
    `normalizeTargetRepoValue(entry)` for `entry` = configured allowlist item.
  - Why this matters: `normalizeTargetRepoValue()`'s local-path branch
    (`src/target-repo-signal.ts:57-72`) does a real synchronous `execFileSync("git", ["-C",
    localPath, "remote", "get-url", "origin"], ...)` subprocess call. When an operator configures
    `MINERVA_ALLOWED_TARGET_REPOS` with a mix of slugs and local-path entries, every `startRun`
    call whose `target_repo` doesn't exact-string-match a given entry will shell out to `git` for
    *each* local-path entry in the list, just to see whether it also happens to resolve to a
    matching slug — real subprocess cost (mostly harmless — `stdio: ["ignore","pipe","ignore"]`,
    caught failure), but also makes the allowlist check's outcome depend on live filesystem/git
    state of *other* configured paths (does that local repo still exist, still have an `origin`
    remote, etc.) that has nothing to do with the actual `target_repo` being validated on this
    call. Purely a v1 efficiency/hygiene note, not a security or correctness defect — the exact
    trimmed-string match on line 113 already covers the common local-path case with zero
    subprocess cost, so this only fires on the *miss* path, and a miss correctly still rejects.
  - Question for planner: worth a follow-up story to skip the slug-derivation branch entirely for
    entries that are clearly local paths (e.g. start with `/` or `~`), since exact-string match is
    the only mechanism the design ever intended for local-path allowlist entries per §2b/design
    decision "reuse normalizeTargetRepoValue... do not invent a new comparison shape" — this
    wasn't envisioned as also meaning "derive filesystem-dependent slugs from path entries."
    Filed as triage t-011 (informational, not blocking — matches this epic's own severity posture)
    rather than reopening the shipped stories.

---

## Round 1 (2026-08-19T03:00:00Z) — preserved for history

**round_number:** 1
**unresolved_count (at time of round 1):** 1

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 1 finding
- Unresolved tensions: clean
- Convention violations: clean
- Posture mismatches: clean

## Vocabulary mismatches

No findings. Draft terminology (`run_id`, `target_repo`, `ABI boundary`, `driving agent`) matches CONTEXT.md's Terminology section throughout.

## Hidden assumptions

- **H1** — §3 Risks table claims "no legitimate non-UUID `run_id` exists anywhere in the codebase or tests," citing the research brief, but the research brief only checked `allocateRun()`'s production path — it does not claim to have checked test fixtures for internal-function calls that bypass the ABI boundary entirely.
  - Draft location: §3 Risks table, row 1 ("UUID regex is stricter than some legitimate existing caller's `run_id` shape")
  - Why this matters: verified independently (`grep -rn 'run_id:\s*["\'][a-z-]*["\']' src/*.test.ts`) — `src/output-emitter.test.ts:536` calls `commitAndPushPlan({ run_id: "x", ... })` directly with a non-UUID literal. If the UUID guard were placed inside `run-manager.ts` itself (rather than only at the `dispatch.ts`/`mcp-server.ts` ABI boundary, as §2a currently proposes), this test would break. The draft's boundary-only placement happens to avoid this — but the draft doesn't say so explicitly, and a reasonable implementer skimming §2a alone might not realize placing the check one layer deeper is unsafe.
  - Question for planner: make the boundary-only placement an explicit, stated constraint (not just an implementation detail) so the developer/reviewer steps don't "helpfully" push the validation deeper into `run-manager.ts` during implementation.

## Unresolved tensions

No findings.

## Convention violations

No findings against the draft itself.

## Posture mismatches

No findings. Both fixes are validation-only (reject malformed input) — consistent with CONTEXT.md's "never let Minerva execute, route, or provision — it only plans" posture, and the `target_repo` allowlist stays opt-in, preserving the documented v1 "plan against any local repo" behavior by default.

## Notes

Not a finding against this draft, but surfaced during the CONTEXT.md substrate read: `.pHive/CONTEXT.md:47` ("Local CI only — no GitHub Actions") is itself stale — `.github/workflows/ci.yml`/`promote.yml` are real and active (added earlier in this same release cycle; README.md and VISION.md's matching claims were already corrected). Out of this epic's scope to fix (CONTEXT.md isn't touched by either of t-008's two findings), but worth a follow-up triage entry so the substrate document doesn't keep misleading future grill passes.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize findings. H1 ends with a question for the planner; the planner's job is to revise the draft (or document an accepted deviation) before stories are written.
