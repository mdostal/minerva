# Grill Record — agent-drivable-core

**Source draft:** .pHive/epics/agent-drivable-core/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass)
**round_number:** 1
**unresolved_count:** 12
**Generated:** 2026-07-24

## Summary
- Vocabulary mismatches: found 2
- Hidden assumptions: found 4
- Unresolved tensions: found 3
- Convention violations: found 1
- Posture mismatches: found 2

## Vocabulary mismatches

1. **"P0" vs. the PRD's own "P1" labeling.** §7 Verification Strategy states: "Automated: all
   6 P0 requirements (REQ-01..06) get real node:test coverage against a live bin/minerva
   subprocess." `docs/prd.md`'s Priority Matrix labels REQ-01 through REQ-06 as **P1** and
   REQ-07/REQ-08 as **P2** — there is no P0 tier anywhere in the PRD. Question for planner: is
   there an undocumented P0 tier the draft means to introduce, or should this read "P1" to match
   the PRD's own priority vocabulary?

2. **Canonical term "driving agent" never appears in the draft.** CONTEXT.md defines "driving
   agent" as the specific actor central to this whole epic ("the agent... that
   programmatically operates a run: starts it, answers agent-channel questions, polls status").
   The draft consistently falls back to generic phrasing instead — e.g. §1: "lets an agent
   (Claude, or whatever) drive plugin-hive's `kickoff` + `plan` skills programmatically," §5:
   "a real runtime dependency, not vendored" (re: the `claude` CLI, not the driving agent at
   all). Question for planner: is avoiding the canonical term intentional, or should the draft
   anchor to "driving agent" so the vocabulary carries cleanly into the stories?

## Hidden assumptions

1. **Sibling-repo precedent asserted as settled fact, ungrounded in the reviewed doc set.** §2
   states plugin-hive's `hive/adapters/github/index.ts` and `hive/adapters/multica/index.ts`
   "already speak almost exactly the wire format AD-1 commits Minerva to," and that
   pantheon-orchestrator's tsconfig/package.json "is the obvious scaffold to match rather than
   re-decide." CONTEXT.md's canonical references only cite `task-tracking-adapter-abi.md` and
   pantheon-orchestrator's architecture.md AD-4 — not these specific adapter or config files.
   The draft itself calls this "fresh this round" research. Question for planner: has this
   sibling-repo research been independently checked, or should it be logged as an assumption to
   confirm rather than presented as established precedent?

2. **REQ-07 (Local CLI convenience wrapper) has no build step anywhere in the plan.** §3's
   8-step build order never mentions it; it's absent from §4's risks, §6's open questions, and
   §8's file/subsystem count. `docs/architecture.md`'s Components list also has no component for
   REQ-07's foreground-interactive behavior. Question for planner: is REQ-07 deliberately
   deferred out of this epic's v1 scope, and if so, where should that exclusion actually be
   stated — since nothing in the draft says so?

