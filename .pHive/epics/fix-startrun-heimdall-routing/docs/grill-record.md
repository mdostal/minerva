# Grill Record — fix-startrun-heimdall-routing

**Source draft:** `.pHive/epics/fix-startrun-heimdall-routing/docs/design-discussion.md`
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass)
**round_number:** 1
**unresolved_count:** 7
**Generated:** 2026-08-14T05:00:00Z

## Summary

- Vocabulary mismatches: 1 finding
- Hidden assumptions: 3 findings
- Unresolved tensions: 2 findings
- Convention violations: 1 finding
- Posture mismatches: clean

## Vocabulary mismatches

- **V1** — "Heimdall" is used throughout as an established, well-known Pantheon routing service, but it does not appear anywhere in `.pHive/CONTEXT.md` — the canonical domain-vocabulary substrate lists exactly four sibling gods (Auriga, Vulcan, Delphi, Multica) and Heimdall is not among them. The draft's own North Star block hedges with "Auriga-style routing" rather than naming Heimdall as Auriga itself, implying Heimdall may be a distinct, unlisted component — but this is never resolved anywhere in the draft.
  - Draft location: line 9 ("Audience: Human operator + other Pantheon services (Auriga-style routing)"); pervasive thereafter (e.g. lines 24-25, 43-52, 85-91, 210-222)
  - Reference: `.pHive/CONTEXT.md` Terminology (Pantheon sibling gods: Auriga, Vulcan, Delphi, Multica — no Heimdall) and Conventions ("v1/v2 split: every god-integration ... is v2, each behind a contract, so it swaps in cleanly once that god exists")
  - Question for planner: Is Heimdall a Pantheon "god" CONTEXT.md hasn't been updated to list, a subsystem/rename of Auriga, or an external/pre-Pantheon service outside the god model entirely — and if it is a god-integration, does the v1/v2 "behind a contract" convention apply to `driver.ts`'s direct `fetch()` calls to it (currently unwrapped, unlike the god-contract pattern CONTEXT.md describes)?

## Hidden assumptions

- **H1** — §3(a)'s case against fail-open assumes "no safe fallback target exists" is equivalent to "no safe fallback target could be defined." It never evaluates an operator-configured fallback route (an explicit `MINERVA_FALLBACK_CLI`/`MINERVA_FALLBACK_MODEL`-style env var, fail-loud if unset) as a middle path between "guess a default" and "fail fast." This pattern already exists in the same file for `MINERVA_TURN_TIMEOUT_MS`/`MINERVA_TURN_RETRY_LIMIT` (fail loudly on bad/absent input, else use the operator's explicit value) — it is not "guessing," which is the specific objection §3(a) raises against fail-open.
  - Draft location: lines 95-105 ("inventing one now would mean guessing a CLI/model pair with zero evidence it's a safe choice")
  - Why this matters: If a config-declared fallback is viable, it decouples the fail-fast/fail-open decision from needing external Heimdall-side confirmation (Open Question 2, lines 231-235) — the answer would live entirely within Minerva's own config surface instead of waiting on an outside party.
  - Question for planner: Was an explicit, operator-declared fallback route considered and rejected, or simply not on the table — and if rejected, what makes it unsafe in a way `claude` isn't for the planning driver's fallback?

- **H2** — §3(d) proposes automatically transitioning a first-turn-failed run to `aborted` (no human confirmation) but never checks this against AD-5's specific language ("stall... unbounded by design — never times out into a guessed or default answer") or the "never guess" ethos the draft itself invokes elsewhere (lines 80-83, citing `MINERVA_DRIVER`/`MINERVA_TURN_TIMEOUT_MS`/`MINERVA_TURN_RETRY_LIMIT` as house style). The draft treats "orphan" (first-turn infra failure, never reached a question) as self-evidently distinct from "stall" (successfully reached `waiting_on_human`, AD-5-governed) but never states that distinction explicitly or cites AD-5 to preempt the natural objection.
  - Draft location: lines 146-157 (§3d)
  - Why this matters: A reviewer steeped in AD-5's "never auto-resolve" framing could reasonably read auto-abort-on-failure as the same category of automatic, un-human-confirmed state transition AD-5 exists to prevent, and push back on §3(d) as written.
  - Question for planner: Should the design explicitly distinguish "orphan" from "stall" and cite AD-5 directly, stating why auto-abort-on-first-turn-failure is not the kind of auto-resolution AD-5 forbids?

