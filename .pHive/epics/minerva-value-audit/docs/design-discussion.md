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

**Branch/evidence correction (mid-draft, before grill):** this epic's branch was initially created off `main` — `git_flow.mjs`'s local resolution missed `origin/dev` because it hadn't been fetched yet on this checkout. `.pHive/CONTEXT.md` is explicit that `dev` is the project's actual working branch and `main` should never be branched off directly. Once fetched, `origin/dev` turned out to be **20 commits ahead of `main`**, and two of those commits directly overturn findings in §2 below (the research brief was written against stale `main` state). The branch has been rebased onto `origin/dev`; §2 and downstream sections are corrected in place rather than re-run from scratch, with the corrections clearly marked.

## §1. What Are We Doing?

This isn't a code-change epic, it's a decision epic. The user asked us to dig into the real state of `firefly-events/plugin-hive`, our fork
(`mdostal/plugin-hive-fork`), and the PRs we've sent back upstream, and answer a genuinely uncomfortable question: does plugin-hive's own
progress toward runner-agnostic, headless pause/resume already make Minerva redundant? And if not, what exactly is left that only Minerva
provides?

The framing in the request has two halves worth separating. First, "pause and resume on the overall commands" — not just kickoff and plan,
but execute, test, review, ship, standup, the whole surface. Second, "integrating well into more full agentic environments to wrap and force
the usage of the plugin hive... enabling it for planning, questions, etc across the board." That second half is really asking whether
Minerva is the thing that lets an external harness — a scheduler, another LLM, a CI job, Auriga — drive Hive without holding a terminal open
and without being Claude Code itself.

"Done" here doesn't mean shipped code. It means a defensible, evidence-grounded position, one of: "Minerva is redundant, sunset it";
"Minerva's value is narrower than the current north_star claims, here's the honest scope"; or "Minerva's value is intact, here's precisely
why the three plugin-hive efforts don't cover it." I want to be upfront that I don't think this is a coin-flip once you actually read the PR
states rather than the headline "plugin-hive is gaining agnostic pause/resume" narrative — the evidence leans fairly clearly one direction.
But I want to walk the reasoning, not just assert the conclusion, and I want to flag which parts of the evidence are still soft rather than
papering over them.

I'd also note explicitly what this epic is *not*: it's not a mandate to rebuild Minerva's ABI, and it's not a mandate to write the "wrap and
force usage across the board" tooling the user gestured at. Those are real, large follow-on efforts if the value proposition holds — this
document's job is to establish whether they're worth doing at all before anyone commits engineering time to them.

## §2. What I Found

The research brief is unambiguous that there isn't one plugin-hive effort to compare Minerva against — there are three, at three different
maturities, and conflating them is the single easiest way to get this wrong.

**Upstream PR #341** (`firefly-events/plugin-hive#341`) adds a headless question protocol. `hive/lib/runtime_mode.{py,js}` detects headless
mode from explicit env signals only — `HIVE_HEADLESS` wins if set, else `CI=true`, else interactive by default; no TTY-probe fallback.
`hive/lib/question_gateway.{py,js}` batches all questions at a phase boundary into `.pHive/questions/<skill>-<invocation-id>.yaml`, prints
`AWAITING_ANSWERS`, and exits; an external orchestrator writes `answer:` + `status: answered` back onto the same file, and envelopes are
deleted on consume (a fix added in review round 3, to stop stale reuse of repeated phase ids like `1a`). The PR author's own text says this
"mirrors Minerva's own `submitAnswers` shape" — that's a striking admission worth taking at face value. But the scope is narrow: kickoff
gets 7 wiring points, design gets 2 (loop-aware), plan gets 2 (branch-switch-confirm, version_bump) — not execute, test, review, or ship. A
newer plan question (step 14c, "sidecar-retention") isn't even wired because it postdates the branch the PR is built on. And the PR has been
open 18+ days (2026-07-26 to 2026-08-13) with zero human review — only automated CodeRabbit rounds and the author's own replies. "OPEN" here
should not be read as "actively being reviewed."