3. **Escalation Classifier's actual judgment mechanism is left unstated.** AD-2 says the
   escalate/absorb signal is "judged at question-generation time by the same planning persona
   that generates the question." §3 step 4 instead frames the Escalation Classifier as a
   Minerva-side step that "takes an extracted question, emits `{suggested_channel, confidence,
   reason}`" and calls the story "mostly 'classify and stamp a default.'" It's not stated
   whether this component makes its own judgment call (e.g. another `claude -p` invocation) or
   is meant to parse a signal already embedded in the extracted prose — and the spike's own
   quoted example (the metrics-tracking gate question) shows no embedded confidence/channel
   signal to parse. Question for planner: which mechanism is step 4 actually meant to build,
   since the effort estimate hinges entirely on the answer?

4. **§7 blurs which AD-3 case the spike actually covered.** §7 says: "neither is exercised by
   the spike's synthetic scratch-repo setup in a way that proves the existing-repo
   (worktree-off-dev) path works" — read plainly, this claims *both* AD-3 cases are unproven.
   §4, three sections earlier, is more precise: "The spike only exercised the greenfield
   fresh-`git init` path (its own scratch repos)," implying the greenfield case *is* reasonably
   covered. Question for planner: is §7's phrasing just loose, or does the author actually doubt
   the greenfield case's coverage too, contradicting §4's own more confident claim?

## Unresolved tensions

1. **Risk severity contradicts itself between §4 and §8.** §4 tags the extraction risk
   `[high]`. §8's narrative rationale, justifying a Medium (not Large) scope recommendation,
   downgrades the same risk to "a genuinely novel and moderately risky sub-component in the
   extraction step." Question for planner: which severity is actually driving the H/V-planning
   recommendation — high or moderate — and does the Medium-scope call still hold under the
   `[high]` framing?

2. **§8's risk rollup drops one of §4's own flagged risks.** §8 says: "Unknowns: 3 ... plus the
   two flagged high/medium risks in §4 (extraction reliability, unproven existing-repo workspace
   case)." §4 actually lists *three* risks tagged high/medium — extraction `[high]`, accidental
   auto-advance via a retry loop `[medium]`, and the unproven existing-repo case `[medium]` —
   plus a fourth `[low]` (cost/turn-count). The accidental-auto-advance risk is silently absent
   from the "two" being tallied. Question for planner: was that risk deliberately excluded from
   the scale/unknowns count as not scope-relevant, or is "two" an undercount that should feed
   back into the recommendation?

3. **Open Question #1 doesn't reconcile against AD-5's own hard rule.** §6 Q1 proposes defaulting
   a cost/turn-count ceiling to "out of scope, caller's problem." AD-5 explicitly rejects
   "timeout-then-default-answer... it directly violates the hard exclusion against auto-approving
   or guessing." A budget cap that forcibly closes or aborts a run mid-flight (whether added by
   a caller externally or later pulled into v1) risks looking exactly like the auto-resolution
   AD-5 rules out. Question for planner: should Open Question #1 explicitly flag this tension so
   a future "yes, add a budget cap" answer doesn't quietly violate AD-5?

## Convention violations

1. **CONTEXT.md's TDD maturity convention is never referenced.** CONTEXT.md's Conventions
   section states: "TS by default. Full TDD discipline: named → interfaced → full TDD →
   locked." Neither §3 (build order, sequenced purely by dependency/usefulness) nor §7
   (Verification Strategy, framed only as automated/manual/not-verifying buckets) mentions this
   maturity ladder at all. Question for planner: does this convention apply at the
   design-discussion stage, or is it understood to be an execution-phase concern that the
   story-writing step will apply later without needing to appear here?

## Posture mismatches

1. **`capabilities` built last despite being architecturally "first."** `docs/architecture.md`
   frames `capabilities` as the bootstrapping call — "adapter-ABI-style: `capabilities` first...
   Called once by any long-lived caller; declares the Minerva ABI version" — and lists it first
   in the API Contract table. §3's build order places implementing `capabilities` in step 8,
   dead last, bundled with the lowest-priority reads (`getRunStatus`, `listRuns`, `abortRun`).
   Question for planner: is deferring `capabilities` to the end of the build order intentional
   (e.g. no real caller needs ABI-version negotiation until the other methods exist to call), or
   does this depart from the "capabilities first" posture the ABI convention establishes?

2. **Escalation Classifier's effort framing undersells AD-2's own rejection of mechanical
   classification.** AD-2 explicitly rejects "a standalone rule/keyword classifier" because
   "'ambiguous' and 'low-confidence' are judgment calls, not lexical patterns" — establishing
   that genuine judgment, not mechanical logic, is required. §3 step 4 nonetheless describes the
   Escalation Classifier story as "mostly 'classify and stamp a default'" with no mention of a
   model call, prompt, or judgment mechanism — a strikingly lighter framing than step 3 (question
   extraction), explicitly called "the highest-risk story in the epic even post-spike." Question
   for planner: does the classifier need its own judgment mechanism comparable in complexity to
   extraction, and if so, should its risk/effort framing in §3/§4 reflect that instead of reading
   as a trivial pass-through?

## Notes

- The draft is well-grounded against `docs/architecture.md`, `docs/prd.md`, and the spike
  findings on most factual claims checked (headless `AskUserQuestion` behavior, AD-3's two-case
  split, AD-5's pause/resume-is-free claim, the "No Autonomous Progress" invariant) — the
  findings above are concentrated in a handful of specific spots (§4/§7/§8 internal
  cross-references, REQ-07 traceability, and the Escalation Classifier's underspecified
  mechanism) rather than being spread evenly across the whole document.
- Several findings above are pairs of sections disagreeing with each other within the same
  draft (§4 vs §7, §4 vs §8) rather than draft-vs-source-doc mismatches — worth a quick internal
  consistency pass independent of resolving the substantive questions.
