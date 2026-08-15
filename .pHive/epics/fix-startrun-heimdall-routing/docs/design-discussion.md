# Design Discussion: Fix Minerva's `startRun` (Heimdall Routing Failure Chain)

**Epic:** `fix-startrun-heimdall-routing`

```
NORTH STAR
Goal: Enable the idea -> plan -> ticket-decomposition -> Multica-execution pipeline to run fully async under agentic harnesses -- Minerva drives any Hive command headlessly (pause at a question, forward it out, resume from an answer). This epic exists because that entire premise was found to be unverifiable: startRun itself doesn't complete in a stock environment.
Audience: Human operator + other Pantheon services (Auriga-style routing). Minerva itself must stay harness/UI-agnostic.
Scale: Low concurrency per instance, but must support many parallel Minerva instances (one per repo / one per idea-intake session).
Pain points: Prior --resume-based approaches hit real production issues -- the fix in progress is making plugin-hive itself runner-agnostic, and separately Minerva's own agnostic-plan-driver already established a fail-open pattern for planning routes. Neither of those fixed startRun's own routing call, which this epic addresses.
```

---

## 1. What Are We Doing?

We're fixing a real, live-tested, reproducible break in Minerva's most basic ABI method. This
isn't a research epic — the prior epic in this lineage was about establishing whether the async
pipeline premise even held up, and it did the job of surfacing this. This one is different in
kind: we already know exactly what's broken, we have file/line citations for all four defects, and
two independent live black-box runs confirmed the failure chain against a real Heimdall instance.
The job now is to design the fix, not discover the problem.

Four defects, coupled into one failure chain: `resolveRuntimeRoute()` isn't fail-open, so any
Heimdall hiccup throws straight through; the hardcoded `task-type=kickoff` value is invalid
against Heimdall's real API (`planning`/`build`/`review` only); `dispatch.ts`'s catch-all relabels
every handler-thrown error as `UNKNOWN_METHOD`, so an operator staring at logs can't tell "bad
method name" from "Heimdall is down"; and because `allocateRun()` durably writes the run record
and stands up the workspace before the first drive turn runs, every one of these failures leaves
an orphaned run sitting at `status: "in_progress"` forever with no ledger trail.

I want to be upfront that fixing all four mechanically doesn't fully unblock a live run today —
see §5. But that's a deployment/config fact about this specific Heimdall instance, not a reason to
scope this epic down. The four defects are genuinely Minerva's to fix regardless of what
Heimdall's lane status says on any given day, and getting them right is what makes the pipeline
testable once the environment catches up.

There is one real embedded design decision here — not four independent bug tickets. That's what §3
is for.

## 2. What I Found

**What Heimdall actually is, first.** This doc uses "Heimdall" as an established routing service,
but it isn't one of the four sibling gods `.pHive/CONTEXT.md`'s Terminology lists (Auriga, Vulcan,
Delphi, Multica), and the North Star above hedges with "Auriga-style routing" instead of naming it
directly — worth resolving, not leaving implicit. Heimdall is confirmed to be its own real,
standalone Pantheon service, a sibling repo (`pantheon/heimdall`), not a rename or subsystem of
Auriga. Its own README: *"The health-aware lane gateway for Pantheon. Heimdall watches every
LLM/runtime lane — a provider × account × runtime triple like claude@mathew.dostal, codex, or
gemini-3-pro — reports whether each one is up, down, out of credit, or degraded, and actuates on
that signal... Today Heimdall is the gateway plus advisory-router half of that vision: it senses
lane health across 6 providers, actuates by toggling Multica agent concurrency, keeps each
installation's own live model catalog."* So it's a distinct, real component — a lane-health-aware
advisory router sitting below/alongside Auriga — and CONTEXT.md's god list omitting it is a
doc-staleness gap (the same kind this session already caught with Consus, renamed from Delphi),
not evidence it's unofficial here. That's a real follow-up, but a documentation correction to
Pantheon's shared vocabulary substrate, not a code fix — flagged here, deliberately **left out of
this epic's story scope**.