**Fork-only runner-agnostic dispatch work** — fork PRs #3, #6, #11, #12, covering codex/opencode/Gemini backends, a declarative process
manifest, and the agnostic PLAN port at `hive/agnostic/plan-agnostic.mjs` — is merged to the fork's `dev` branch but gated behind fork PR
#10 ("Promote: dev -> main," open since 2026-08-02) from reaching even the fork's own `main`, let
alone upstream. This is the exact code Minerva's `src/agnostic-plan-driver.ts` is supposed to spawn as the "runner-agnostic PLAN driver."
It's worth noting plugin-hive already had a multi-substrate execution concept before this fork work existed
(`hive/references/dispatch-parity.md`, covering `default`/`multica`/`cc-workflows` with `sandcastle`/`gh-actions-legacy` planned) — the fork
work generalizes that idea further, it isn't inventing the concept from scratch.

**The native DAG-executor `pause` node type** is already shipped — plugin cache v2.15.0, installed at
`hive/lib/dag_executor/pause/{__init__,signal,token,errors}.py`, dispatched via `executor/handlers/pause.py` and `executor/dispatcher.py`.
It's real infrastructure: `wait_for_signal()` runs `while True: check sentinel files; sleep(poll_interval=5.0s)` until an
`.approve`/`.reject` sentinel appears at `<runs_root>/<run_id>/pause/<node_id>.{approve,reject}`, or a hard 30-day ceiling elapses. Security
is solid — HMAC-SHA256 resume tokens bound to `(run_id, node_id)`, signing key persisted at `<runs_root>/<run_id>/.signing_key` with mode
0600. But architecturally it's a synchronous blocking poll loop inside one live process, not a resumable, cold-start-friendly primitive —
and it's opt-in per workflow (`executor_default: false` per `hive/decisions/001-executor-cutover.md`), graduated only for `ui-design`,
`design-review`, `daily-ceremony`. Kickoff and plan, as Minerva invokes them today, don't run under this executor at all.
`run_state/resume.py`'s generic `--resume <run-id>` CLI (for replaying failed/interrupted runs) explicitly raises
`ResumeFromInvalidStateError` on a `SUSPENDED` run — the code comment says this is by design, delegated to "the hde-8 pause-resume path"
instead. That's confirmation these are two genuinely separate resume mechanisms, not one with two entry points.

The sharpest finding, though, is about Minerva itself, not plugin-hive — and it needed correcting mid-draft. The original pass of this
research read `agnosticPlanCliPath()` on `main`, where it checks three hardcoded candidate paths and returns `null` unless one exists,
concluding the "bulletproof claude fallback" was silently doing all the work with no error surfaced. **That conclusion was accurate for
`main`, but `main` is 20 commits stale relative to `dev`.** On `dev`, commit `4298ec8` ("PAN-7734: fix agnostic PLAN driver never selected
(Claude-locked planning)", 2026-08-11) fixes exactly this bug, and its commit message confirms the failure was real and had real
consequences: "Planning always fell back to the weekly-capped Claude SpawnDriver and exited 1, so delivery epics... never decomposed into
child build stories and the build lane starved." Two stacked root causes: the candidate list was missing the actual checkout name used on
the deployment host (`plugin-hive-fork-dev`, not `plugin-hive-fork`), and even a resolved path failed silently because
`plan-agnostic.mjs`'s `main()` guard (`fileURLToPath(import.meta.url) === process.argv[1]`) breaks when the path is reached through a
symlink — Node resolves `import.meta.url` through the symlink but `argv[1]` keeps the symlinked form, so the guard was false and the CLI
exited 0 with empty stdout, no plan, no error. The fix adds the missing candidate and `realpathSync()`-canonicalizes every resolved path.
The commit message documents production verification on the "hive" host: a real ticket run (`PAN-8604`) now "routes to gemini via Heimdall,
completes, and files 4 child stories... to Multica with 0 errors," and a greenfield `--idea` run also completes.

That said, the fix's candidate list (`~/code/plugin-hive-fork-dev`, `~/Code/plugin-hive-fork-dev`, `~/code/plugin-hive-fork`,
`~/Code/plugin-hive-fork`, the installed plugin cache path) still doesn't include this analyst's actual local checkout name
(`/Users/mdostal/Code/plugin-hive`) — so on *this specific machine*, the driver would still very likely resolve to `null` today. That's now
understood as a naming-convention/environment gap rather than a fundamental unknown, though: the mechanism itself is proven working in
production elsewhere, which is a materially different risk posture than "may never have executed for real outside a demo."