- **H3** — §8's Scale Assessment asserts "Medium" by elimination ("Not Small... Not Large...") without weighing the task-type external dependency — which §5/§8 itself calls "a hard blocker on truly finishing the mechanical portion of the fix with confidence" — against the sizing framework. A genuinely blocking external unknown is a distinct scope-class dimension (can this be fully scoped/estimated right now at all?) that Small/Medium/Large doesn't capture on its own; the draft's hedge ("tracked as a story-blocking question rather than guessed around," line 288) softens but doesn't resolve this.
  - Draft location: lines 210-222 (§5 external-dependency framing), lines 282-288 (§8 Scale Assessment / Recommendation)
  - Why this matters: If the task-type answer is slow to arrive, the epic's "Medium" sizing and story sequencing (§8: "(a)'s decision lands before (b)/(c)/(d)'s implementation") could stall on an external dependency the Scale Assessment doesn't explicitly flag as a sizing risk, only as a tracked blocker.
  - Question for planner: Should the Scale Assessment state explicitly that "Medium" assumes the task-type answer arrives on a timeline compatible with story sequencing, and what happens to sizing if it doesn't?

## Unresolved tensions

- **U1** — The draft is inconsistent about whether §3(a)'s fail-fast-with-typed-error call is a locked decision or a proposal still gated on external confirmation. §3(a) itself is framed as "my recommendation" (argued at length); §8 calls it "genuine architectural judgment... the crux of the whole epic" needing "deliberate resolution"; §6 Open Question 2 reopens it pending confirmation of whether an undocumented safe fallback exists; but §7's Verification Plan already writes test changes "per the §3(a) decision" as if it were settled.
  - Draft location: lines 95-116 (§3a, "my recommendation"), lines 231-235 (§6 Q2, framed as open), lines 264-266 (§7, "per the §3(a) decision"), lines 282-284 (§8, "needs deliberate resolution")
  - Tension: Is §3(a) a decision this design-discussion is locking in, or a recommendation still contingent on Open Question 2's external check before implementation may proceed?
  - Question for planner: State explicitly whether Open Question 2 is a pre-implementation gate or a lower-priority sanity check that doesn't block starting on §3(a) as written.

- **U2** — §3(b)'s "fix at the root... covers all of them for free" argument treats the scope decision (all 3 drivers + `submitAnswers`) as low-risk and independent of which way §3(a) resolves. But a root-scoped fix has categorically different blast radius depending on §3(a)'s outcome: fail-fast-at-the-root only changes error *classification* everywhere (low behavioral risk); fail-open-at-the-root would propagate the exact "masking 'no runtime available' as false success" failure mode §4 already flags as High — simultaneously across every driver and `submitAnswers`, not just `SpawnDriver`. The draft never states that §3(b)'s scope recommendation is contingent on §3(a) landing on fail-fast, even though §6 Q2 leaves that door open.
  - Draft location: lines 118-132 (§3b), cf. lines 161-166 (§4 High risk item), lines 231-235 (§6 Q2)
  - Tension: §3(b) argues root-scoping is safe/self-evidently correct on its own merits, but that safety property is actually inherited from §3(a)'s fail-fast conclusion, not independent of it.
  - Question for planner: Should §3(b) explicitly state that root-scoping is safe *because* the underlying fix is fail-fast — and that this scope call would need to be re-examined if §3(a) is ever revisited toward fail-open?