**Does the "behind a contract" convention apply to `driver.ts`'s Heimdall calls?** CONTEXT.md's
v1/v2 Terminology convention says a not-yet-built god's callers live "behind a contract, so it
swaps in cleanly once that god exists." Heimdall *does* exist, but `driver.ts`'s calls to it
(`resolveRuntimeRoute()`, `availableRouteUrl()`) are direct, unwrapped `fetch()` calls, not calls
through any contract/interface layer Minerva defines and could swap an implementation behind — the
same is true of the sibling `resolvePlanningRoute()` in `agnostic-plan-driver.ts`. This epic's fix
modifies `resolveRuntimeRoute()` in place — a typed error, an optional operator-declared fallback —
without introducing any such abstraction layer. My position: that's acceptable in-scope simplicity
for a bug-fix epic, not a gap this epic needs to close. Wrapping Heimdall access behind a contract
is a real architectural investment (an interface, a second implementation or seam to justify it, a
place to put it), and none of this epic's four defects stem from Heimdall being unwrapped — they
stem from missing error handling and a bad literal, both fixable in place. But it's worth flagging
rather than silently absorbing: leaving these calls unwrapped means a future need to substitute a
mock, a different transport, or multiple Heimdall-like backends will have to introduce that seam
from scratch, retrofitted onto call sites this epic is about to touch anyway. I'd record this as
acknowledged architectural debt worth a line in a future epic's backlog, not as work this epic
should take on now.

The core defect: `resolveRuntimeRoute()` (`src/driver.ts:153-178`) throws on any fetch failure,
non-2xx, non-JSON, or missing-field payload, with no try/catch anywhere between it and the ABI
caller. `SpawnDriver.runTurn()` calls it unguarded at `driver.ts:595` — that's the default-driver
exposure the requirement names directly.

But it's not just `SpawnDriver`. `SubagentDriver.runTurn()` calls the identical unguarded
`resolveRuntimeRoute()` at `driver.ts:670`, and `ForkedHiveDriver` calls it twice more, in
`dispatchFresh()` (`driver.ts:871`) and `classify()` (`driver.ts:949`). So
`MINERVA_DRIVER=subagent` and `MINERVA_DRIVER=forked` are exposed to the exact same failure mode
as the default `spawn` driver, not just incidentally similar to it — same function, same call
shape, same missing guard. On top of that, `submitAnswers()` (`kickoff-engine.ts:418`) calls
`runTurnResumable()` with `driverForRecord()`, which falls back to the same module-level default
`SpawnDriver` whenever a run wasn't routed through the agnostic planning driver — so a resume-turn
hits this identically to a first turn.

Task-type: `availableRouteUrl()` (`driver.ts:119-124`) hardcodes `task-type=kickoff` in the query
string. The live diagnostic corroborated against a running Heimdall instance that this returns
HTTP 400 `{"error":"invalid_task_type","allowed_task_types":["planning","build","review"]}`.
`kickoff` isn't even a candidate in Heimdall's own allowed list — this was never going to work,
Heimdall running or not.

Debuggability: `dispatch.ts` already has two structurally distinct branches — "no such method" at
lines 60-69, and "handler threw" at lines 71-85 — but the second branch coerces *any*
non-`MinervaError` exception to `{code: "UNKNOWN_METHOD"}` (`dispatch.ts:78-84`). `startRun` is
correctly dispatched and correctly recognized; it just throws inside its own handler. The two
cases are currently indistinguishable to a caller.

Orphan cleanup: `allocateRun()` (`run-manager.ts:281-330`) writes `run.yaml` with `status:
"in_progress"` and creates the workspace at line 309, before `startRun()` (`kickoff-engine.ts`)
even attempts the first turn at line 320 — no try/catch wraps that call. The fix-shaped mechanism
already exists and is unused here: `abortRun()`/`recordCleanup()` (`cleanup-ledger.ts:43-77`) does
exactly "transition to `aborted`, write one ledger record, emit one `cleanup_needed` event," and
is already idempotent on an already-terminal run.

Two things I want to flag before anyone reaches for the obvious fix. First,
`driver-route.test.ts:97-103` already has an `assert.rejects(...)` that asserts today's
throw-through behavior. This is not an "oops, nobody wrote a test" gap — someone deliberately
encoded fail-loud as the intended contract, and the codebase has a repeated house style of "fail
loudly, never guess" (`MINERVA_DRIVER`, `MINERVA_TURN_TIMEOUT_MS`, `MINERVA_TURN_RETRY_LIMIT` all
throw on bad input rather than defaulting). Any fix that changes this needs to consciously rewrite
that test, not just happen to pass or fail differently.