A second, larger correction: **`ForkedHiveDriver` is not a stub on `dev`.** The project profile's brownfield discovery (also run against
`main`) described it as "an intentional stub, throws until plugin-hive-fork exists." On `dev`, `src/driver.ts`'s `ForkedHiveDriver` is fully
implemented — `dispatchFresh()` spawns *any* runtime via `resolveRuntimeRoute()`/an adapter pattern (not hardcoded to claude),
`answerAndContinue()` writes an answer onto a pending `.pHive/questions/*.yaml` envelope and re-dispatches the *original* skill prompt once
every required question is answered (a spike apparently confirmed re-issuing the original prompt, not a generic "continue", is what makes
the skill re-check its own on-disk state), and `surfaceNextQuestion()` extracts and classifies the next unanswered question. Its
`session_id` encodes an envelope pointer rather than a live process handle — this is a cold-start-tolerant, runtime-agnostic pause/resume
mechanism, already e2e tested (`PAN-8613`/`PAN-8619`, `tests/e2e/ForkedDriverFlow.test.ts`, `src/e2e-driver-validation.test.ts`) and covered
for instantiation (`PAN-8616`). Driver selection itself (`MINERVA_DRIVER` env → `selectDriver()` factory) was wired earlier
(`wire-forked-driver-selection`, commit `705ed97`).

## §3. My Proposed Approach

Here's my read, and I want to be honest that this is interpretation layered on the brief, not a new fact: none of the three plugin-hive
efforts is the thing Minerva claims to be. Minerva's own description is a `startRun`/`getRunStatus`/`submitAnswers` ABI — dispatch once,
come back later from a cold process, no held-open terminal, no per-workflow opt-in required. PR #341 gets close in spirit (the author's
"mirrors" comment is basically a compliment to Minerva's design), but it's scoped to 3 of 8+ skills and isn't merged. The fork dispatch work
is about *which runner* executes a step — codex vs. Claude vs. Gemini — not about pause/resume at all; it's orthogonal, not competing, and
shouldn't even be in the "does this replace Minerva" conversation except insofar as Minerva's own agnostic-plan-driver depends on it. The
native `pause` node is real pause/resume, but architecturally the opposite of cold-start-tolerant: it needs a live process blocking for up
to 30 days, which is precisely the constraint Minerva exists to route around, and it only covers three graduated workflows that aren't the
ones Minerva primarily drives today.

