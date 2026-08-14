# Design Discussion — minerva-value-audit

## §0. Context Prelude

```
NORTH STAR
Goal: Enable the idea -> plan -> ticket-decomposition -> Multica-execution pipeline to run fully async under agentic harnesses -- Minerva drives any Hive command headlessly (pause at a question, forward it out, resume from an answer). Open strategic question (unresolved, explicitly deferred by the user 2026-08-13): now that plugin-hive itself is gaining native agnostic pause/resume, whether Minerva still needs to exist as a separate layer is an open judgment call -- THIS EPIC IS THE INVESTIGATION TOWARD THAT CALL.
Audience: Human operator + other Pantheon services (Auriga-style routing). Minerva itself must stay harness/UI-agnostic -- it provides pause/resume/question-extraction only, never couples to Consus (renamed Delphi) or any specific surface; that integration is entirely Pantheon's responsibility.
Scale: Low concurrency per instance, but must support many parallel Minerva instances (one per repo / one per idea-intake session).
Pain points: (1) Manual per-idea kickoff via SSH doesn't scale. (2) Needs async execution with compute pushed via Multica. (3) Prior --resume-based approaches hit real production issues -- the fix in progress is making plugin-hive itself runner-agnostic (agnostic-plan-driver + Heimdall route, landed 2026-08-12) -- which is also what raises the open strategic question above.
```

No PRIOR DECISIONS section — a kg_why query against the knowledge graph for this topic returned zero relevant results, clean slate.

**Branch/evidence correction (mid-draft, before grill):** this epic's branch was initially created off `main`; `origin/dev` turned out to be
**20 commits ahead**, two of which overturn findings in §2 below. The branch has been rebased onto `origin/dev`; §2 and downstream sections
are corrected in place, with corrections clearly marked. A second correction pass, made during this grill-response revision, folds in
direct-source reads of `src/driver.ts` and related files that reshape §2/§3/§5 further — also marked in place.

## §1. What Are We Doing?

This isn't a code-change epic, it's a decision epic. The user asked us to dig into the real state of `firefly-events/plugin-hive`, our fork
(`mdostal/plugin-hive-fork`), and the PRs we've sent back upstream, and answer a genuinely uncomfortable question: does plugin-hive's own
progress toward runner-agnostic, headless pause/resume already make Minerva redundant? And if not, what exactly is left that only Minerva
provides?

The framing in the request has two halves. First, "pause and resume on the overall commands" — not just kickoff and plan, but execute, test,
review, ship, standup, the whole surface. Second, "integrating well into more full agentic environments to wrap and force the usage of the
plugin hive... across the board." That second half is asking whether Minerva is the thing that lets an external harness — a scheduler,
another LLM, a CI job, Auriga — drive Hive without holding a terminal open and without being Claude Code itself.