Second, there's a sibling that looks like a ready-made template:
`agnostic-plan-driver.ts:80-102`'s `resolvePlanningRoute()` is explicitly fail-open, with a doc
comment literally titled "BULLETPROOF CLAUDE FALLBACK" that returns `null` on any doubt. It calls
the same kind of endpoint, the same base-URL env resolution, even the same query shape
(`task-type=planning`, which is a *valid* Heimdall value, unlike `kickoff`). It's tempting to just
copy this pattern into `resolveRuntimeRoute()`. My take on why that's not obviously right is in
§3.

## 3. My Proposed Approach

**(a) What should `resolveRuntimeRoute()` do on failure?** I don't think straight fail-open is
right here, and I want to argue against it specifically rather than default to "copy the sibling
pattern." Planning's fallback is safe *because* the fallback target is safe: if Heimdall can't be
reached, `resolvePlanningRoute()` returns `null` and the caller silently keeps using the built-in
`claude` driver — Claude is always spawnable, so "fail open" really means "fail into a known-good
state Minerva itself decided was safe." `resolveRuntimeRoute()` has no such target: no documented
"if Heimdall is unreachable, spawn X with model Y" default anywhere in the Driver contract
(`driver.ts:191-198`), so *Minerva inventing one* would mean guessing a CLI/model pair with zero
evidence it's a safe choice for a live drive turn — risking either unintended infrastructure or,
worse, a false success while nothing real happens underneath.

But "no safe fallback target exists" and "no safe fallback target could ever be defined" are
different claims. This codebase already has a working precedent for the second kind:
`MINERVA_TURN_TIMEOUT_MS`/`MINERVA_TURN_RETRY_LIMIT` fail loudly on bad or absent input, but use
the operator's explicit value when present — not "guessing," because nothing is inferred, the
operator states a value and the code either honors it verbatim or rejects it. I'm revising my
recommendation to add that same shape: an optional `MINERVA_FALLBACK_CLI`/`MINERVA_FALLBACK_MODEL`
pair, unset by default. Unset, `resolveRuntimeRoute()` behaves exactly as fail-fast describes below
— a typed error, nothing guessed. If an operator has explicitly set *both*, a Heimdall failure
falls back to that declared pair instead of throwing; if only one is set, that's malformed config
and fails loudly the same way an invalid `MINERVA_TURN_TIMEOUT_MS` does, not silently ignored. This
is categorically different from copying `resolvePlanningRoute()` verbatim: planning's fallback
target is a value *Minerva* decided was universally safe; this one is a value the *operator*
decided was safe for their own deployment — the same authority relationship the timeout/retry-limit
precedent already establishes, not a new pattern invented for this epic.

So my recommendation, **locked for this epic** rather than left open pending outside input, is:
fail-fast is the default and only behavior when no fallback is configured — `resolveRuntimeRoute()`
keeps throwing on Heimdall failure, same as today at the boundary, but with a typed, recognizable
error (not an untyped `Error`) so the layers above can label it correctly instead of mislabeling it
as `UNKNOWN_METHOD`. When an operator has explicitly configured
`MINERVA_FALLBACK_CLI`/`MINERVA_FALLBACK_MODEL`, that declared pair is used instead. This satisfies
"fail loudly, never guess" in both branches — unset never substitutes anything, configured never
infers anything, only honors an explicit operator statement — respects the existing test's intent
(never really "fail-open is wrong," just today's exact throw shape, which still holds for the
unset-fallback default), and directly resolves what used to be Open Question 2 (§6): the "real safe
fallback runtime" that question asked about doesn't need to come from outside Minerva or wait on
Heimdall's owners, because the operator can declare it the same way they already declare timeout
and retry values. A future epic where Minerva itself ships a built-in default with no operator
declaration is a separate decision with its own justification, not something to smuggle in here.