So my proposed positioning: **Minerva should narrow, not broaden, and should not fold — and the `dev`-branch correction makes this a
stronger claim than it was on the first pass, not just an unchanged one.** Before the correction, Minerva's differentiated value rested on
a design claim (an ABI that's supposed to be cold-start-tolerant and runtime-agnostic) with a live, undetected gap between that claim and
what actually executed. After the correction, `ForkedHiveDriver` is proof that the design works as claimed — a real, e2e-tested,
production-adjacent implementation of exactly the "dispatch, pause, resume from a cold process, any runtime" contract, built and validated
entirely independent of any of plugin-hive's three efforts. That's a materially stronger position than "the design is sound but nothing
proves it," which is where the pre-correction evidence left things.

The user's request bundles two ambitions — pause/resume across "the overall commands," and wrapping/forcing plugin-hive usage across
planning, questions, execution, and so on. On the first, the honest answer given the evidence is that Minerva doesn't currently *have*
full-command-surface pause/resume either — it has it for kickoff/plan-shaped flows, and none of the three plugin-hive efforts gets any actor
there for execute/test/review/ship. That's not a reason to abandon Minerva; it's a shared gap both sides need to close eventually, and
Minerva remains the only one of the four actors — the three plugin-hive efforts plus Minerva — whose stated design goal is cross-command,
cross-runner ABI stability rather than a specific workflow's interactive UX.

On the second, "force the usage of the plugin hive... across the board" is exactly the wrapper role, and it's the part I'd lean into
hardest. That's Minerva's real differentiator: not that it re-implements pause/resume internals, but that it's the stable seam other
Pantheon services integrate against, regardless of which internal mechanism plugin-hive happens to be using this month — question-gateway
files, DAG-executor sentinels, or neither. An Auriga-style router shouldn't need to know or care which of those three plugin-hive subsystems
is live for a given command; it should just call Minerva's ABI.

Concretely, I'd propose four things. First, do not deprecate Minerva on the strength of this research — the gap it fills is real, and none
of the three efforts closes it. Second, explicitly reframe the north_star's "runner-agnostic planning" claim to be honest about the current
fallback-only reality described in §2 and §4 — an unqualified claim of working infrastructure that silently isn't reachable is worse than a
qualified, accurate one. Third, if PR #341 lands, Minerva should almost certainly adopt its envelope format for the skills it covers rather
than maintain a hand-rolled parallel format — the author's "mirrors" language plus the direct file-path overlap
(`.pHive/questions/<skill>-<invocation-id>.yaml`) make this a near-free convergence. But I don't think that lets Minerva delete its own
protocol-translation code outright — #341 doesn't cover execute/test/review/ship, and Minerva needs to. Fourth, treat the fork's
`dev`-to-`main` promotion (fork PR #10) as a hard precondition for any "runner-agnostic" claim — Minerva shouldn't describe that capability
as live in any external-facing doc until the path is not just merged upstream of the fork but actually resolvable from Minerva's own
hardcoded lookup paths, which today it isn't.

One thing I'd deliberately resist: having Minerva "absorb" the DAG-executor's `pause` primitive wholesale. It's the wrong tool for
cold-start dispatch by design, not by oversight — there's conceptual validation to take from it (pause/resume-as-a-concept, HMAC-signed
tokens as a security pattern) but not code to reuse, given the fundamentally different process-lifetime assumption.

## §4. What Could Go Wrong

**Downgraded to Medium (was High pre-correction) — Minerva's agnostic-plan-driver fallback can still silently mask a broken dependency on
hosts whose checkout doesn't match the candidate-path naming convention.** The underlying bug was real, confirmed by `PAN-7734`'s own commit
message, and is now fixed and production-verified on at least one host ("hive"). The residual risk is narrower than originally assessed:
`agnosticPlanCliPath()`'s candidate list is still a fixed set of directory names (`plugin-hive-fork-dev`, `plugin-hive-fork`, the installed
plugin cache path), and any host — including this analyst's own machine — whose local checkout uses a different name will still resolve to
`null` with the same silent, no-error fallback behavior. The fix closed the two specific bugs it targeted; it didn't add the loud
log-line/metric this document still recommends for every fallback firing, so a *new* naming mismatch on a *different* host would reproduce
the same silent failure mode PAN-7734 just spent real effort diagnosing. I'd still treat "add visibility when the fallback fires" as a
concrete, cheap fix worth doing now that the mechanism is proven to matter in production.

**Medium — conflating the three plugin-hive efforts in any external comms.** The brief is explicit that this is "easy to conflate": PR #341
(questions), fork dispatch work (runner backend selection), and native `pause` (DAG executor) are unrelated in mechanism and maturity. If
this epic's conclusion gets summarized upward as "plugin-hive now has agnostic pause/resume" without the caveats, someone will reasonably
ask "so why does Minerva still exist" from an inaccurate premise. The write-up needs to keep these three distinct every time they're
referenced going forward.

**Medium — PR #341 stalling indefinitely.** 18+ days open, zero human review, only bot/author comments. If Minerva plans any convergence
work around adopting its envelope format, that plan is hostage to a PR that may never land. I'd treat "align with #341" as opportunistic
follow-on work, not something to schedule against a timeline.

**Medium — fork PR #10 (dev-to-main promotion) staying open indefinitely.** Same shape of risk as above but for the runner-dispatch work
specifically — open since 2026-08-02 with no resolution noted in the brief, and it's the one thing currently blocking Minerva's own
dependency from resolving at all.

**Low — native `pause`'s fail-closed-by-default behavior surprising a non-interactive caller.** `under_scheduler.auto_approve` needs
explicit configuration or the executor fails closed rather than adapting, for a caller that isn't the one that originally blocked. This
mostly matters if Minerva or another Pantheon service ever tries to drive DAG-executor-backed workflows directly instead of going through
Minerva's own ABI — worth flagging so nobody builds against `pause` expecting Minerva-like semantics for free.

**Low — scope creep in "across the board."** The user's request explicitly wants pause/resume and enforcement across *all* Hive commands.
Neither Minerva nor any of the three plugin-hive efforts is there today. That's a real, large gap worth naming, but it's future-scope, not a
defect in this audit — I don't want it silently assumed as already solved by this document.

## §5. Dependencies and Constraints