## Convention violations

- **C1** — §3(d)'s proposal to have `startRun()` automatically invoke `abortRun()`/`recordCleanup()` internally on first-turn failure is not reconciled against `docs/architecture.md`'s own framing of `abortRun` as an "Explicit cleanup trigger" in its API Contract table, or against the codebase's stated "No Autonomous Progress" principle ("nothing polls or advances a run on its own... No component in this architecture should be built to expect, or wait for, autonomous movement between calls"). The draft checks AD-4 compliance (record + signal, no deletion) but never checks whether internally auto-invoking the cleanup mechanism — rather than requiring an external caller to explicitly call the `abortRun` ABI method, as the API contract table's wording implies — is itself a deviation from this codebase's otherwise-strict "explicit trigger, never silent/automatic" posture (the same posture that makes `submitAnswers` "the only method that advances a run").
  - Draft location: lines 146-157 (§3d)
  - Convention: `docs/architecture.md` lines 36-42 ("No Autonomous Progress") and line 200 (API Contract table: `abortRun` — "Explicit cleanup trigger — see AD-4")
  - Question for planner: Is auto-invoking cleanup on first-turn failure a sanctioned exception to "Explicit cleanup trigger" / "No Autonomous Progress" (on the theory that terminating a run that never successfully started is not "advancing" or "progress"), and should that reasoning be stated explicitly in the epic rather than left implicit?

## Posture mismatches

Clean — no findings. The draft stays within Minerva's "only plans, never executes/routes/provisions" and "harness/UI-agnostic" posture; nothing proposed reaches outside Minerva's own run-lifecycle bookkeeping into execution, routing, or provisioning territory.

## Notes

- **Source-code cross-check (requested verification): all four defects and the core "same unguarded function, same call shape" claim hold up exactly as stated.** Direct read of `src/driver.ts` confirms `SpawnDriver.runTurn()` (line 595), `SubagentDriver.runTurn()` (line 670), and `ForkedHiveDriver`'s `dispatchFresh()` (line 871) and `classify()` (line 949) all call the identical unguarded `resolveRuntimeRoute()` with no try/catch between it and the caller. `dispatch.ts:78-84`'s catch-all, `errors.ts`'s closed 5-value `ErrorCode` union, `kickoff-engine.ts`'s unwrapped `runTurnResumable()` call at `startRun()` (matching the draft's cited line numbers), `run-manager.ts`'s `allocateRun()` writing `status: "in_progress"` before any turn is attempted, and `cleanup-ledger.ts`'s idempotent, record-and-signal-only `abortRun`/`recordCleanup` were all confirmed to match the draft's citations. `agnostic-plan-driver.ts`'s `resolvePlanningRoute()` is confirmed genuinely fail-open (try/catch returning `null` on any doubt) and structurally distinct from `resolveRuntimeRoute()`'s exposure — the draft's argument that the "claude fallback" safety property doesn't transfer (because it's a fallback to a *different driver class* upstream of runtime routing, not a fallback *within* `resolveRuntimeRoute()` itself) is technically sound.
- **Stress-test on smuggled assumptions (requested verification): clean.** §3(a)-(d) and §7/§8 were checked for any place that quietly assumes a specific Heimdall task-type value (e.g. `build`) despite Open Question 1 flagging it as unconfirmed. No such leak was found — every section that could plausibly need a task-type value either avoids naming one or explicitly labels it a guess (§6 Q1). This is a genuine strength of the draft, not a gap.
- The draft's own §2 ("Two things I want to flag before anyone reaches for the obvious fix") and §4 risk framing already anticipate and partially defend against several of this pass's angles (notably the fail-open temptation and the existing test's intentionality) — this pass's findings sharpen rather than contradict that self-awareness.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize findings. Each finding ends with a question for the planner; the planner's job is to revise the draft (or document accepted deviations) before stories are written.