**`getAdapter(cli)`'s silent fallback undermines the "used verbatim" framing above, and needs to be
part of (a)'s design.** `getAdapter()` (`driver.ts:583-591`) is a closed three-way switch —
`"opencode"` and `"codex"` map to their adapters, and *anything else*, including a typo or
unsupported value, silently falls through to `ClaudeAdapter`. If an operator sets
`MINERVA_FALLBACK_CLI` to anything other than exactly `opencode`, `codex`, or `claude`, the
fallback path this section just designed doesn't fail loudly the way the rest of it promises — it
silently hands back `ClaudeAdapter`, which formats args assuming Claude's flag surface, and would
spawn the wrong binary with the wrong argument shape while looking like it worked. This is a
concrete, decidable addition to (a)'s design, not a new open question: **validate
`MINERVA_FALLBACK_CLI` against `getAdapter`'s known CLI set (`opencode`/`codex`/`claude`) at
config-read time, and fail loudly on an unrecognized value**, the same way an invalid
`MINERVA_TURN_TIMEOUT_MS` fails loudly today. I'm picking that over the alternative — changing
`getAdapter()` itself to throw on an unrecognized CLI — because `getAdapter()` is an existing,
shared function with callers beyond this new fallback path; changing its default behavior touches
all of them and is a bigger, less-contained blast radius than validating one new env var at the
single new call site that reads it. The fix belongs at the boundary where the new config is read,
not inside a general-purpose helper that predates this epic.

**(b) Scope: all three drivers + `submitAnswers`, or just `SpawnDriver`/`startRun`?** The
requirement text names `startRun (default SpawnDriver)` specifically, but I think scoping the fix
to just that call site would be a mistake, and I'd push back on reading the requirement that
literally. The unguarded call is the exact same function, called the exact same unguarded way,
from four call sites (`driver.ts:595`, `:670`, `:871`, `:949`) plus one more path (`submitAnswers`
via `driverForRecord()` falling back to the same default driver). If we fix
`SpawnDriver.runTurn()` only, `MINERVA_DRIVER=subagent`/`forked` and any resumed run stay exposed
to the identical bug we just spent this epic diagnosing — that's not a hypothetical edge case,
it's the same line of code reached from a different entry point. The actual fix — wrap the call,
throw a typed error instead of an untyped one — is small enough per call site that doing it once
(as close to `resolveRuntimeRoute()` itself as possible) covers all of them for free. I'd rather
fix it at the root and verify all four/five call sites inherit the fix than patch `SpawnDriver`
alone and leave a known gap on record. If there's a reason to explicitly defer
`subagent`/`forked`, that should be a stated tradeoff in the epic, not an accident of reading the
requirement narrowly.

This scope call is safe specifically *because* of what §3(a) resolved to, not independent of it —
worth stating explicitly rather than leaving the two decisions looking unrelated. A root-scoped
fail-fast-with-typed-error fix only changes error *classification* everywhere it lands, and a
root-scoped optional fallback only substitutes an *operator-declared* value everywhere — both
uniform, low/declared risk regardless of call-site count. Had §3(a) instead resolved to an
undeclared, Minerva-invented fail-open default, root-scoping this same way would propagate the
"masking 'no runtime available' as false success" risk (§4, High) to every driver and
`submitAnswers` simultaneously instead of containing it to one call site — a materially different
blast radius. Fix-at-the-root is right given §3(a)'s actual resolution, and would need
re-examination, not just re-application, if §3(a) were ever revisited toward an undeclared
fail-open default.

**(c) Debuggability fix — new `ErrorCode` vs. restructured dispatch response?** I'd add a new
`ErrorCode` value rather than restructure the `Response` type. `dispatch.ts` already has the two
branches split structurally (lines 60-69 vs. 71-85); the only thing missing is a code that means
"a recognized handler failed against an internal/upstream dependency," distinct from "no such
method." Something like `UPSTREAM_ERROR` or `INTERNAL_ERROR` added to the 5-value union in
`errors.ts:1-6`, with `dispatch.ts`'s handler-catch branch mapping any `MinervaError`-typed
routing failure (from part (a)) to that code, and falling back to `UNKNOWN_METHOD` only for
genuinely-uncaught unexpected exceptions if we want to be conservative about the blast radius of
this change. This is deliberately the smallest change that fixes the actual complaint — an
operator can now tell "bad method" from "Heimdall's down" — without touching the dispatch
architecture.