**Correction:** the pre-correction draft treated fork PR #10 (`mdostal/plugin-hive-fork#10`, "Promote: dev -> main," open since 2026-08-02)
as a hard precondition for Minerva's runner-agnostic planning claim. That's weaker than originally stated — `PAN-7734`'s fix resolves
`plugin-hive-fork-dev` as a candidate directly, meaning a host with the fork's `dev` branch checked out under that name gets the working
path today, independent of whether `dev` has been promoted to the fork's own `main`. Fork PR #10 matters for other reasons (getting this
work upstream-visible, eventually to `firefly-events/plugin-hive` proper) but it is not, as previously stated, the single blocker standing
between Minerva and a working agnostic-plan path — that blocker was PAN-7734's two bugs, and those are now fixed on `dev`. The remaining
real dependency is narrower: whichever host runs Minerva needs *some* local checkout of the fork (any of the five candidate names) with
`hive/agnostic/plan-agnostic.mjs` present — a deployment/provisioning concern, not an upstream-PR-timeline concern.

Separately, any convergence with PR #341's envelope format depends on that PR actually landing upstream in `firefly-events/plugin-hive`,
which per the brief has had no human reviewer engagement in 18+ days — an external, unowned timeline neither Minerva nor this epic controls.

The native DAG-executor `pause` primitive is constrained to whichever workflows are graduated onto the executor (`ui-design`,
`design-review`, `daily-ceremony` per `hive/decisions/001-executor-cutover.md`) — it's opt-in per workflow, not a platform-wide default, so
it can't be relied on as a general substrate even if Minerva wanted to build on it later.

There's also an environment constraint worth naming explicitly: the reachability gap in §2/§4 was found on one researcher's machine. Before
treating it as universal and acting on it broadly, it's worth confirming the same three lookup paths are absent in Minerva's actual
deployment environment(s), not just locally — the fix (accurate north_star wording, visibility logging) is cheap either way, but the framing
changes if it turns out to be a local-only gap.

## §6. Open Questions

