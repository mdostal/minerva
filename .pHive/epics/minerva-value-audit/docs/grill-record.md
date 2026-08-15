# Grill Record — minerva-value-audit

**Source draft:** /Users/mdostal/Documents/work/pantheon/minerva/.pHive/epics/minerva-value-audit/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass)
**round_number:** 1
**unresolved_count:** 11
**Generated:** 2026-08-14T00:00:00Z

## Summary

- Vocabulary mismatches: 2 findings
- Hidden assumptions: 5 findings
- Unresolved tensions: 2 findings
- Convention violations: 1 finding
- Posture mismatches: 1 finding

## Vocabulary mismatches

- **V1** — Draft's core differentiation argument is built on an "ABI" (`startRun`/`getRunStatus`/`submitAnswers`, §3) that is never anchored to CONTEXT.md's canonical term "Pantheon subprocess ABI" (the JSON-over-stdio `{method, params}` → `{result}`/`{error}` contract, originally defined in plugin-hive's `task-tracking-adapter-abi.md`, reused directly per AD-1). The draft also separately discusses PR #341's file-based question-envelope format (`.pHive/questions/<skill>-<invocation-id>.yaml`) and proposes Minerva "adopt its envelope format" (line 144-146) without ever clarifying whether that file-envelope layer is part of, or distinct from, the RPC-level Pantheon subprocess ABI that CONTEXT.md says Minerva already reuses per AD-1.
  - Draft location: line 111-113 ("Minerva's own description is a `startRun`/`getRunStatus`/`submitAnswers` ABI"); line 144-146 ("adopt its envelope format... rather than maintain a hand-rolled parallel format")
  - Reference: `.pHive/CONTEXT.md` — "Pantheon subprocess ABI" entry and AD-1
  - Question for planner: Is the draft's "ABI" the same artifact as CONTEXT.md's "Pantheon subprocess ABI," and is the question-envelope format a sub-layer of it or a separate concern? The recommendation to "adopt #341's envelope format" can't be evaluated against AD-1 until this is resolved — should the design-discussion revision name the relationship explicitly?

- **V2** — CONTEXT.md defines "driving agent" as the specific term for the agent that programmatically operates a Minerva run (starts it, answers agent-channel questions, polls status — v1's async mechanism). The draft never uses this term even though its entire premise is about who/what drives Hive headlessly — it substitutes "external harness," "orchestrator," "actor," and "Auriga-style router" interchangeably (§1 line 27-28, §2 line 49, §3 lines 130-139) without ever mapping these back to the CONTEXT.md-defined role.
  - Draft location: line 27-28 ("an external harness — a scheduler, another LLM, a CI job, Auriga — drive Hive"); line 130-133 ("one of the four actors")
  - Reference: `.pHive/CONTEXT.md` — "driving agent" entry
  - Question for planner: Should the revision consistently use "driving agent" where the draft currently uses "harness"/"actor"/"orchestrator," or is the draft deliberately using a broader vocabulary because some of these (e.g., a scheduler, Auriga) are not literally the v1 "driving agent" role? If deliberate, that distinction should be stated, not implied.

## Hidden assumptions

- **H1** — §3's claim that the native `pause` node is "precisely the constraint Minerva exists to route around" (because of its 30-day live-process-blocking ceiling) is asserted without citing the one piece of CONTEXT.md grounding that would make it airtight: AD-5's definition of "stall" as "unbounded by design — never times out into a guessed or default answer." The draft has the evidence sitting in its own substrate and doesn't cite it.
  - Draft location: line 116-118 ("it needs a live process blocking for up to 30 days, which is precisely the constraint Minerva exists to route around")
  - Why this matters: Without the explicit AD-5 citation, this reads as an architectural preference rather than a documented design decision — a reviewer unfamiliar with AD-5 could read it as opinion, weakening the single cleanest piece of evidence for "don't absorb the pause node."
  - Question for planner: Should the revision cite AD-5 directly here to convert this from asserted opinion into grounded fact?

- **H2** — §2 (line 94-95) concludes the agnostic-plan-driver fallback bug is "proven working in production," generalizing from a single verified invocation (`PAN-8604`) on a single host ("hive") to a "materially different risk posture." §7's own verification plan (line 250-252) admits no other production host has actually been checked. One successful run on one host is evidence the fix works, not evidence the fix is reliably reachable in production generally — the draft's own §4 downgraded-but-not-eliminated risk (line 158-166) implicitly concedes this, but the confident "proven... in production" framing three sections earlier isn't calibrated to that same caveat.
  - Draft location: line 94-95 ("the mechanism itself is proven working in production elsewhere, which is a materially different risk posture")
  - Why this matters: If a second production host also uses a non-standard checkout name, the "proven in production" framing set up in §2 will have oversold the fix's coverage before §4/§7's caveats are reached.
  - Question for planner: Should §2's language be softened to "verified working on at least one production host" rather than "proven working in production," to match §4/§7's more careful framing?

- **H3** — §3 (line 122-126) states `ForkedHiveDriver` was "built and validated entirely independent of any of plugin-hive's three efforts." But §2 (line 99-101) describes `ForkedHiveDriver.dispatchFresh()` as spawning "any runtime via `resolveRuntimeRoute()`/an adapter pattern" — and the draft never establishes whether `resolveRuntimeRoute()` shares code, design, or a dependency with the fork's runner-agnostic dispatch work (fork PRs #3/#6/#11/#12) that §2 (line 57-63) describes at length as covering exactly "which runner executes a step." If `resolveRuntimeRoute()` is unrelated to that fork work, the independence claim needs a sentence saying so explicitly; if it isn't unrelated, "entirely independent" is overstated.
  - Draft location: line 99-101 ("spawns *any* runtime via `resolveRuntimeRoute()`/an adapter pattern (not hardcoded to claude)"); line 125 ("built and validated entirely independent of any of plugin-hive's three efforts")
  - Why this matters: This is the single sentence carrying the most rhetorical weight in the "stronger position" claim (§3, §8 RATIONALE) — if the independence claim doesn't hold, the "materially stronger position" conclusion in §3/§8 loses its strongest support.
  - Question for planner: Does `resolveRuntimeRoute()` depend on any of the three plugin-hive efforts (in particular the fork dispatch work)? This should be confirmed and stated explicitly before the "entirely independent" claim is relied on for the epic's headline recommendation.

- **H4** — §2 (line 105) hedges that "a spike apparently confirmed re-issuing the original prompt... is what makes the skill re-check its own on-disk state" — "apparently confirmed" signals soft, secondhand evidence. §3 (line 123) then treats the same driver as unqualified "proof that the design works as claimed." A hedged spike result and an unqualified "proof" claim about the same mechanism, three paragraphs apart, aren't calibrated to each other.
  - Draft location: line 105 ("a spike apparently confirmed re-issuing the original prompt"); line 123 ("`ForkedHiveDriver` is proof that the design works as claimed")
  - Why this matters: "Proof" is the load-bearing word for the epic's central "stronger position" claim (§3, §8); if the underlying evidence is itself hedged as "apparently confirmed," the word "proof" overclaims relative to its own citation.
  - Question for planner: Should "proof" be softened to something like "strong evidence," or should the spike result be re-verified (not just cited as "apparently confirmed") before the draft leans on it this heavily?

- **H5** — The entire epic is framed around pause/resume and "question-extraction" (§0), and CONTEXT.md defines this domain precisely: questions split into an agent channel and a human channel, with escalation (routing strategic/ambiguous/irreversible/low-confidence questions to the human channel) judged inline by the planning persona, not by a keyword rule (AD-2). The draft never examines whether PR #341's `question_gateway` batching or `ForkedHiveDriver`'s `surfaceNextQuestion()` implement or preserve this two-channel escalation model at all — it treats "question extraction" as a single undifferentiated capability throughout §2-§3.
  - Draft location: line 48-51 (`question_gateway` "batches all questions at a phase boundary" — no mention of channel split); line 102-103 (`surfaceNextQuestion()` "extracts and classifies the next unanswered question" — classifies how, and against what channel model?)
  - Why this matters: If PR #341 or `ForkedHiveDriver` don't replicate the agent/human channel split and AD-2's escalation judgment, that's a concrete, citable differentiator for Minerva that the draft is leaving on the table. If they do replicate it, that's a convergence risk the draft hasn't flagged. Either way, this is unexamined territory in a document whose whole subject is question/pause handling.
  - Question for planner: Should the draft (or a follow-on research pass) determine whether PR #341's and `ForkedHiveDriver`'s question-handling implement anything resembling the agent/human channel split and AD-2 escalation logic, before finalizing the "Minerva's real differentiator" claim in §3?

## Unresolved tensions

- **U1** — §5's correction (line 193-198) explicitly states fork PR #10 (dev-to-main promotion) is "weaker than originally stated" and "not, as previously stated, the single blocker standing between Minerva and a working agnostic-plan path," because `PAN-7734`'s fix resolves the `plugin-hive-fork-dev` candidate directly, independent of whether `dev` has been promoted to the fork's own `main`. Yet §3's concrete recommendation #4 (line 147-150) still says to "treat the fork's `dev`-to-`main` promotion (fork PR #10) as a **hard precondition** for any 'runner-agnostic' claim" — the identical phrase the §5 correction is explicitly walking back — and §4's fourth risk item (line 178-180) still describes PR #10 as "the one thing currently blocking Minerva's own dependency from resolving at all." These three passages were not reconciled after the correction.
  - Draft location: lines 147-150 (§3), lines 178-180 (§4), lines 193-198 (§5)
  - Tension: §5 says PR #10 is *not* the hard/single blocker (superseded by PAN-7734); §3 and §4 still assert that it is, in language that reads as a leftover from the pre-correction draft.
  - Question for planner: Which framing is correct post-correction? §3's recommendation #4 and §4's fourth risk item need to be rewritten to match §5's corrected dependency analysis (PR #10 matters for upstream visibility, not as a blocker on the working path) before this draft is internally consistent.

- **U2** — §8's RECOMMENDATION states "the core decision is answerable from this document" and that follow-on work "doesn't touch architecture" (line 278-279). But §6's Open Question 1 (line 216-219) says the answer to whether `plan-agnostic.mjs` "actually substitute[s] for Minerva's own kickoff/plan question-and-answer loop end-to-end... materially changes how much of Minerva's plan-flow logic could ever be delegated to it" — i.e., an open, unanswered question that the draft itself says could materially change Minerva's plan-flow architecture. §7 (line 256) confirms the relevant source (`adapters.mjs`/`plan-agnostic.mjs`) has not actually been read yet.
  - Draft location: line 278-279 (§8, "doesn't touch architecture"); line 216-219 (§6 Open Question 1); line 256 (§7, source "not yet read")
  - Tension: The scale/recommendation section asserts no architectural exposure while an unresolved, unread-source open question in the same document could change exactly that.
  - Question for planner: Should §8's "doesn't touch architecture" claim be qualified pending Open Question 1's resolution, or is the planner confident enough that reading `adapters.mjs`/`plan-agnostic.mjs` won't surface an architectural dependency to let "Proceed to stories" stand unconditionally?

## Convention violations

- **C1** — CONTEXT.md's conventions section states every god-integration (Delphi, Auriga, Vulcan, Multica, votem) is v2, "each behind a contract, so it swaps in cleanly once that god exists," and that "v1 is standalone." §3's strongest positioning claim — "Minerva's real differentiator... is that it's the stable seam other Pantheon services integrate against" and "an Auriga-style router shouldn't need to know or care which of those three plugin-hive subsystems is live... it should just call Minerva's ABI" (line 135-139) — presents this Auriga-integration value as a present-tense differentiator without acknowledging that per CONTEXT.md's own convention, this integration is explicitly v2 scope, gated behind a contract that doesn't exist yet, while the current epic and Minerva's current implementation are v1/standalone.
  - Draft location: line 135-139
  - Convention: `.pHive/CONTEXT.md` — Conventions section, "v1/v2 split" entry
  - Question for planner: Should §3's differentiator claim be reframed as a v2-scope aspiration (consistent with CONTEXT.md's convention) rather than a present-tense capability, to avoid implying Minerva already serves this integration role in v1?

## Posture mismatches

- **P1** — CONTEXT.md states plainly: "Never auto-approve; never let Minerva execute, route, or provision — it only plans." §3's framing of "force the usage of the plugin hive... across the board" as "the part I'd lean into hardest" and "Minerva's real differentiator" (line 135-139) — language of wrapping, forcing, and being the seam other services must go through — leans toward an enforcement/routing posture that isn't reconciled against this explicit plan-only restriction. The draft never states whether "stable seam" means Minerva plans-and-hands-off (compatible with the restriction) or Minerva actively gates/routes traffic between services (in tension with it).
  - Draft location: line 135-139
  - Posture reference: `.pHive/CONTEXT.md` — "Never auto-approve; never let Minerva execute, route, or provision — it only plans."
  - Question for planner: Should §3 add an explicit sentence clarifying that "stable seam"/"wrapper" means an ABI other services call into for planning output only (not routing or execution), to remove the ambiguity against this stated restriction?

## Notes

- §8's "Unknowns: 8" cross-checks correctly against §6, which lists exactly 8 numbered open questions — no discrepancy found there.
- §7's verification plan explicitly marks its first manual-check item "[Superseded by PAN-7734's own production verification...]" — this is a well-integrated correction and a good pattern; it's the PR #10 "hard precondition" language in §3/§4 (see U1) that wasn't given the same treatment.
- On the requested stress-test of "Minerva should narrow, not broaden, not fold" (§3 line 120): the "not fold" / "not broaden" halves are reasonably earned by §2's evidence — none of the three plugin-hive efforts is a full substitute, and that holds independent of the mid-draft correction. The "stronger position... materially stronger" superlative framing layered on top of that (line 120-126) is less well-calibrated: it leans on a single-host production verification (H2), an independence claim that isn't fully substantiated against the fork's own runner-dispatch code (H3), and a hedged "apparently confirmed" spike result elevated to "proof" (H4). The underlying directional conclusion likely survives a revision; the confidence language describing it currently outruns what §2 actually demonstrates.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize findings. Each finding ends with a question for the planner; the planner's job is to revise the draft (or document accepted deviations) before stories are written.