**(d) Orphaned-run cleanup — what should it do, and when?** Hook `startRun()` to call
`abortRun()`/`recordCleanup()` automatically when the first turn throws, wrapping the
`runTurnResumable()` call at `kickoff-engine.ts:320` in a try/catch that catches exactly this
failure and transitions the run to `aborted` before re-throwing (or before returning a structured
failure — see open question in §6 on whether `startRun` should still surface the error to the
caller after cleanup, which I believe it must, otherwise the caller never learns the run failed).
This is AD-4-compliant by construction since `abortRun`/`recordCleanup` only records and signals,
never deletes — the worktree `allocateWorktreeWorkspace` already created stays exactly where AD-4
says it should, for an external system to reap. I don't think this should be scoped narrower (e.g.
"just leave it for a human to call `abortRun` manually") — that's effectively not fixing the gap,
just documenting it, and the mechanism is already sitting there unused specifically for this kind
of situation.

This needs to be checked against AD-5 directly: AD-5 says the stall invariant has no timeout and a
held run must never auto-resolve into "a guessed or default answer." AD-5 governs a run that
reached `waiting_on_human` — a real, human-facing pause where a question exists and is sitting
unanswered. What this section handles is different in kind: an *orphan*, a run whose first turn
never got far enough to reach `waiting_on_human` or surface any question at all. There's no
human-facing state to preserve and no answer being guessed at — `aborted` here isn't standing in
for an answer, it's recording that the run's own attempt to start failed before question-asking
ever began. Transitioning an orphan to `aborted` doesn't auto-resolve a stall, because there was
never a stall to resolve.

That same distinction reconciles this against `docs/architecture.md`'s "No Autonomous Progress"
section and the API Contract table's description of `abortRun` as an "Explicit cleanup trigger"
(AD-4) — both describe a system where nothing advances a run except an explicit external call, and
auto-invoking `abortRun`/`recordCleanup()` from inside `startRun()` looks, on its face, like the
internal auto-advancement that principle rules out. But "No Autonomous Progress" is about a run
continuing to move *forward* on its own between calls — a component polling, waiting, or advancing
state without a caller asking it to, the failure mode `pollAndResumeConsusAnswers` is carefully
scoped to avoid. An orphaned run isn't progressing at all, and terminating it is not forward
motion; it happens synchronously inside the same `startRun()` call that failed, not on a later
autonomous tick — closer to `dispatch.ts` rejecting a call to an unrecognized method than to a
background process silently advancing state on its own schedule. That's a legitimate, narrow
exception to "explicit cleanup trigger," but it's an exception, and should be stated as one here
rather than left for an implementer to notice or miss.

## 4. What Could Go Wrong

**High: masking "no runtime available" as false success.** This is the reason I'm arguing against
straight fail-open in §3(a), and it's still the risk to guard even with the revised
optional-fallback recommendation: an implementer who skips validating that *both*
`MINERVA_FALLBACK_CLI`/`MINERVA_FALLBACK_MODEL` are present before using either could make
`resolveRuntimeRoute()` return a half-configured default silently, and a caller would see
`startRun` "succeed" against something never actually confirmed to work. That's strictly worse than
today's loud failure. This needs to be caught in review, not just in this doc.

**Medium: breaking `driver-route.test.ts:97-103` without updating it consciously.** The test
currently asserts throw-through as intentional. My proposed fix (typed error, still throws) should
keep this test mostly intact modulo the error shape, but if someone's fix instinct is "make it
fail-open," this test breaks and if it's just deleted or loosely patched to pass, the codebase
loses its only documented signal that this behavior was deliberate. Whoever implements needs to
touch this test with intent, and the story description should say so explicitly.

**Medium: accidentally widening or narrowing `runTurnResumable()`'s retry scope.** It retries only
`TurnTimeoutError` today (`kickoff-engine.ts:96`), with an explicit comment that everything else
propagates immediately, unchanged. If we introduce a new typed routing error and don't think
carefully about whether it should also extend `TurnTimeoutError` or be retried, we either
accidentally make routing failures retry (masking a real Heimdall outage as transient) or leave it
correctly excluded but need to say so on purpose rather than by omission. I lean toward explicitly
*not* retrying routing failures — a Heimdall 400 or connection refusal isn't going to fix itself
on a retry the way a slow turn timeout might — but this should be a stated decision in the story,
not an implicit side effect of the type hierarchy chosen.

