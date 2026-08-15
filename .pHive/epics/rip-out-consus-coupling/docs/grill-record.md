# Grill Record — rip-out-consus-coupling

**Source draft:** `.pHive/epics/rip-out-consus-coupling/docs/design-discussion.md`
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass)
**round_number:** 1
**unresolved_count:** 3
**Generated:** 2026-08-14T15:00:00Z

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 2 findings
- Unresolved tensions: 1 finding
- Convention violations: clean
- Posture mismatches: not applicable

## Vocabulary mismatches

Checked the draft's key terms (`god`, `standalone`, `core ABI` vs. `core operation` vs. `AD-1 external surface`, `decision surface`, v1/v2 split) against `.pHive/CONTEXT.md`'s Terminology and Conventions sections and against the draft's own internal usage. No contradictions found — the draft's use of "core ABI" (dispatch.ts's registered methods) and "AD-1's core surface" (bin/minerva.ts's CLI) tracks the actual distinction in `docs/architecture.md`, and the draft's v1/v2 framing matches CONTEXT.md's "every god-integration ... is v2 ... v1 is standalone" verbatim. Clean.

## Hidden assumptions

- **H1** — Draft states `dispatch.ts` registers its four Consus ABI methods "alongside the seven provider-neutral ones," but the actual handler map (`src/dispatch.ts` lines 27–40) registers **eight** provider-neutral methods: `capabilities, startRun, getRunStatus, listRuns, getQuestions, submitAnswers, getOutput, abortRun`. This is a miscount inherited verbatim from the research brief (`research-brief.md` line 37 has the identical "7... (capabilities, startRun, getRunStatus, listRuns, getQuestions, submitAnswers, getOutput, abortRun)" — that list itself has 8 items), not introduced fresh by the draft, but the draft repeats it without independently checking the source.
  - Draft location: line 70 ("alongside the seven provider-neutral ones")
  - Why this matters: doesn't change any conclusion (dispatch.ts still ends up with 8 methods after the Consus 4 are removed either way), but it's a verifiable, easily-checked factual claim that's wrong, and grill's job includes catching exactly this class of un-verified inherited error before it propagates into a story acceptance criterion (e.g., a story that says "verify dispatch.ts's handler map has exactly 7 entries post-rip-out" would be wrong).
  - Question for planner: correct "seven" to "eight" in the design-discussion (and note the research brief has the same error, since design-discussion is downstream of it) before this count shows up in a story's verification checklist.

- **H2** — §3(d)/§4 treat "remove `pollConsusForAnswers` from `PlanRequest`" as a durable compile-time forcing function that will always catch a stale call site. I verified this empirically (reproduced the exact call shape from `bin/minerva-plan.ts` lines 147–152 against a trimmed `PlanRequest` missing the field, via `tsc --noEmit --strict`): TypeScript's excess-property check **does** fire today (`TS2353: Object literal may only specify known properties, and 'pollConsusForAnswers' does not exist in type 'PlanRequest'`), because the call passes a fresh object literal directly as the argument. But this guarantee is contingent on that specific code shape — it only holds because the call site writes `pollConsusForAnswers: true` directly inside the object literal argument, not through an intermediate variable. `bin/minerva-plan.ts` already assigns other request-shaping values to local variables before use elsewhere in the same function (e.g. `targetRepoPath`, `declaredTarget`); a routine future refactor that builds the `runHeadlessPlan` argument through a variable first would silently defeat excess-property checking and turn the "loud, fine" failure mode described in §4 into the "quiet, bad" one — with no compiler signal that the forcing function had stopped working.
  - Draft location: lines 187–195 (§3(d): "I'd rather it fail to compile... that's a feature of doing (b) this way, not a side effect to work around") and lines 235–239 (§4 High risk item)
  - Why this matters: the draft leans on this mechanism as the primary mitigation for the epic's own top-flagged risk ("the sharpest edge in this whole epic"). If the mechanism's fragility isn't documented, a future refactor could quietly reintroduce exactly the silent-no-op failure §4 is trying to rule out, with nobody aware the safety net is gone.
  - Question for planner: worth a one-line comment at the `runHeadlessPlan({...})` call site (or a dedicated regression test asserting the literal-argument shape, e.g. via a type-level test) noting that the object literal must stay inline for the excess-property check to keep functioning as the intended forcing function? Or is verified-today-good-enough sufficient given this is a one-off rip-out, not an ongoing invariant to protect?

## Unresolved tensions

- **U1** — §3(d) resolves "do the standalone binaries count as core" by drawing the line at `dispatch.ts` import membership ("Neither binary is required for core operation... neither sits on any core ABI path"), and applies that same reasoning symmetrically to both `bin/minerva-plan.ts` and `bin/ideate-to-consus.mjs`. But the operator's own words (quoted directly in the draft, sourced in `triage/queue.yaml` t-002) are purpose-oriented, not import-graph-oriented: "if it requires all of the others to do anything, then it is a process piece or a flag in the pantheon itself." Read that way, the two binaries are not equivalent. `bin/minerva-plan.ts`'s core function (plan an idea into an epic+stories) works with zero Consus/Multica involvement once (b)/(d) land — Multica filing is opt-in via `--file-to-multica`. `bin/ideate-to-consus.mjs`, by contrast, is documented in its own header as existing specifically to "FILE them into CONSUS as a decision item" and "WAIT for the human to answer" via Consus/Janus — its own docstring calls it "the MISSING HALF of the Pantheon ideation loop (VISION.md, Consus)." Its documented purpose cannot complete without a live Consus/Janus round-trip on the other end; it "does anything" (in the operator's phrasing) only in concert with a sibling god. That is a materially stronger claim to being "a process piece... in the pantheon itself" than `bin/minerva-plan.ts`'s case, and the draft's carve-out doesn't distinguish between the two on this axis — it treats "not imported by dispatch.ts" as sufficient by itself, without engaging the more literal, purpose-based reading the operator's own sentence supports. (The counter-argument the draft could make — that "full rip it out and apart" is glossed by the operator's own immediate follow-up, "my real question, what is left of Minerva at the end," which is capability-framed rather than grep-for-zero-lines framed — is a real, available defense, but the draft doesn't make it explicitly for this specific distinction.)
  - Draft location: lines 174–186 (§3(d)) and lines 96–105 (§2, describing `ideate-to-consus.mjs`'s Janus-broker pattern as "worth noting as a pattern")
  - Tension: "no sibling-god coupling required for core operation" (draft's own §0 framing) vs. keeping a tool in-repo whose entire documented reason to exist is a one-way pipe into a sibling god's decision surface.
  - Question for planner: does the operator's "process piece or a flag in the pantheon itself" test apply per-binary based on whether the binary's own *purpose* depends on another god (favoring excising or relocating `ideate-to-consus.mjs`, e.g. into Consus/Janus's own repo), or does it apply only at the `dispatch.ts`/core-ABI boundary (favoring the draft's as-written carve-out, keeping both binaries)? If the planner accepts the draft's boundary, it's worth stating explicitly in the design doc *why* `ideate-to-consus.mjs`'s Consus-dependent purpose doesn't trip the operator's test, rather than resting on the same "not imported by dispatch.ts" reasoning used for `bin/minerva-plan.ts`.

## Convention violations

Checked `.pHive/CONTEXT.md`'s Conventions section (branching, TS/TDD discipline, local-CI-only, v1/v2 split, "never auto-approve/execute/route/provision") and `.pHive/cross-cutting-concerns.yaml`'s "Documentation Updates" concern (triggers when a story "modifies workflows, schemas, directory structure, configuration files, or adds/removes/renames reference documents" — squarely applicable to this epic). `.pHive/team-memories/` and `.pHive/insights/` are both empty (no feedback memos to check against). The draft's §3(f) directly satisfies the documentation cross-cutting concern (identifies `docs/architecture.md` and `docs/minerva-dev-agent-instructions.md` as must-fix, with explicit reasoning for what's left alone). No violations found. Clean.

## Posture mismatches

The grill skill's posture category is scoped to Hive's own stated posture (composable substrate, atomic skills, etc.), which isn't directly implicated by a target-repo product/engineering design doc like this one. The closest analog — whether §3(d)'s carve-out departs from Minerva's own "genuinely standalone" architectural posture — is already captured and argued honestly under Unresolved tensions (U1) rather than being a silent, unjustified departure, so it doesn't fit this category's definition ("without explicit justification"). Not applicable.

## Notes

Verification performed against live source (per this pass's brief) beyond the two categories above, all confirmed accurate as stated in the draft:

- `src/kickoff-engine.ts` `recordTurn()` (lines 151–192): confirmed the call to `postQuestionToConsusDecisionApi()` at line 180 is genuinely unconditional — no flag, no env check, no gate anywhere in the call path between `updateRunRecord` (line 175) and the `await` at line 180. The status flip to `"awaiting-consus"` at line 182 fires unconditionally on any truthy `posted.posted`.
- `bin/minerva-plan.ts` line 150 confirmed to hardcode `pollConsusForAnswers: true` with no opt-out, and `src/plan-runner.ts` lines 28–34 confirmed `pollConsusForAnswers?: boolean` is a real field on `PlanRequest`. `runHeadlessPlan` (grepped repo-wide) is called from exactly one production, non-test call site (`bin/minerva-plan.ts`) plus test files — no other production caller exists that could route around the excess-property check via a differently-typed object, which strengthens (without fully future-proofing, see H2) the draft's forcing-function argument.
- `docs/product-brief.md` line 56 and `docs/initial-info.md` lines 9, 142, 158 checked directly: the "zero dependency on Delphi/Auriga/Vulcan/Multica/votem existing" v1 requirement is quoted/paraphrased accurately, not stretched. `docs/product-brief.md:56` reads verbatim "Standalone operation — no dependency on Delphi, Auriga, Vulcan, Multica, or votem existing."
- §7's live-PoC step 10 ("confirm status stays `waiting_on_human`, never `awaiting-consus`, even with a real Consus service reachable") remains fully expressible even after §3(a) deletes `"awaiting-consus"` from the `RunStatus` type entirely. This is a live/manual PoC observing the actual JSON-over-stdio wire response, not a TypeScript-level assertion — and even `getRunStatus`'s own signature (`src/run-manager.ts` line 332) returns `Record<string, unknown>`, already untyped at that boundary. A raw string comparison against `"awaiting-consus"` needs no type-level literal to exist; the operator (or a lightweight script) can observe the wire value directly regardless of what the internal `RunStatus` union currently contains. No finding here — the verification design holds up.
- `docs/architecture.md` doc/code drift claims (line 197's `getRunStatus` status enum omitting `awaiting-consus`; lines 201–202 documenting `pollConsusAnswers`/`pollAndResumeConsusAnswers` with full signatures) confirmed accurate.
- `docs/minerva-dev-agent-instructions.md` confirmed to open with `--file-to-multica` as its first usage example (line 8) and to describe filing to Multica as a mandatory durability step (line 25) — consistent with the draft's characterization of it as a live, Multica-centric instruction set that must stay in sync with §3(c).
- `src/consus-poller.ts` line 14 confirmed to import `extractAnswerFromItem` from `./consus-resume.ts` — the deletion-order dependency the draft flags in §3(a)/§5 is real.

## Out of scope (this pass)

Grill does not propose solutions, score quality, gate work, or prioritize findings. Each finding above ends with a question for the planner; the planner's job is to revise the draft (or document accepted deviations) before stories are written.