**Vocabulary note:** CONTEXT.md's canonical term for this role is "driving agent" — the agent, Claude or otherwise, that programmatically
starts a run, answers agent-channel questions, and polls status (v1's async mechanism). Where this document says "external harness," "actor,"
or "orchestrator," it means that same v1 role. "Auriga-style router" is used deliberately as a broader example of who might eventually
*occupy* that role once Auriga's own contract exists — a v2-scoped instantiation (see §3), not a synonym for the term itself.

"Done" here doesn't mean shipped code. It means a defensible, evidence-grounded position: "Minerva is redundant, sunset it"; "Minerva's value
is narrower than north_star claims, here's the honest scope"; or "Minerva's value is intact, here's precisely why the three plugin-hive
efforts don't cover it." I don't think this is a coin-flip once you read the PR states rather than the headline narrative — the evidence
leans one direction — but I want to walk the reasoning and flag which parts are still soft rather than papering over them. This epic is not
a mandate to rebuild Minerva's ABI or to write the "wrap and force usage across the board" tooling — those are real follow-on efforts if the
value proposition holds; this document establishes whether they're worth doing at all.

## §2. What I Found

There isn't one plugin-hive effort to compare Minerva against — there are three, at three different maturities, and conflating them is the
easiest way to get this wrong.

**Upstream PR #341** (`firefly-events/plugin-hive#341`) adds a headless question protocol: `runtime_mode` detects headless mode from
explicit env signals only (`HIVE_HEADLESS`, else `CI=true`, else interactive); `question_gateway` batches questions at a phase boundary into
`.pHive/questions/<skill>-<invocation-id>.yaml`, prints `AWAITING_ANSWERS`, and exits — an external orchestrator writes the answer back onto
the same file, and envelopes are deleted on consume. The author's own text says this "mirrors Minerva's own `submitAnswers` shape." Scope is
narrow — kickoff (7 wiring points), design (2), plan (2) — not execute/test/review/ship. The PR has been open 18+ days with zero human
review, only automated CodeRabbit rounds and the author's own replies. "OPEN" should not be read as "actively being reviewed."

**Fork-only runner-agnostic dispatch work** — fork PRs #3/#6/#11/#12, covering codex/opencode/Gemini backends and the agnostic PLAN port at
`hive/agnostic/plan-agnostic.mjs` — is merged to the fork's `dev` but gated behind fork PR #10 ("Promote: dev -> main," open since
2026-08-02) from reaching even the fork's own `main`. This is the code Minerva's `src/agnostic-plan-driver.ts` spawns as the "runner-agnostic
PLAN driver." Plugin-hive already had a multi-substrate execution concept before this (`hive/references/dispatch-parity.md`) — the fork work
generalizes it, doesn't invent it from scratch.

**The native DAG-executor `pause` node type** is already shipped (plugin cache v2.15.0): `wait_for_signal()` polls for an
`.approve`/`.reject` sentinel file or a hard 30-day ceiling. Security is solid (HMAC-SHA256 resume tokens). But architecturally it's a
synchronous blocking poll loop inside one live process, not a resumable, cold-start-friendly primitive, and it's opt-in per workflow
(`executor_default: false`), graduated only for `ui-design`, `design-review`, `daily-ceremony` — not kickoff or plan. The generic
`--resume <run-id>` CLI explicitly raises on a `SUSPENDED` run, delegating "by design" to the separate pause-resume path — confirmation
these are two genuinely separate mechanisms.

The sharpest finding is about Minerva itself, and needed correcting mid-draft. The original pass read `agnosticPlanCliPath()` on stale
`main`, where it checks three hardcoded candidates and returns `null` silently otherwise — concluding the "bulletproof claude fallback" was
doing all the work with no error surfaced. **That was accurate for `main`, but `main` is 20 commits stale.** On `dev`, commit `4298ec8`
("PAN-7734: fix agnostic PLAN driver never selected") fixes exactly this — its message confirms the failure was real: "Planning always fell
back to the weekly-capped Claude SpawnDriver... the build lane starved." Two stacked bugs: a missing candidate directory name, and a
symlink-realpath mismatch in `plan-agnostic.mjs`'s `main()` guard that made the CLI exit 0 with no plan and no error. The fix adds the
candidate and canonicalizes paths with `realpathSync()`, and the commit documents production verification on the "hive" host (`PAN-8604`
routes through Heimdall to Gemini, files 4 child stories with 0 errors). That said, the fix's candidate list still doesn't include this
analyst's own checkout name — on *this* machine the driver would still likely resolve to `null`. That's now a naming-convention/environment
gap, not a fundamental unknown: the mechanism is verified working on at least one production host, materially different from "may never have
executed for real" — but it's one host, not a general guarantee (§4).