**High: task-type guessing risk.** If the story picks a value among `planning`/`build`/`review`
without confirming it against Heimdall's actual contract, it doesn't fail loudly — it silently
misroutes into the wrong capacity/eligibility pool on Heimdall's side. That's a materially worse
failure mode than today's clean 400, because today's failure is at least legible; a
wrong-but-valid task-type would look like it's working. This is the one defect in the set where
"just ship something" is actively dangerous rather than merely incomplete. See §5/§6 — I think
this needs an answer from outside Minerva's own code before it's implemented.

**Low: partial-state cleanup touching an already-real worktree.** `allocateWorktreeWorkspace` may
have already created a git worktree by the time cleanup runs. `abortRun`/`recordCleanup` doesn't
touch the worktree at all (record + signal only), so this is low risk mechanically, but it's worth
calling out that the fix must resist the temptation to "helpfully" delete the half-created
worktree — that would violate AD-4 outright.

## 5. Dependencies and Constraints

**AD-4** (`cleanup-ledger.ts:1-5`): Minerva never deletes `workspace_path` or `state_path` itself
— record and signal only, external system does the reaping. Any orphan-cleanup design that reaches
for `rm -rf` or equivalent is out of bounds by standing decision, not by this epic's own judgment.

**The `ErrorCode` union is closed at 5 values today** (`errors.ts:1-6`: `NOT_FOUND`,
`VALIDATION_FAILED`, `WRONG_CHANNEL`, `NOT_READY`, `UNKNOWN_METHOD`). Adding a 6th is a real, if
small, API surface change — anything consuming Minerva's dispatch responses and pattern-matching
on the current 5 values should be checked for exhaustiveness assumptions.

**Even a fully correct fix does not unblock a live run in this environment today.** The
live-tested Heimdall instance reports the `claude@mathew.dostal` execution lane as `"down"` /
unconfigured. That's a Heimdall-side deployment/config gap, not a Minerva code defect, and it's
explicitly out of this epic's scope — worth stating plainly so nobody treats "the live re-test in
§7 still doesn't fully succeed end-to-end" as evidence the code fix failed.

**The correct Heimdall task-type value is a real external dependency, not a research gap.** None
of `planning`/`build`/`review` is self-evidently "the kickoff/drive-turn one" from Minerva's side
alone — `agnostic-plan-driver.ts` already claimed `planning` for its own turn kind, so it's
plausible but not certain that `startRun`'s turn maps to `build`. This needs to be confirmed
against Heimdall's actual contract or its owners before implementation locks in a value; guessing
here is the one place in this epic where "ship something reasonable" is worse than blocking on an
answer.

## 6. Open Questions

1. **What is the correct Heimdall task-type value for `startRun`'s drive turn?** `kickoff` is
confirmed invalid. `build` is my best guess by elimination (planning is taken, review implies an
already-produced artifact), but I want to flag this as a guess, not a finding — this should be
confirmed with Heimdall's API owners before it's hardcoded, given the misrouting risk in §4.

2. **~~Is fail-fast-with-a-typed-error the right call, or is there a real safe fallback runtime I'm
not aware of?~~ Resolved in §3(a), not left open.** The original framing assumed a safe fallback
had to be one Minerva itself could guess, or a pre-existing deploy convention I'd missed. §3(a)
reframes this: an operator-declared `MINERVA_FALLBACK_CLI`/`MINERVA_FALLBACK_MODEL` pair (unset by
default, fail-fast when absent, used verbatim when present) answers this from inside Minerva's own
config surface, on the same precedent as `MINERVA_TURN_TIMEOUT_MS`/`MINERVA_TURN_RETRY_LIMIT`. No
outside confirmation needed for this one — Open Question 1 (task-type) remains the genuinely
external question.

3. **Is there an ADR or story doc explaining why `resolveRuntimeRoute()` was made non-fail-open
while `resolvePlanningRoute()` was made fail-open?** `driver-route.test.ts:97-103` confirms it's
tested and intentional, but nothing in `driver.ts` explains *why* the two diverge. Worth a check
of `docs/architecture.md` and prior epic/story notes before this epic overrides or reaffirms that
divergence — if a prior decision already reasoned through this exact question, we should cite it
rather than re-derive it.

