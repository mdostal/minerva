# Design Discussion: rip-out-consus-coupling

## §0. Context Prelude

```
NORTH STAR
Goal: Enable the idea -> plan -> ticket-decomposition -> Multica-execution pipeline to run fully async under agentic harnesses -- Minerva drives any Hive command headlessly. This epic exists because live testing found Minerva's core code directly coupled to Consus (renamed Delphi) in ways that violate Minerva's own pre-existing, already-approved v1 product requirement: zero dependency on Delphi/Auriga/Vulcan/Multica/votem existing (docs/product-brief.md, docs/initial-info.md).
Audience: Human operator + other Pantheon services (Auriga-style routing). Minerva itself must stay harness/UI-agnostic and, per this epic, genuinely standalone -- no sibling-god coupling required for core operation.
Scale: Low concurrency per instance, but must support many parallel Minerva instances.
Pain points: A real Consus service happened to be reachable on this dev machine and silently broke 20 tests (status flipped to awaiting-consus instead of waiting_on_human) -- concrete, live proof the coupling isn't hypothetical. Epic fix-startrun-heimdall-routing (already shipped, this branch is built on top of it) separately fixed startRun's Heimdall routing so a live pause/resume PoC can actually be attempted once this rip-out lands.
```

No PRIOR DECISIONS section here — I ran a kg_why query before starting this doc and it came
back empty. Clean slate, nothing to reconcile against.

---

## §1. What Are We Doing?

I want to be upfront about what kind of epic this is, because it changes how I'm going to write
the rest of this doc. The prior two epics in this lineage (minerva-value-audit,
fix-startrun-heimdall-routing) were design-decision epics — the whole point was to figure out
what the right behavior even was. This one isn't that. The operator already decided: "full rip
it out and apart." There's no design question of *whether* Minerva should be Consus-independent
— that was already approved, in writing, before this branch existed (docs/product-brief.md,
docs/initial-info.md). What we're doing here is closer to a large, surgical removal — the
design judgment is entirely in the *how*: what order to do it in, what genuinely has to be
deleted vs. what can survive behind an opt-in boundary, and what breaks the moment we touch it
that needs a simultaneous fix rather than a follow-up ticket.

So let me answer the operator's actual question up front, because it's the thing this whole doc
needs to earn: **what is left of Minerva at the end?**

My answer: the generic `waiting_on_human` / `submitAnswers` pause-resume mechanism — AD-5's
stall invariant, "no timeout, resume-from-disk IS pause/resume" — is what's left, and it was
always the real product. Consus was never load-bearing for that mechanism. It was bolted onto
it — an unconditional, undocumented side-effect that fires on every turn regardless of whether
anyone asked for it. Strip Consus out entirely and Minerva doesn't lose a capability, it loses
a liability. The pause/resume core keeps working exactly as designed, just without a network
call to a sibling god silently mutating its status enum depending on what happens to be
reachable on the host machine that day. That's not a downgrade story, that's the whole point of
the rip-out: prove that the thing Minerva is actually good at (standalone, resumable,
harness-driven execution) never needed the coupling in the first place.

If we do this right, the PoC at the end should look almost boring — a run starts, pauses at a
real question, sits in `waiting_on_human`, gets answered from a separate process, resumes — and
the interesting part is what it *doesn't* do along the way: no side-channel HTTP call to a
sibling god, no ambient network reachability silently steering the status enum. The operator's
question wasn't "does Minerva still function afterward," it was "do we actually have proof, or
just a plan and a hope" — which is why §7 below isn't just an automated-test checklist, it
insists on re-running the live pause/resume PoC from a separate process, against the real ABI,
with our own eyes on the status field. The coupling was found by live testing, not code review;
I think the fix needs to be validated the same way it was found. Worth noting this epic sits
directly on top of `fix-startrun-heimdall-routing`, which already fixed a separate, blocking
bug in `startRun`'s Heimdall routing — that's *why* the PoC is even attemptable now. If it
fails, the first question has to be "which of the two fixes is actually broken," not an
assumption that this epic's rip-out is automatically the culprit.

---

## §2. What I Found

The research brief is thorough here so I'm not going to re-derive it, just organize it the way
I think about it — two structurally different coupling shapes, treated differently below.