1. Does `hive/agnostic/plan-agnostic.mjs` (fork PR #12) actually substitute for Minerva's own kickoff/plan question-and-answer loop
   end-to-end, or does it only handle the single-shot DECOMPOSE write? The brief notes only the PR description/proof snippet was checked,
   not the full `adapters.mjs`/`plan-agnostic.mjs` source — this materially changes how much of Minerva's plan-flow logic could ever be
   delegated to it.
2. Can `node_type: pause`'s sentinel-file protocol actually be driven end-to-end by a non-Claude-Code, non-interactive harness in practice,
   or does `under_scheduler.auto_approve`'s fail-closed default mean it effectively can't without custom integration work? No real
   non-interactive caller example was found in the brief's research window.
3. Does PR #341's prose (`hive/references/kickoff-protocol.md`, `question-envelope-schema.md`) document interop guidance for an external
   ABI consumer like Minerva, or does it only describe plugin-hive-internal behavior? This determines whether adopting its envelope format
   is a documented, supported integration path or something Minerva would be reverse-engineering from source.
4. What is actual maintainer sentiment on PR #341 — is it stalled awaiting a specific reviewer, deprioritized, or genuinely expected to
   land soon? Only GitHub PR comments were checked; no issue tracker or other discussion channel was consulted.
5. Should Minerva file its own PR against `firefly-events/plugin-hive` proposing explicit envelope-format alignment with #341, rather than
   silently maintaining a parallel format and hoping for eventual convergence? This wasn't in the original brief but falls directly out of
   the "mirrors" language in §2 — if the two formats are this close already, formalizing the convergence might be cheaper long-term than
   two teams independently maintaining lookalike protocols.
6. Given the reachability gap in §2/§4, should Minerva's north_star language be corrected now, independent of this epic's broader
   recommendation, since it currently describes working infrastructure that isn't reachable in at least one real environment?
7. Is there an owner and timeline for fork PR #10 (dev-to-main promotion)? Its blocking role turned out to be smaller than first assessed
   (see §5 correction), but it's still the path to getting this work upstream-visible.
8. `.pHive/project-profile.yaml` (written by this project's `/hive:kickoff`, run against `main`) still describes `ForkedHiveDriver` as "an
   intentional stub, throws until plugin-hive-fork exists" and doesn't reflect `dev`'s actual, fully-implemented state. Should that profile
   be corrected as a direct follow-up of this epic, or left for the next kickoff re-run? Leaving it stale risks future planning work
   under-scoping stories that touch the driver layer.

## §7. Verification Strategy

This is a research/decision epic — there's no feature to test, so "verification" means validating that the conclusions above are actually
true rather than artifacts of one pass of research, and specifically closing the reachability-gap risk from §4 rather than leaving it as a
citation someone has to trust.

**Partially resolved by the correction above.** `PAN-7734`'s own commit message already documents the load-bearing check this section
originally proposed — an actual invocation on the "hive" host, confirmed working (`PAN-8604` routes through Heimdall to Gemini, files child
stories with 0 errors). That's real evidence, from a real run, not an inference from static path checks. What's still unverified is
specifically *this* analyst's/machine's behavior (and, more generally, any future deployment host's), since the candidate list doesn't cover
every possible checkout name. The remaining concrete check is narrower than originally scoped: confirm on each host that actually runs
Minerva in production whether its local checkout name matches one of the five candidates, rather than re-verifying the mechanism itself.

```
VERIFICATION PLAN:
  Tools: Manual invocation of Minerva's plan flow with a temporary log line or breakpoint added at resolveAgnosticPlanDriver() in src/agnostic-plan-driver.ts; gh CLI re-checks of PR #341 / fork PR #10 / fork PR #12 status at decision time, since state may have moved since 2026-08-13; direct read of hive/agnostic/adapters.mjs and plan-agnostic.mjs source (not yet read per Open Question 1) once fork PR #10 lands or a fork dev checkout is available locally.
  Platforms: N/A -- this is a documentation/protocol investigation, not a UI or multi-platform surface.
  Automated: None planned -- this is a one-time decision investigation, not a recurring test surface, so there's nothing to keep passing in CI.
  Manual: (1) [Superseded by PAN-7734's own production verification on the "hive" host -- see §2/§5 correction.] Confirm instead, per production host that runs Minerva, whether its local checkout name matches one of agnosticPlanCliPath()'s five candidates. (2) Re-check PR #341 and fork PR #10 status immediately before finalizing any recommendation that depends on their landing. (3) Read the full plan-agnostic.mjs/adapters.mjs source to resolve Open Question 1 before committing to any envelope-convergence work. (4) Update .pHive/project-profile.yaml's structure/code_quality notes, which still describe ForkedHiveDriver as "an intentional stub" -- stale as of this epic's dev-branch correction (see Open Question 8).
  Not verifying: Maintainer sentiment on PR #341 beyond what's visible in PR comments (Open Question 4) -- no access to private review channels; whether node_type: pause can be driven by a real non-Claude-Code caller (Open Question 2) -- would require standing up a throwaway harness, which is out of scope for a decision document unless the answer turns out to gate the recommendation itself.
```

## §8. Scale Assessment

This epic is a research-and-decide exercise. The deliverable is this document plus whatever follow-on decision it produces — narrowing
Minerva's north_star claims, filing an alignment PR against #341, adding a fallback-visibility log line — not a feature build. Any code
touched as a direct consequence of this document's conclusions is small and localized: correcting the north_star wording, and adding
observability so the fallback-masking risk in §4 can't recur silently without anyone noticing.

```
SCALE ASSESSMENT:
  Files affected: ~2-3 (project-profile.yaml north_star correction, agnostic-plan-driver.ts fallback-visibility logging, possibly this design-discussion.md itself as the decision record)
  Subsystems: Minerva's agnostic-plan-driver / Heimdall routing layer only -- no plugin-hive code changes proposed here, that work belongs upstream and in the fork, outside Minerva's control
  Migration required: no
  Cross-team coordination: no new infra required, but the recommendation's durability depends on external, unowned timelines (PR #341 review, fork PR #10 promotion) that Minerva cannot control or schedule against
  Unknowns: 8 (see §6 open questions)

  RECOMMENDATION: Proceed to stories
  RATIONALE: The core decision is answerable from this document -- the evidence doesn't support deprecating Minerva, and after the dev-branch correction the case is stronger than the initial pass found: ForkedHiveDriver is proof, not just a claim, that Minerva's cold-start-tolerant, runtime-agnostic pause/resume design works, independent of any of plugin-hive's three efforts. What follow-on work exists is still small, mechanical, and doesn't touch architecture: correcting north_star and project-profile.yaml claims to match dev's actual reachable reality, and adding observability so the (now narrower, host-naming-specific) fallback-masking risk in §4 can't recur silently. A structured outline would be overkill for work this contained; a handful of stories decomposed directly from this document is sufficient to carry it forward.
```

SCOPE_CLASS: single-epic