4. **Should `startRun` still return a failure to its ABI caller after running automatic cleanup,
or does successful cleanup change what gets surfaced?** I've assumed yes (cleanup is a side
effect, not a way to swallow the original error) but this should be an explicit decision in the
story, not implicit in whoever writes the try/catch.

5. **Are `SubagentDriver`/`ForkedHiveDriver`/`submitAnswers` genuinely in scope for this epic, or
deliberately deferred?** I've argued for "in scope, fix at the root" in §3(b). If the epic owner
disagrees and wants to scope strictly to the literal requirement text, that's a legitimate call,
but I'd want it stated as a conscious tradeoff with the known gap left on record, not discovered
later as an oversight.

6. **Does the new `ErrorCode` value need any downstream consumer sign-off** — i.e. do other
Pantheon services (Auriga-style routers, per the North Star) pattern-match on Minerva's current
5-value `ErrorCode` union in a way that adding a 6th could break? Not established either way in
the research; worth a quick check before treating this as purely additive.

## 7. Verification Strategy

```
VERIFICATION PLAN
Unit / existing suite:
  - driver-route.test.ts:97-103 must be consciously rewritten (not left to incidentally pass/fail) to assert the NEW intended behavior of resolveRuntimeRoute() on Heimdall failure -- specifically, that it throws a typed/distinguishable error rather than a generic Error, per the §3(a) decision.
  - New test for resolveRuntimeRoute()'s optional MINERVA_FALLBACK_CLI/MINERVA_FALLBACK_MODEL path (§3a, locked decision): unset means throw the typed error (default, unchanged from above); only one of the pair set fails loudly the same way an invalid MINERVA_TURN_TIMEOUT_MS does today, not silently ignored; both set uses the declared pair instead of throwing on Heimdall failure.
  - New coverage needed for SubagentDriver.runTurn() and ForkedHiveDriver's dispatchFresh()/classify() exercising the identical Heimdall-failure path, if §3(b)'s "fix at the root, verify all call sites" scope is adopted -- confirming the fix at resolveRuntimeRoute() actually propagates correctly through all four/five call sites rather than assuming it by inspection.
  - New test for dispatch.ts's handler-catch branch distinguishing the new ErrorCode (routing/upstream failure) from real UNKNOWN_METHOD (unrecognized method name) -- both branches already exist structurally (dispatch.ts:60-69 vs 71-85), so this is a targeted addition, not new infrastructure.
  - New test for startRun's first-turn-failure path asserting abortRun()/recordCleanup() fires exactly once and the run transitions to "aborted" with a CleanupLedgerRecord + cleanup_needed event -- reusing cleanup-ledger.ts's existing idempotency guarantees rather than re-testing them.
  - Regression check on runTurnResumable() (kickoff-engine.ts:90-101) confirming the new routing-error type does NOT get swept into the TurnTimeoutError retry path, per the §4 medium risk.

Live / integration (secondary, environment-permitting):
  - Once task-type + fail-fast decisions land, re-run the same live black-box startRun invocation used in this epic's research (npx tsx bin/minerva.ts against dev) to confirm the first drive turn now gets PAST resolveRuntimeRoute() -- i.e. either a valid Heimdall route response, or a clean, correctly-labeled error instead of today's UNKNOWN_METHOD-mislabeled throw.
  - Full end-to-end success (an actual completed turn) is expected to still be blocked by the out-of-scope Heimdall claude@mathew.dostal lane status ("down") -- this is a known, accepted limit on what "verified" can mean for this epic, not a fix failure.
```

## 8. Scale Assessment

**Suggested story sequencing (TPM review).** The recommended split is four stories, not four
independent tickets: **S1** = fail-fast-by-default + operator fallback config (§3a, including the
`getAdapter` validation addition above) + root-scoping across all three drivers (§3b), as *one*
story — (b)'s root-scoping isn't separate work, it's inherited for free once (a) is fixed at
`resolveRuntimeRoute()` itself rather than at a single call site. **S2** = the new `ErrorCode` +
`dispatch.ts` debuggability fix (§3c), depends on S1 because it needs S1's typed error to exist
before it can be mapped. **S3** = auto-cleanup via `abortRun`/`recordCleanup` (§3d), also depends
on S1 — it needs S1's typed error to distinguish an orphan cleanly from other failures. **S4** =
the task-type value fix (§6 Q1), an independent/parallel track, externally blocked pending an
answer from Heimdall's owners.