**Shape one: core-woven, Consus-only.** Lives in exactly three files — `src/dispatch.ts`,
`src/kickoff-engine.ts`, `src/run-manager.ts` — zero Multica presence in any of them.
`dispatch.ts` registers four Consus ABI methods (`pollConsusAnswers`,
`pollAndResumeConsusAnswers`, `resumeFromConsusAnswer`, `resumeAnsweredConsusDecision`)
alongside the eight provider-neutral ones (`capabilities, startRun, getRunStatus, listRuns,
getQuestions, submitAnswers, getOutput, abortRun`) — bad, but at least opt-in. (Aside:
`research-brief.md` line 37 miscounts this same list as "seven" despite listing all eight items;
this doc inherited that error and is correcting it here rather than re-editing the brief.)
The genuinely
disqualifying finding is in `kickoff-engine.ts`: `recordTurn()`, which runs on *every single*
`startRun` and `submitAnswers` call, unconditionally awaits
`postQuestionToConsusDecisionApi()`. No flag, no opt-in. On a truthy response the turn's status
flips to `"awaiting-consus"` and the question gets stamped with a `consus_question_id` — this
is the one that bit us live, 20 tests flaky because status stopped being `waiting_on_human`
depending on network reachability nobody controlled. `run-manager.ts` is downstream of that:
`RunStatus` includes `"awaiting-consus"`, `Question` carries an optional `consus_question_id`.

**Shape two: adapter-confined, both Consus and Multica.** `src/plan-runner.ts` and
`bin/minerva-plan.ts`. Mostly already doing the right thing — `pollConsusForAnswers` is a real
opt-in flag on `PlanRequest`, Multica shell-out is behind `_multicaRunner`/
`__setMulticaRunnerForTest`, a real DI seam with test coverage. But one block at the tail of
`runHeadlessPlan` surfaces every pending question to Consus's `/api/questions` unconditionally,
bypassing `pollConsusForAnswers` entirely — the module *looks* cleanly gated and isn't, quite.
Needs closing, not deleting; the flag-respecting parts are fine, and "adapter-confined" isn't a
euphemism for "safe to ignore" — it's the same shape of bug as `kickoff-engine.ts`'s call, in a
file that otherwise behaves.