A second, larger correction: **`ForkedHiveDriver` is not a stub on `dev`.** The (stale, `main`-run) project profile calls it "an intentional
stub, throws until plugin-hive-fork exists." On `dev` it's fully implemented — `dispatchFresh()` spawns any runtime via
`resolveRuntimeRoute()`/an adapter pattern; `answerAndContinue()` writes an answer onto a pending envelope and re-dispatches the *original*
skill prompt once every required question is answered (a spike confirmed re-issuing the original prompt, not a generic "continue," is what
makes the skill re-check its own on-disk state); `surfaceNextQuestion()` extracts and classifies the next unanswered question. Its
`session_id` encodes an envelope pointer, not a live process handle — a cold-start-tolerant, runtime-agnostic pause/resume mechanism,
already e2e tested (`PAN-8613`/`PAN-8619`) and covered for instantiation (`PAN-8616`).

**Third correction, found after the grill pass via direct reads of `driver.ts`/`envelope-detection.ts`:** `ForkedHiveDriver` is not an
independently-evolved lookalike of PR #341's protocol — it's a direct client of it. The class's own header says it "drives the real
headless-question-protocol shipped in `firefly-events/plugin-hive#341`." `envelope-detection.ts`'s header agrees: the envelope format's
"Full schema: `hive/references/question-envelope-schema.md` in plugin-hive-fork," flagged "LOAD-BEARING (confirmed via the epic's own spike
+ PR #341's review)" — Minerva's spike work and #341's review process were directly connected, not parallel. `run-manager.ts`,
`kickoff-engine.ts`, and `deadline-renewal-ownership.test.ts` all cross-reference the same schema doc. `driver.ts`'s comments spell out the
production consequence: the intended path is `MINERVA_HIVE_PLUGIN_DIR` unset, relying on "whatever plugin-hive is installed via the normal
marketplace mechanism (the production case, once PR #341 ships)"; setting that env var at a local fork checkout is explicitly labeled a
*testing* stopgap, "before PR #341 ships in a real release." Today, with #341 unmerged, the intended production path doesn't carry the
protocol — only the local-checkout testing path does.

That's one half of an independence question the grill pass raised. The other half — whether the *runtime-dispatch* layer shares any of that
coupling — resolves the opposite way: `grep -n "^import" src/driver.ts` shows only stdlib, `yaml`, and two local Minerva modules; a
repo-wide `grep` for `plugin-hive|codex-backend|hive/agnostic` across `driver.ts`/`agnostic-plan-driver.ts` finds plugin-hive references
only in comments, never in an import. `resolveRuntimeRoute()`/`getAdapter()` and the `ClaudeAdapter`/`OpencodeAdapter`/`CodexAdapter`
implementations are Minerva's own, from-scratch invention, zero code shared with the fork's runner-dispatch work. §3 treats these as two
separate claims, not one blanket one.

Last piece: `escalation-classification.ts` — composed into the same `claude -p`/`--json-schema` call as question extraction, citing AD-2
directly — implements the agent/human channel split (`suggested_channel: "agent"|"human"`, defaulting to `human` on any parse failure, per
AD-2/AD-5's "never guess" rule). Neither the `Envelope`/`EnvelopeQuestion` interfaces nor the file format itself carry a channel field, so
this looks like Minerva-side logic layered on top of #341's format, not something #341 defines — best available evidence, not full
certainty; confirming fully needs a direct read of #341's schema doc (§6 Q9).

## §3. My Proposed Approach

None of the three plugin-hive efforts is the thing Minerva claims to be. Minerva's own description is a `startRun`/`getRunStatus`/
`submitAnswers` ABI — this is CONTEXT.md's "Pantheon subprocess ABI" per AD-1, the JSON-over-stdio RPC contract Minerva's CLI interface
reuses, not a term this document coins fresh. PR #341 operates one layer down from that RPC surface: a file-based question-envelope format,
not an RPC contract, and per §2's direct-source evidence it isn't merely "close in spirit" to Minerva's design — it's the literal protocol
`ForkedHiveDriver` implements as a client. Stated explicitly: Minerva's external ABI (AD-1) is what other Pantheon services call;
`ForkedHiveDriver` is the internal mechanism, built directly against #341's schema, that makes that ABI's pause/resume promise real for
kickoff/plan today. The fork dispatch work is about *which runner* executes a step — orthogonal to pause/resume, relevant only insofar as
Minerva's agnostic-plan-driver depends on it. The native `pause` node is real pause/resume but the opposite of cold-start-tolerant: a live
process blocking up to 30 days, precisely the constraint Minerva exists to route around — AD-5 defines this exactly, "stall" as unbounded by
design, never timing out into a guessed answer, the opposite operating assumption from a bounded-but-long blocking poll loop — and it only
covers three graduated workflows that aren't the ones Minerva primarily drives.

**Positioning: Minerva should narrow, not broaden, and should not fold** — the `dev`-branch correction plus the direct-source evidence in §2
make this a stronger claim than the first pass found, though more specific than "independent of all three efforts." There are now two
distinct, separately-evidenced claims where the earlier draft made one blanket one. On the runtime-dispatch layer, independence holds and is
directly confirmed (zero imports from fork dispatch code, from-scratch, e2e-tested). On the question/pause/envelope layer, independence does
*not* hold: `ForkedHiveDriver` is Minerva's own, working, tested client implementation of PR #341's exact protocol, built in direct
reference to that PR's design and review. Still a materially stronger position than "the design is sound but nothing proves it" — a real,
e2e-tested implementation exists — but the honest framing is "strong, demonstrated evidence for a design built on a specific, named external
dependency," not "proof of full independence." A softer independence claim, paired with a sharper dependency to manage (§4/§5).

The request bundles two ambitions. On pause/resume "across the overall commands": Minerva doesn't currently have full-command-surface
pause/resume either — only kickoff/plan-shaped flows — and none of the three plugin-hive efforts gets any driving agent there for
execute/test/review/ship. Not a reason to abandon Minerva; a shared gap both sides need to close, and Minerva remains the only one of the
four actors whose stated design goal is cross-command, cross-runner ABI stability rather than one workflow's interactive UX.

On "wrap and force usage... across the board": two clarifications the grill pass surfaced as missing. First, "stable seam" here means an ABI
other services call for planning output and hand-off — start a run, poll it, answer its questions, get back a decomposed plan — not a
routing or execution gate; CONTEXT.md is explicit Minerva must "never execute, route, or provision — it only plans," and nothing in this
differentiator crosses that line. Second, per CONTEXT.md's v1/v2 split, every god-integration (Auriga included) is v2, "behind a contract,
so it swaps in cleanly once that god exists" — v1 is standalone. So the Auriga-style-router framing is a v2-scope aspiration named as a
reason not to fold Minerva, not a present-tense capability: Minerva has no Auriga contract today, and this document isn't recommending it
build one as part of this epic's follow-on work. Once that v2 contract exists, that's Minerva's real differentiator: not re-implementing
pause/resume internals, but becoming the stable seam other Pantheon services integrate against for planning output, regardless of which
internal mechanism plugin-hive happens to be using — question-gateway files, DAG-executor sentinels, or neither.

Concretely, four recommendations, two revised here from the pre-grill draft. **First**, do not deprecate Minerva — the gap it fills is real,
none of the three efforts closes it. **Second**, explicitly reframe north_star's "runner-agnostic planning" claim to match the fallback-only
reality in §2/§4 — an unqualified claim of unreachable infrastructure is worse than a qualified, accurate one. **Third, corrected:** Minerva
doesn't need to *decide whether to adopt* PR #341's envelope format if it lands — it already has, today, as its live implementation
(`ForkedHiveDriver`). The open question isn't "should we converge," it's "what happens to that implementation if #341 never merges" (§4).
What #341 landing *would* still change: moving Minerva off the `MINERVA_HIVE_PLUGIN_DIR` testing stopgap onto the normal
marketplace-installed path `driver.ts` calls "the production case." It doesn't hand Minerva execute/test/review/ship coverage — #341 doesn't
touch those skills, and Minerva's own protocol-translation code still has to. **Fourth, corrected — where the grill's contradiction finding
(U1) most changes the picture:** fork PR #10 is *not* a hard precondition for anything Minerva's kickoff/plan pause/resume path depends on;
treating it as one, as an earlier draft did, conflated the fork's *runner-dispatch* work with the *question/envelope* work — different PRs,
different repos, different Minerva subsystems. The dependency actually worth naming as a precondition is upstream PR #341 itself: until it
ships (or an equivalent reaches the normal marketplace mechanism), `ForkedHiveDriver`'s intended production path doesn't exist, and Minerva
runs its pause/resume-capable driver only via the local-checkout testing stopgap. Minerva shouldn't describe question/envelope pause-resume
as fully production-ready externally until that's resolved.

One thing I'd deliberately resist: having Minerva "absorb" the DAG-executor's `pause` primitive wholesale. Wrong tool for cold-start dispatch
by design, not oversight — conceptual validation to take (pause/resume-as-a-concept, HMAC-signed tokens as a security pattern), not code to
reuse, given the fundamentally different process-lifetime assumption.

## §4. What Could Go Wrong

**Downgraded to Medium (was High pre-correction) — Minerva's agnostic-plan-driver fallback can still silently mask a broken dependency on
hosts whose checkout doesn't match the candidate-path naming convention.** The bug was real (confirmed by `PAN-7734`'s commit) and is now
fixed and production-verified on at least one host. Residual risk: the candidate list is still a fixed set of directory names, and any host
— including this analyst's own machine — with a different local checkout name resolves to `null` with the same silent fallback. The fix
didn't add the loud log-line/metric this document still recommends for every fallback firing, so a *new* naming mismatch on a *different*
host reproduces the same silent failure PAN-7734 just spent effort diagnosing. Worth doing now that the mechanism is proven to matter.

**Medium — conflating the three plugin-hive efforts in any external comms.** PR #341 (questions), fork dispatch work (runner selection), and
native `pause` (DAG executor) are unrelated in mechanism and maturity. If this epic's conclusion gets summarized as "plugin-hive now has
agnostic pause/resume" without caveats, someone will reasonably ask why Minerva still exists from an inaccurate premise.

**Upgraded to High (was Medium) — PR #341 stalling indefinitely, now that §2's direct-source evidence shows Minerva's production pause/resume
path is directly gated on it landing.** 18+ days open, zero human review — unchanged facts, but changed weight: not "if we ever want to
converge formats, that plan is hostage to an unowned PR," but "the intended production path for `ForkedHiveDriver` doesn't exist until #341
ships or an equivalent lands." Today every real invocation runs through the `MINERVA_HIVE_PLUGIN_DIR` local-checkout path `driver.ts` itself
documents as testing-only. If #341 stalls indefinitely, that stopgap either becomes the de facto production mechanism (undocumented as such)
or Minerva needs its own way to install/vendor the protocol independent of the marketplace. This is now the single most load-bearing
external dependency in this document.

**Sharper still, per architect review:** running with `MINERVA_HIVE_PLUGIN_DIR` unset against a real marketplace-installed plugin-hive that
predates #341 doesn't error at all — `dispatchFresh()` runs the skill, no envelope ever gets written (the underlying plugin-hive has no code
to write one), and `surfaceNextQuestion()` falls through to the `NO_PENDING_SENTINEL` "run may be complete" placeholder, which is silently
indistinguishable from a legitimate completion. That means the failure mode isn't just "the stopgap becomes de facto production" — it's that
running the intended production configuration *today*, before #341 ships, looks exactly like success while silently never pausing for a
single question. Same root dependency, but this sharpens why observability (§4's first risk item) needs to cover this path specifically, not
just the agnostic-plan-driver fallback it was originally scoped to.

**Downgraded to Low (was Medium; corrected per §5 and the U1 grill finding) — fork PR #10 staying open indefinitely.** Not the blocker on
Minerva's agnostic-plan-driver path — §5 already established `PAN-7734`'s fix resolves the `plugin-hive-fork-dev` candidate directly,
independent of PR #10 — and it's a separate PR, in the fork repo, gating a separate subsystem (runtime-dispatch, not question/envelope
pause-resume) from the PR #341 risk above. Remaining risk is upstream visibility only. Real, not urgent, not blocking.