Two escalations to track against this sequencing, neither resolved by this doc: (1) there's no
named owner or timeline yet for getting the task-type answer from Heimdall's owners (S4) — worth
flagging explicitly so it doesn't drift indefinitely without one; (2) whether the new `ErrorCode`'s
6th union value (S2) needs sign-off from downstream Pantheon consumers that pattern-match on the
current 5-value union is already Open Question 6 above — cross-referenced here, not re-litigated,
but worth the epic owner tracking against S2 specifically, since that's the story where it becomes
real.

```
SCALE ASSESSMENT
Files touched: src/driver.ts (resolveRuntimeRoute + 3 driver classes' call sites), src/dispatch.ts (catch-all branch), src/errors.ts (ErrorCode union), src/kickoff-engine.ts (startRun's first-turn wrapping + submitAnswers), src/run-manager.ts / src/cleanup-ledger.ts (wiring, not new mechanism), src/driver-route.test.ts (conscious rewrite) plus new tests across driver classes and dispatch.

Design decisions embedded: one real one -- fail-fast-by-default, with an optional operator-declared MINERVA_FALLBACK_CLI/MINERVA_FALLBACK_MODEL fallback, for resolveRuntimeRoute() (§3a). This is genuine architectural judgment, not a coin flip, and it's the crux of the whole epic -- but it is a decision this doc locks in, not one left open for implementation to re-litigate; the open question that used to gate it (§6 Q2) is resolved by the fallback-config reasoning in §3(a) itself, via the same precedent MINERVA_TURN_TIMEOUT_MS/MINERVA_TURN_RETRY_LIMIT already establish. The other three defects (task-type, debuggability, cleanup) are comparatively mechanical once the task-type value is confirmed externally (Open Question 1 -- still genuinely open, the only one of the six still gated on an outside party) and the error-handling shape from (a) is applied, since (b)/(c)/(d) all build on top of (a)'s decision.

Coupling: high internal coupling -- (b)'s scope call is contingent on (a) having resolved to fail-fast (see §3b), determining how many call sites (c)'s new ErrorCode needs to be threaded through, and (d)'s cleanup hook needs (a)'s typed error to know what to catch. These aren't four independent fixes landing in parallel; they're one fix with three riders that only make sense after the core decision in (a) is applied. That argues for keeping this as one epic rather than fragmenting into unrelated tickets, even though the individual code changes per file are each small.

External dependency and sizing risk: the task-type value (Open Question 1) is a hard blocker on truly finishing the mechanical portion of the fix with confidence -- implementation can proceed on (a)/(c)/(d) in parallel with that inquiry, but shouldn't hardcode a guessed task-type value without it being flagged as provisional. That's a distinct risk dimension from Small/Medium/Large sizing, worth naming explicitly: "Medium" assumes the task-type answer arrives on a timeline compatible with story sequencing. If confirmation stalls, scope doesn't grow -- no new files, no new mechanism -- but sequencing does: (b)'s call-site propagation ships fine without it, but the task-type story plus §7's live-integration step would hold at "implemented but blocked on confirmation" rather than close. Track that as a schedule risk on the task-type story specifically, not a reason to inflate Medium to Large.

Recommendation: Medium. Not Small -- §3(a) required real architectural reasoning (fail-open vs. fail-fast vs. operator-declared fallback) even though it's now a locked decision rather than an open one, and §3(b)'s scope call has real technical consequences contingent on that decision (see §3b). Not Large -- no new subsystems, no new mechanisms (cleanup-ledger already exists and just needs wiring), and the total file footprint is bounded and well-understood from the research brief's citations. This is a well-scoped bug-fix epic with one genuine architecture call embedded in it -- decompose into stories roughly along the four defects, sequenced so (a)'s decision lands before (b)/(c)/(d)'s implementation, with the task-type external dependency (§6.1) tracked as a story-blocking, sequencing-risk question rather than guessed around.

SCOPE_CLASS: single-epic
```