Behind both sit four dedicated modules — `consus-decisions.ts`, `consus-poller.ts`,
`consus-resume.ts`, `consus-auto-resume.ts` — that exist purely to talk to Consus, and (in
`consus-resume.ts`'s case) also contain a second, independent Multica CLI shell-out duplicating
`plan-runner.ts`'s implementation near-verbatim. `consus-poller.ts` imports
`extractAnswerFromItem` from `consus-resume.ts`, so these are one unit with an internal
dependency edge, not four independent deletion targets.

Two standalone binaries sit outside both shapes, neither imported by `dispatch.ts`.
`bin/minerva.ts` — the core CLI, AD-1's "entire external surface" — imports all four Consus
modules directly and bakes `--poll-consus`, `--poll-and-resume`, `--consus-item-file`, and
`--file-to-multica` into its argument parser, with help text advertising "Consus resume
shorthand." That's inside AD-1's core surface, so in scope regardless of how the binaries
question resolves. `bin/ideate-to-consus.mjs`, by contrast, is a 627-line self-contained script
importing nothing from `src/`, never touched by dispatch, and never calling Consus directly —
it goes through a Janus broker seam (port 8726, distinct from Consus's 8722). The one place in
this codebase where Consus access is already behind an abstraction, worth noting as a pattern,
though this file has zero test coverage.

The test suite mirrors these shapes closely. Four dedicated `consus-*.test.ts` files delete
cleanly alongside their modules. `full-loop.test.ts` and `e2e-auto-resume.test.ts` have real
behavioral teeth — park/post/poll/answer/resume assertions, not just "this module exists" — so
need real rewrites, not mechanical strips. `types.test.ts`'s exhaustive `RunStatus` switch and
`bin/minerva.test.ts`'s ABI-registration assertion are narrow tests that'll fail loudly or need
inversion. `plan-runner.test.ts` is already in good shape, exercising Multica-filing entirely
through `__setMulticaRunnerForTest`, no real subprocess or network call.

One dominant pattern is worth naming, because it explains why the flakiness was silent: every
direct Consus call uses a short timeout (750ms) and swallows every error — fail-soft but
unconditional, "Consus unreachable, proceed as if not posted." Sounds responsible, but it's
exactly what makes the coupling hard to notice: nothing throws, a status field just quietly
comes back different depending on reachability. This codebase already has a working
counter-example for how an *optional* dependency should behave instead:
`agnostic-plan-driver.ts`'s Heimdall lookup, "BULLETPROOF CLAUDE FALLBACK... returns null on
ANY doubt" — it returns null and the caller proceeds as if the thing never existed, no enum
flip. If anything Consus-shaped survives this epic (§3(d), a little does), that's the template
to hold it to, not fail-soft-but-unconditional.

Last thing before the plan: there's real doc/code drift already present, independent of this
epic. `docs/architecture.md`'s Data Model table never lists `awaiting-consus` as a `Run.status`
value even though the code has had it all along, while its API Contract table *documents*
`pollConsusAnswers`/`pollAndResumeConsusAnswers` as real methods. `README.md`'s diagram already
omits all four. `VISION.md` describes wiring the decision surface as *future* work,
contradicted by `kickoff-engine.ts` doing it unconditionally today. None of this drift is
caused by this epic — flagging it so nobody blames this epic's diff for inconsistencies that
predate it.

---

## §3. My Proposed Approach

Breaking this into concrete sub-decisions, roughly in the order I'd actually do the work.

**(a) Core rip-out — mandatory, not really up for debate.** Remove the four Consus method
registrations from `dispatch.ts`'s handler map. Remove `kickoff-engine.ts`'s call to
`postQuestionToConsusDecisionApi` from `recordTurn()` *entirely* — not gate it, delete the call
and the branch that flips status on it. "Just gate it" is the wrong answer even though it's the
smaller diff: the v1 requirement isn't "Consus calls are optional," it's "zero dependency on
Consus existing." A flag defaulting to off still leaves the code path, the import, and the
conceptual coupling in the core turn-recording function for the next engineer to inherit and
preserve. Deleting it means `recordTurn()` goes back to doing one thing: recording the turn.
Remove `"awaiting-consus"` from `RunStatus` and `consus_question_id` from `Question` in
`run-manager.ts`. Delete all four dedicated `consus-*.ts` modules and their four test files as
one atomic unit, respecting the `consus-poller.ts` → `consus-resume.ts` import dependency —
never delete `consus-resume.ts` first and leave `consus-poller.ts` with a dangling import.

**(b) `plan-runner.ts`'s unconditional "surface to Consus" block.** Same treatment as
`kickoff-engine.ts` — it isn't behind `pollConsusForAnswers` today even though it looks like it
should be, so gating it would fix a bug that no longer needs fixing once the underlying Consus
HTTP surface is gone. Just delete the block, and the `pollConsusForAnswers`-gated poll loop
with it — if the dedicated modules it polled against don't exist, there's nothing left to poll,
and a flag that silently no-ops is worse than no flag at all (the exact failure mode in the
risk about `bin/minerva-plan.ts` below).

**(c) `bin/minerva.ts`'s baked-in Consus CLI flags.** Remove `--poll-consus`,
`--poll-and-resume`, `--consus-item-file` from `mainArgs()` along with the direct Consus
imports. This has to be a clean removal, not just an internally-clean one with a
Consus-flavored CLI surface left dangling — it would be easy to do (a) and leave the flags as
dead code paths that error out. But then the binary is still advertising "Consus resume
shorthand" in its own `--help` output while those flags are landmines. AD-1 calls
`bin/minerva.ts` "the entire external surface" — if that surface still *talks about* Consus,
Minerva isn't standalone, it's standalone with a confusing CLI. Help text changes too:
`"JSON-over-stdio by default, plus Consus resume shorthand"` becomes just `"JSON-over-stdio"`.
`--file-to-multica` stays — opt-in, flag-gated, doesn't fire unless asked, which is the
standard the v1 requirement actually sets.

**(d) The two standalone binaries — taking a real stance, and NOT the same stance for both.**
I initially reached for one test to cover both binaries — "not imported by `dispatch.ts`" — and
that was wrong. On reflection (and after this got pushed on directly), that test is a
necessary condition for standing outside the core ABI, but it isn't sufficient to answer the
operator's actual question, and the operator's own words say why: "if it requires all of the
others to do anything, then it is a process piece or a flag in the pantheon itself." That's a
*purpose* test, not an import-graph test. Applied honestly, per-binary, the two cases come out
differently:

- **`bin/minerva-plan.ts` passes the test and stays.** Its core function — plan an idea into an
  epic and stories — works with zero Consus/Multica involvement once (b)/(d)'s changes land.
  Multica filing is opt-in via `--file-to-multica`, off by default. It doesn't require another
  god to do anything; it requires one only if you ask it to. This one may legitimately remain a
  standalone tool, fixed per the `pollConsusForAnswers` forcing-function plan below.
- **`bin/ideate-to-consus.mjs` fails the test, and I was wrong to wave it through
  symmetrically.** Its own header docstring states its purpose is to "FILE them into CONSUS as
  a decision item" and "WAIT for the human to answer" via Consus/Janus, calling itself "the
  MISSING HALF of the Pantheon ideation loop (Consus)." That's not incidental integration —
  it's the entire reason the file exists. Its documented purpose cannot complete without a live
  Consus/Janus round-trip on the other end; by the operator's own phrasing, it "does anything"
  only in concert with a sibling god. Going through the Janus broker (port 8726) rather than
  Consus directly is a real, worth-noting abstraction pattern, but it doesn't change what the
  script is *for* — it's still a one-way pipe into a sibling god's decision surface, not a
  Minerva capability that happens to have an optional integration bolted on.

  The cleanest resolution of the operator's "full rip it out and apart" directive for this file
  would be relocating it out of this repo entirely — into Consus's or Janus's own repo, or a
  dedicated integration-tools location — since its purpose is Consus/Janus integration, not
  Minerva planning. But that's a repo-topology decision this epic can't make unilaterally; it
  touches at least one other god's repo and ownership, which is beyond what a single epic
  executing inside Minerva's own repo can decide on its own. Given that constraint, the
  epic's actual, achievable action is narrower but still real: leave `ideate-to-consus.mjs`'s
  code as-is — it's not part of Minerva's ABI, isn't imported by anything Minerva-core, and has
  zero test coverage regardless of what this epic does — but make its non-standalone nature
  explicit and impossible to miss. Concretely: add a header comment/note to the file itself
  (and update whatever doc references it, per (f)) stating plainly that this is a separate,
  optional, Consus/Janus-dependent integration utility that does NOT participate in, and is
  explicitly excluded from, Minerva's "genuinely standalone" claim. That's the opposite of the
  original draft's move, which left it ambiguously bundled into "Minerva is now standalone" by
  applying the same reasoning used for `minerva-plan.ts`. This is honest about what the epic can
  and can't achieve here: it doesn't relocate the file (out of scope), but it stops the repo
  from implicitly claiming a Consus-dependent script as evidence of standalone-ness.

"Genuinely standalone" should mean the *engine* doesn't require sibling gods to function, not
that the repo contains zero lines of code that know Consus or Multica exist — a repo shipping
zero optional integration tooling isn't more standalone, just less useful. But that framing
covers `bin/minerva-plan.ts`, not `bin/ideate-to-consus.mjs`: the former is Minerva capability
with an optional integration; the latter is a Consus/Janus integration with no Minerva
capability underneath it. Treating both as instances of the same "optional tool invoked
deliberately by name" pattern was the error — worth naming directly rather than quietly fixing,
since the original framing would have shipped a real gap between what this doc claims and what
the code actually is.

That said, `bin/minerva-plan.ts`'s carve-out has one loose end that needs closing here, not
punted:
`bin/minerva-plan.ts` hardcodes `pollConsusForAnswers: true` on every `runHeadlessPlan` call,
with no opt-out. Once (b) removes the underlying poll mechanism, this either fails to compile
(if the field is removed from `PlanRequest`) or silently no-ops (if left in the type but
ignored). I'd rather it fail to compile — a forcing function to fix the call site in the same
commit rather than discover the drift later. So: remove `pollConsusForAnswers` from
`PlanRequest` entirely as part of (b); that's a feature of doing (b) this way, not a side
effect to work around.

One fragility worth naming rather than silently trusting: this forcing function only works
today because `bin/minerva-plan.ts`'s call site passes a fresh object literal directly as the
argument to `runHeadlessPlan({...})` — that's what makes TypeScript's excess-property check
fire (verified via `tsc --noEmit --strict`). The same function already assigns other
request-shaping values (`targetRepoPath`, `declaredTarget`) to local variables before use; a
routine future refactor that builds the `runHeadlessPlan` argument through a variable first
would silently defeat the excess-property check, with no compiler signal that the safety net
had stopped working — turning tomorrow's "loud, fine" failure back into today's "quiet, bad"
one. This shouldn't be left as an implicit, untested assumption. My call: the story doing (b)/(d)
should add a one-line comment directly above the `runHeadlessPlan({...})` call in
`bin/minerva-plan.ts`, warning future editors not to extract the object literal into a variable
without preserving an equivalent check (a dedicated type-level regression test is the more
robust alternative but is more machinery than a one-off rip-out epic needs; the comment is the
cheaper, sufficient mitigation here).

**(e) Multica.** Structurally different — never appears in `dispatch.ts`, `kickoff-engine.ts`,
or `run-manager.ts`. Where it does appear it's already flag-gated or opt-in-only, which already
satisfies the letter of the v1 requirement ("no dependency on Multica existing," not "no code
may reference Multica"). The operator's directive was specifically about Consus; pulling
Multica consolidation in here would roughly double the surface area (three shell-out
implementations, no shared client module, one with zero test coverage) for a problem that isn't
the one that broke 20 tests. My call: leave it for a separate follow-up epic, flagged
explicitly in Open Questions rather than silently dropped. One exception — deleting
`consus-resume.ts` per (a) takes its duplicate `fileStoriesToMultica` implementation with it
"for free," quietly halving the duplication problem as a side effect.

One mechanical note worth carrying into (f): `capabilities()` returns only `{abi_version:
"1.0.0"}`, no method enumeration on the wire, so removing the four Consus dispatch methods
changes nothing any external caller observes there — but it also means `docs/architecture.md`'s
markdown table is the *only* place this contract is expressed anywhere. If we don't fix it,
it's the sole remaining record of a lie.

**(f) Doc-drift cleanup.** Scope pragmatically. Must-fix: `docs/architecture.md`'s API Contract
table (remove the two documented Consus methods) and `docs/minerva-dev-agent-instructions.md`
if it describes `--file-to-multica`/Multica workflows as primary — a live operator-facing
instruction set that becomes actively misleading if left stale. Also must-fix, new per the
revised (d): add the header comment/note to `bin/ideate-to-consus.mjs` itself stating it's a
separate, optional, Consus/Janus-dependent integration utility excluded from Minerva's
standalone claim, and check whether any doc referencing the file (this doc's own §2 "worth
noting as a pattern" framing included, plus anywhere else it's described alongside
`bin/minerva-plan.ts` as if the two were interchangeable) needs the same distinction made
explicit rather than implied. README.md's diagram already omits the Consus methods, low
priority beyond maybe the "Delphi / Consus" node label. VISION.md and
`.pHive/project-profile.yaml`'s "deferred to v2" language are now *more* true after this epic
than before — leave those alone, fixing drift that already points the right direction isn't
worth epic time. `.pHive/CONTEXT.md`'s "v1 is standalone" framing is also already correct.

Ordering, roughly: (a) first — the P0, direct cause of the 20-test flakiness. Then (b), same
category of bug, same "remove don't gate" reasoning. (a)'s module deletions, (b)'s poll-loop
removal, and (d)'s `PlanRequest` type change land in the same commit, so the type change
actually forces `bin/minerva-plan.ts`'s fix instead of leaving a silent no-op. (c) follows
immediately — cosmetic-but-important CLI cleanup with no functional dependency on the others.
(e) doesn't happen in this epic, by design. (f) trails everything, describing the actual end
state.

---

## §4. What Could Go Wrong

**High.** `bin/minerva-plan.ts`'s hardcoded `pollConsusForAnswers: true` is the sharpest edge
in this whole epic — it's a live call site, and if (b) and (d) aren't landed in the same
commit, we either break the build (loud, fine) or leave a field that's silently ignored (quiet,
bad — someone could ship code believing polling still happens). I covered the mitigation in
§3(d): make the type change force the call-site fix.

**High.** `types.test.ts` has an exhaustive `switch` over `RunStatus` at line 156. The moment
`"awaiting-consus"` is removed from the union without updating that switch in the same commit,
the build breaks — which is actually the *good* outcome (TypeScript catching us), but only if
whoever does the `run-manager.ts` change remembers to grep for this test first. I'd call this
out as a checklist item rather than trust it'll be caught incidentally.

**Medium.** Duplicate Multica-shell-out risk, per §3(e) — since we're deliberately not
consolidating the three implementations in this epic, whoever touches Multica logic next (in
`plan-runner.ts` or wherever `ideate-to-consus.mjs`'s copy lives) needs to know there isn't a
shared client module, so a fix in one place doesn't propagate to the others. This isn't a risk
this epic introduces, but it's a risk this epic's scoping decision explicitly declines to
close, so it should be visible.

**Medium.** `docs/minerva-dev-agent-instructions.md` describing a broken workflow if it's not
updated in lockstep with the CLI flag removal in §3(c)/(d). This is a live instruction set an
agent persona actually follows — if it says "run with `--file-to-multica`" as a primary mode
and that flag still exists (it does, per §3(c) — only the Consus flags are removed), this
specific risk is probably smaller than it first looks, but I'd still want someone to actually
read the doc end to end rather than assume it's fine because the flag survives.

**Medium.** `full-loop.test.ts` and `e2e-auto-resume.test.ts` both have real behavioral
assertions built around Consus (`consus.posts.length === 1`, a full
park→post→poll→answer→resume cycle) — these aren't mechanical strips, they need someone to
decide what they're testing *for* now that Consus is gone. `full-loop.test.ts` in particular is
probably testing something real (does the full loop still work end to end) that's worth
preserving with Consus-shaped assertions swapped for `waiting_on_human`-shaped ones, not just
deleted.

**Low.** Zero test coverage for `ideate-to-consus.mjs` — per the revised §3(d), this epic does
touch the file now (a header comment/note documenting it as a separate, Consus/Janus-dependent
integration utility, explicitly excluded from Minerva's standalone claim), but that's a
doc-only, no-logic-change edit, so the zero-coverage gap doesn't get exercised by it. Worth
keeping the change scoped strictly to the comment for exactly this reason — any behavioral
change here would ship with no regression backing at all.

**Low.** `kickoff-engine.test.ts` line 344 currently sets `MINERVA_CONSUS_DECISIONS_URL: ""`
specifically to work around the exact bug this epic fixes. Once the unconditional call is gone,
that env var setting becomes meaningless — not harmful, just leftover. Worth a cleanup pass but
not a correctness risk.

---

## §5. Dependencies and Constraints

The governing constraint for this entire epic is the pre-existing, already-approved v1
requirement in `docs/product-brief.md` and `docs/initial-info.md`: zero dependency on
Delphi/Auriga/Vulcan/Multica/votem existing. Everything in §3 is compliance restoration against
a requirement that was signed off before this branch existed — this isn't new policy being
invented mid-epic, and I don't think there's room for the implementation to negotiate around
it.

`consus-poller.ts`'s import of `extractAnswerFromItem` from `consus-resume.ts` means deletion
order matters — these two modules have to come out together, in the same commit, not sequenced
across two PRs where one temporarily has a dangling import.

AD-5's stall invariant (no timeout, resume-from-disk IS pause/resume) and the "No Autonomous
Progress" guarantee are the two things in this codebase that must survive this epic completely
untouched. They're the generic mechanism underneath the Consus-specific enum value we're
deleting — `awaiting-consus` sits on top of `waiting_on_human`, not underneath it, so removing
the former should be a pure subtraction that never requires reinventing park-and-wait. If any
part of the implementation touches how `waiting_on_human` itself works, that's a sign the scope
has drifted past what this epic is supposed to do.

`bin/minerva.ts` is AD-1's single external CLI surface — any change to its flag set is a change
to a documented, currently-live external contract, not just an internal refactor. That's the
dependency that makes §3(c) more than a mechanical deletion.

`docs/architecture.md`'s API Contract table is the closest thing this repo has to a formal spec
for the two documented Consus ABI methods (`pollConsusAnswers`, `pollAndResumeConsusAnswers`) —
removing the methods without updating that table turns "undocumented but working" drift into
"documented but broken" drift, which is strictly worse for the next person who reads the doc
and tries to call a method that returns `UNKNOWN_METHOD`.

Triage item `t-002` already carries the operator's directive and the stated PoC acceptance bar
(re-run the `minerva-value-audit` pause/resume PoC against the ripped-out code plus the
`fix-startrun-heimdall-routing` fixes) — that's an existing constraint on Definition of Done,
not something this doc is introducing fresh.

`test-cli.ts`'s `mockHeimdallServer()` is entirely Consus-independent and stays regardless of
this epic's scope; `mockConsusServer()` goes away, but only once every test importing it
(`full-loop.test.ts` chief among them) is migrated off it first — the same deletion-order
sequencing concern as `consus-poller.ts`/`consus-resume.ts`, just at the test-infra layer.

One constraint that cuts the other way, worth stating plainly so nobody over-corrects:
`run-manager.ts`'s `defaultSeedRepoPath()` returning `~/repos/consus-seeds` is a *different*
"Consus" — a seed-repo naming convention, not the service — and it's explicitly out of scope
here, already tracked as separate test-hygiene work under `minerva-value-audit`. Don't let
"grep for consus and delete everything" sweep this one up by accident; it's not part of this
epic's blast radius even though it'll show up in any naive search.

---

## §6. Open Questions

1. **Does the "decision surface" concept get excised entirely, or does it get re-homed behind a
   formal v2 contract?** `.pHive/CONTEXT.md`'s existing convention is "every god-integration is
   v2, each behind a contract, v1 is standalone" — that reads as "behind a contract," not
   "doesn't exist." I've argued in §3(a) for outright deletion of the four dedicated modules
   because nothing today calls them outside of the coupling we're removing, but if there's a
   near-term plan to actually build the v2 contract, it might be worth preserving the *shape*
   of a seam (the way `agnostic-plan-driver.ts`'s fail-open Heimdall pattern does) even while
   deleting the Consus-specific implementation behind it. I don't think this blocks starting
   the rip-out, but it should be resolved before anyone starts designing what a v2 Delphi
   contract looks like, so they're not reverse-engineering it from the deleted code.

2. **Should this epic also consolidate the three duplicate Multica-shell-out implementations,
   or is that legitimately separate scope?** I took a position in §3(e) — leave it separate —
   but I want to flag this explicitly as a place where a reasonable planner could disagree with
   me. The argument for pulling it in now: while we're already touching `plan-runner.ts` and
   deleting `consus-resume.ts`'s duplicate copy, the marginal cost of also fixing
   `ideate-to-consus.mjs`'s third copy might be smaller than doing it as a fully separate epic
   later. The argument against: `ideate-to-consus.mjs` has zero test coverage, and that's a
   real reason to *not* touch it opportunistically inside a rip-out epic that's trying to be
   surgical.

3. **Is `bin/minerva-plan.ts`'s hardcoded `pollConsusForAnswers` flag actually going to be a
   compile break or a silent no-op, and does the team have a preference?** I've argued for
   making it a compile break (delete the field from the type) specifically because it forces
   the fix, but if there's a reason to prefer graceful degradation over a build failure at a
   specific integration boundary (e.g., if Auriga has its own copy of a `PlanRequest`-shaped
   type calling into this), that changes the mechanics slightly even though the outcome (flag
   goes away) is the same.

4. **Does "move behind a v2 contract" vs. "delete outright" apply differently to the Consus
   decision-surface concept than to the Multica shell-out concept?** These aren't the same kind
   of coupling — Consus is a status-mutating side effect on the core turn path, Multica is an
   execution-dispatch mechanism that's always been opt-in. It's possible the right answer is
   "delete Consus outright, preserve a Multica extension seam" rather than treating them
   identically. Worth deciding explicitly rather than defaulting to symmetry.

5. **What should `full-loop.test.ts` and `e2e-auto-resume.test.ts` assert once rewritten?**
   I've said these need real rewrites, not deletions, since they cover genuine end-to-end
   behavior — but whether that means the same test shape (park, do something out-of-band,
   resume) with `mockConsusServer()` swapped for a direct `submitAnswers` call, or a simpler
   test that makes the old scaffolding unnecessary entirely, is worth a few minutes of explicit
   thought during implementation rather than a mechanical find-and-replace.

---

## §7. Verification Strategy

```
VERIFICATION PLAN

Automated:
1. Delete the four consus-*.test.ts files alongside their modules (single atomic commit,
   respecting the consus-poller.ts -> consus-resume.ts dependency order).
2. Update src/types.test.ts's exhaustive RunStatus switch to drop the "awaiting-consus"
   branch in the SAME commit that removes it from run-manager.ts -- do not let these land
   as separate commits, the build will not compile in between.
3. Update src/kickoff-engine.test.ts (drop the MINERVA_CONSUS_DECISIONS_URL: "" workaround
   at line 344 -- it becomes meaningless once the call it was working around is deleted).
4. Rewrite (not delete outright) src/full-loop.test.ts and src/e2e-auto-resume.test.ts --
   both assert real end-to-end behavior (park -> post -> poll -> answer -> resume,
   consus.posts.length === 1) that needs Consus-shaped assertions swapped for
   waiting_on_human-shaped ones, since the underlying capability (does a run actually
   pause and resume) is still something we want covered.
5. Update bin/minerva.test.ts -- invert or delete the test asserting
   pollAndResumeConsusAnswers is a registered ABI method.
6. Update bin/minerva-plan.ts's call site once PlanRequest drops pollConsusForAnswers
   (per S3(d)) -- this should surface as a compile error if sequenced correctly, treat
   a clean compile here as a checkpoint, not an assumption. Add the one-line comment
   above the runHeadlessPlan({...}) call warning future editors not to extract the
   object literal into a variable (the forcing-function fragility noted in S3(d)/S4).
7. Add the header comment/note to bin/ideate-to-consus.mjs (per S3(d)/S3(f)) stating it's
   a separate, optional, Consus/Janus-dependent integration utility excluded from
   Minerva's standalone claim -- doc-only, no logic change, keep it scoped that way.
8. Full test suite green, full typecheck green, before calling any of this done.
9. Grep the repo for "consus" (case-insensitive) post-rip-out as a blunt sanity check --
   expected surviving hits: bin/ideate-to-consus.mjs (kept per S3(d) but now carrying an
   explicit non-standalone header note; Janus-brokered doesn't make it standalone, just
   indirect), docs mentioning it historically/in VISION.md's future-work framing, and
   nothing else.

Live PoC (operator's explicit ask -- this is the actual Definition of Done gate, not
the automated suite):
10. Re-run this session's earlier live pause/resume test: fire a real startRun via
    bin/minerva.ts's ABI, drive it to a real question, answer it from a SEPARATE
    process/session (not the same in-process call), and confirm resume works end to end.
11. Confirm run status is waiting_on_human at the pause point -- never awaiting-consus --
    even with a real Consus service reachable on the host, the same condition that broke
    20 tests before this epic. This is the single most important assertion in the whole
    epic: it directly falsifies or confirms the claim that Consus was never load-bearing.
12. Confirm this now succeeds where it previously would have been blocked or flaky,
    specifically because fix-startrun-heimdall-routing's Heimdall fixes are already
    in place on this branch -- the PoC was blocked on that epic, not on this one, until now.
13. Use the triage t-002 acceptance bar as the literal exit criterion: re-run the
    minerva-value-audit pause/resume PoC against the ripped-out code plus the
    fix-startrun-heimdall-routing fixes, and only close this epic once both pass together.
```

---

## §8. Scale Assessment

```
SCALE ASSESSMENT

Call: Medium-to-Large, leaning Large because of the doc and test surface, not the
core code surface.

Source files touched directly: src/dispatch.ts, src/kickoff-engine.ts,
src/run-manager.ts, src/plan-runner.ts, bin/minerva.ts, bin/minerva-plan.ts,
bin/ideate-to-consus.mjs (header-comment-only, per the revised S3(d)), plus
four full module deletions (src/consus-decisions.ts, src/consus-poller.ts,
src/consus-resume.ts, src/consus-auto-resume.ts). That's ~11 source files touched
or removed outright -- past the "small, contained fix" line on file count alone.

Test files touched: four dedicated *.test.ts deletions, plus real rewrites (not
mechanical strips) of src/full-loop.test.ts and src/e2e-auto-resume.test.ts, plus
edits to src/types.test.ts, src/kickoff-engine.test.ts, and bin/minerva.test.ts.
The rewrites are the part that keeps this from being a one-afternoon mechanical
deletion -- two of these tests assert real end-to-end behavior that has to be
re-thought, not just have Consus references stripped out.

Docs touched: docs/architecture.md (API Contract table, must-fix) and
docs/minerva-dev-agent-instructions.md (must-fix, live operator instruction set)
at minimum; README.md/VISION.md/.pHive/CONTEXT.md/.pHive/project-profile.yaml
reviewed but mostly left alone per S3(f) since they already describe the correct
end state or are low-stakes drift predating this epic.

Design judgment already resolved by S3: the two structurally hard calls --
(1) do the standalone binaries count as core, (2) is Multica in scope -- both got
real answers in this doc, and (1)'s answer is NOT symmetric across the two binaries.
Applying the operator's own "process piece or a flag" test per-binary rather than
to "the standalone binaries" as a category: bin/minerva-plan.ts stays as a genuine
standalone tool (its core function needs no sibling god); bin/ideate-to-consus.mjs's
entire purpose is a Consus/Janus round-trip, so it stays in-repo only because
relocating it is a repo-topology call beyond this epic's authority, and it now
carries an explicit header note excluding it from Minerva's standalone claim rather
than being left ambiguously bundled into it. Multica stays out, as a separate
follow-up candidate. What's left open (S6) is narrower: the v2-contract-vs-delete-
outright question for the decision-surface concept, and whether Multica
consolidation should ride along. Neither open question blocks starting the
mandatory core rip-out in S3(a)-(c).

Risk concentration: one file (bin/minerva-plan.ts's hardcoded
pollConsusForAnswers: true) carries disproportionate blast radius for its size --
a single hardcoded boolean is the difference between a clean compile-time forcing
function and a silent no-op reaching a live caller.

This is bigger than a single focused bugfix but it's also not multiple epics --
the two coupling shapes are different enough to reason about separately in S3
but small enough, and interdependent enough (both block the same PoC), to land
as one coherent unit of work with one Definition of Done.

SCOPE_CLASS: single-epic
```