**Low — native `pause`'s fail-closed-by-default behavior surprising a non-interactive caller.** `under_scheduler.auto_approve` needs explicit
configuration or the executor fails closed for a caller that isn't the one that originally blocked — matters if Minerva or another Pantheon
service ever drives DAG-executor-backed workflows directly instead of through Minerva's own ABI.

**Low — scope creep in "across the board."** Neither Minerva nor any of the three plugin-hive efforts covers all Hive commands today. A
real, large gap worth naming, but future-scope — not silently assumed as already solved here.

## §5. Dependencies and Constraints

**Correction:** the pre-correction draft treated fork PR #10 as a hard precondition for Minerva's runner-agnostic planning claim. Weaker
than stated — `PAN-7734`'s fix resolves `plugin-hive-fork-dev` as a candidate directly, independent of whether `dev` has been promoted to
the fork's own `main`. PR #10 matters for other reasons (upstream visibility) but isn't the single blocker — that was PAN-7734's two bugs,
now fixed. The remaining real dependency: whichever host runs Minerva needs *some* local fork checkout (any of five candidate names) with
`plan-agnostic.mjs` present — a deployment/provisioning concern, not an upstream-PR-timeline one. (Distinct PR, distinct repo, from the PR
#341 dependency below — not substitutes for one another.)

Separately, and sharper than the pre-grill draft had it: Minerva's production pause/resume path for kickoff/plan is not merely "would
benefit from converging with" PR #341's envelope format — per §2, it *is* PR #341's envelope format, implemented client-side in
`ForkedHiveDriver`. That makes PR #341 landing upstream (or an equivalent reaching the normal marketplace mechanism) the real dependency
gating `ForkedHiveDriver`'s intended production path, not an optional nice-to-have. No human reviewer engagement in 18+ days — an external,
unowned timeline. Until it resolves, Minerva's only working path is the `MINERVA_HIVE_PLUGIN_DIR` local-checkout testing stopgap `driver.ts`
itself documents as pre-production.

The native DAG-executor `pause` primitive is constrained to whichever workflows are graduated onto the executor (`ui-design`,
`design-review`, `daily-ceremony`) — opt-in per workflow, not a platform-wide default, so it can't be relied on as a general substrate.

There's also an environment constraint worth naming: the reachability gap in §2/§4 was found on one researcher's machine. Before treating it
as universal, it's worth confirming the same lookup paths are absent in Minerva's actual deployment environment(s) — the fix is cheap
either way, but the framing changes if it's local-only.

## §6. Open Questions

1. Does `plan-agnostic.mjs` (fork PR #12) actually substitute for Minerva's own kickoff/plan question-and-answer loop end-to-end, or only
   handle the single-shot DECOMPOSE write? Only the PR description/proof snippet was checked, not the full `adapters.mjs`/`plan-agnostic.mjs`
   source — materially changes how much of Minerva's plan-flow logic could ever be delegated to it (see §8's qualification of this).
2. Can `node_type: pause`'s sentinel-file protocol actually be driven end-to-end by a non-Claude-Code, non-interactive harness, or does
   `under_scheduler.auto_approve`'s fail-closed default mean it effectively can't without custom integration work? No real non-interactive
   caller example was found.
3. **Sharper post-correction:** does #341's own `question-envelope-schema.md` document its schema as a supported, stable external-consumer
   contract, or is `ForkedHiveDriver`'s reliance on it an informal coupling to an unstable, unmerged branch schema that could still change
   before merge? Matters more now — Minerva isn't choosing whether to adopt this format, it's already built against it.
4. **Now the single most urgent open question, given §4's upgraded risk:** what is actual maintainer sentiment on PR #341 — stalled awaiting
   a specific reviewer, deprioritized, or genuinely expected to land soon? Only GitHub PR comments were checked; Minerva's production
   readiness now hinges on the answer.
5. **Revised:** given the coupling in §2 is already real, should Minerva proactively engage on PR #341 — flagging that a downstream consumer
   already implements its schema — to get advance notice of breaking changes, rather than silently depending on an unmerged branch it
   doesn't influence?
6. Given the reachability gap in §2/§4, should north_star language be corrected now, independent of this epic's broader recommendation?
7. Is there an owner and timeline for fork PR #10? Smaller blocking role than first assessed (§5), now clearly the lower-stakes of the two
   open-PR dependencies (§4) — but still the path to upstream visibility.
8. `.pHive/project-profile.yaml` still describes `ForkedHiveDriver` as "an intentional stub" and doesn't reflect `dev`'s actual,
   fully-implemented state. Corrected as a direct follow-up, or left for the next kickoff re-run? Leaving it stale risks under-scoping future
   driver-layer work.
9. **New, from the `escalation-classification.ts` read in §2 (H5):** is the agent/human channel split (AD-2) fully and only a Minerva-side
   concern layered on top of #341's envelope format, or does #341's own schema carry a channel-adjacent field this pass missed?
   Best-available evidence says the former, but full certainty needs a direct read of `question-envelope-schema.md` and
   `escalation-classification.ts` in full, out of this revision's scope.

## §7. Verification Strategy

This is a research/decision epic — "verification" means validating the conclusions above rather than leaving them as one pass of research,
and specifically closing the reachability-gap risk from §4.

**Partially resolved.** `PAN-7734`'s commit message already documents the load-bearing check this section originally proposed — an actual
invocation on the "hive" host, confirmed working. Real evidence from a real run, not an inference from static path checks. Still unverified:
*this* analyst's/machine's behavior, and any future deployment host's, since the candidate list doesn't cover every checkout name. **Also
resolved by the grill-driven direct-source read:** the independence question (H3) and "is #341 actually load-bearing" (U1) are no longer
open items needing separate verification — answered by directly reading `driver.ts`, `envelope-detection.ts`, and
`escalation-classification.ts` on `dev`, cited throughout §2/§3. What's genuinely still unverified: #341's maintainer sentiment/timeline (§6
Q4, now the most urgent item), and whether its schema doc documents Minerva's usage as a supported contract (§6 Q3/Q9).

```
VERIFICATION PLAN:
  Tools: Manual invocation of Minerva's plan flow with a temporary log line at resolveAgnosticPlanDriver() in src/agnostic-plan-driver.ts; gh CLI re-checks of PR #341 / fork PR #10 / fork PR #12 status at decision time; direct read of hive/agnostic/adapters.mjs and plan-agnostic.mjs source (Open Question 1); direct read of firefly-events/plugin-hive#341's question-envelope-schema.md source itself (Open Question 3/9) to confirm external-consumer support and any channel-classification field.
  Platforms: N/A -- documentation/protocol investigation, not a UI or multi-platform surface.
  Automated: None planned -- one-time decision investigation, not a recurring test surface.
  Manual: (1) [Superseded by PAN-7734's own production verification on "hive" -- see §2/§5.] Confirm instead, per production host, whether its local checkout name matches one of agnosticPlanCliPath()'s five candidates. (2) Re-check PR #341 status immediately before finalizing any recommendation -- now the single highest-priority re-check given §4's upgraded risk, distinct from and more urgent than fork PR #10. (3) Read the full plan-agnostic.mjs/adapters.mjs source to resolve Open Question 1. (4) Update .pHive/project-profile.yaml's stale "intentional stub" description (Open Question 8). (5) Read question-envelope-schema.md and escalation-classification.ts in full to close Open Question 9 (H5) with certainty.
  Not verifying: Maintainer sentiment on PR #341 beyond visible PR comments (Open Question 4) -- no access to private review channels; whether node_type: pause can be driven by a real non-Claude-Code caller (Open Question 2) -- out of scope unless it turns out to gate the recommendation itself.
```

## §8. Scale Assessment

This epic is a research-and-decide exercise. The deliverable is this document plus whatever follow-on decision it produces — narrowing
north_star claims, documenting the PR #341 production-path dependency explicitly, adding a fallback-visibility log line — not a feature
build. Any code touched as a direct consequence is small and localized.

```
SCALE ASSESSMENT:
  Files affected: ~2-3 (project-profile.yaml north_star correction, agnostic-plan-driver.ts fallback-visibility logging, possibly this design-discussion.md itself as the decision record)
  Subsystems: Minerva's agnostic-plan-driver / Heimdall routing layer, plus documentation-only corrections to how driver.ts/ForkedHiveDriver's PR #341 dependency is described externally -- no plugin-hive code changes proposed here, that work belongs upstream and in the fork
  Migration required: no
  Cross-team coordination: no new infra required, but the recommendation's durability depends on external, unowned timelines -- PR #341 landing is now the sharpest of these (§4/§5), fork PR #10 much less so
  Unknowns: 9 (see §6 open questions)

  RECOMMENDATION: Proceed to stories
  RATIONALE: The core decision is answerable from this document -- the evidence doesn't support deprecating Minerva. After the dev-branch correction and the direct-source evidence folded in during grill revision, the case is stronger than the initial pass found, but on more specific grounds than "independent of all three efforts": ForkedHiveDriver is strong, demonstrated evidence -- e2e-tested, production-adjacent -- that Minerva's cold-start-tolerant, runtime-agnostic dispatch layer is a genuine, independent invention, while its question/pause/envelope layer is a working, tested client implementation of PR #341's own protocol, not independent of it. That reframing sharpens which follow-on work matters rather than weakening "don't fold, don't broaden." Follow-on work stays small and mechanical: correcting north_star/project-profile.yaml claims, adding fallback-visibility observability, and -- new relative to the pre-grill draft -- documenting the PR #341 production-path dependency explicitly rather than leaving it implicit in code comments. On architecture specifically: Open Question 1 (whether plan-agnostic.mjs substitutes for Minerva's plan-flow loop) remains genuinely unread and could in principle change how much of that flow gets delegated -- "doesn't touch architecture" describes the stories recommended here (documentation/observability only), not a guarantee about what a future epic might find once Q1 is resolved. None of this stories batch is gated on Q1, so it can be answered in parallel without blocking this handoff. A structured outline would be overkill for work this contained; a handful of stories decomposed directly from this document is sufficient to carry it forward.
```

**Story sequencing note (from TPM collaborative review):** the follow-on stories this document recommends are content-coupled, not
independent, so they should not be decomposed as unordered parallel tickets. The north_star/project-profile.yaml correction depends on the
PR #341 production-path dependency being documented first (or in the same story) — otherwise it ships an incomplete "corrected" claim and
needs immediate rework. Similarly, the fallback-visibility observability story changes the fact pattern the profile correction describes
(silent fallback → logged fallback), so it should land before or alongside the profile correction, not after. Separately: since §4 upgraded
PR #341 to this document's single highest external risk with no natural resolution date, Phase C should add a lightweight checkpoint (a
dated re-check, not just "monitor an unowned PR" left implicit) so the risk doesn't silently go stale if #341 is still open in 30-60 days.
And Open Question 1 should be filed as its own tracked, owned item rather than left as prose in this document — if `plan-agnostic.mjs` turns
out to substitute for Minerva's plan-flow loop, that finding should surface as a new epic, not get lost once this one closes.

SCOPE_CLASS: single-epic
