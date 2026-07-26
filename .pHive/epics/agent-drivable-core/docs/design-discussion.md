# Design Discussion — epic `agent-drivable-core`

> **Revision note (round 1 grill, `docs/grill-record.md`):** every finding below is addressed
> inline rather than in a separate changelog — search for the bracketed tags `[V1]`/`[V2]`
> (vocabulary), `[H1..4]` (hidden assumptions), `[U1..3]` (unresolved tensions), `[C1]`
> (convention), `[P1]`/`[P2]` (posture) at the point each was resolved.

> **TEAM REVIEW SUMMARY (collaborative review gate, round 1):**
> - **Architect: flag.** Found a real concurrency bug in AD-3's worktree case (two runs against
>   the same `target_repo` can't both check out `dev`), flagged steps 3/4 as under-specified
>   coupling, flagged a self-grading bias risk in the classification mechanism, and flagged §7's
>   verification as covering parseability but not classification correctness. → **All four
>   addressed below**, tagged `[A1..4]`.
> - **TPM: approve-with-escalation.** Independently flagged the same steps 3/4 coupling, plus:
>   step 3 bundles spike-proven plumbing with unprototyped parsing risk (should split), the H/V
>   plan should timebox the risky work as a spike-with-checkpoint rather than point-estimate it
>   on faith, and a formal escalation that the AD-3 manual dry-run has no defined completion-gate
>   mechanism. → **Addressed below**, tagged `[T1..3]`; escalation logged to cycle state (see
>   note at end of §7).
> - This is the one revision cycle collaborative review allows — remaining open items are
>   captured as Open Questions (§6) or explicit H/V-phase commitments rather than further looping.

## 1. What Are We Doing?

We're building Minerva v1: a small standalone TS/Node CLI that lets a **driving agent** — the
term CONTEXT.md defines for this: an agent (Claude, or any other) that programmatically operates
a run — drive plugin-hive's `kickoff` + `plan` skills instead of a human doing it by hand. `[V2]`
Today, running kickoff+plan means SSHing into a box and babysitting a terminal, one idea at a
time. That's the whole problem statement — it doesn't scale to "I want to push five ideas
through planning at once, from different terminals, without watching any of them."

"Done" for v1 means: a driving agent can call `startRun` with an idea, poll `getQuestions`,
submit `submitAnswers`, and eventually get back an approved epic+stories via `getOutput` — with
a real human gate for anything strategic in the middle, not a rubber stamp. No Delphi, no
Multica, no Auriga wiring, no votem — all of that is v2, deliberately deferred so v1 doesn't get
stuck waiting on four other gods to exist first. **REQ-07 (the local CLI convenience wrapper) is
explicitly out of this epic's build scope** `[H2]` — see §3 note below.

## 2. What I Found

The unusual thing about this epic is that almost all of the hard thinking already happened
before I got here — `docs/initial-info.md` → `docs/prd.md` → `docs/architecture.md` is a
complete, already-approved chain, refined once already after a Delphi review
(`docs/decisions/kickoff-review.md`), and validated by a real PoC spike
(`docs/spike-plugin-hive-drivability-findings.md`). My job this round is closer to "turn an
approved architecture into stories" than "figure out what to build."

The one genuinely new finding from the spike changes how I think about the build: **plugin-hive
kickoff's `AskUserQuestion`-based gates don't exist headlessly.** Run `claude -p` against the
real kickoff skill and it doesn't error or hang — it just asks the same gate question as plain
Markdown prose and stops (`stop_reason: end_turn`). That's good news (nothing to fix, it
degrades on its own) but it does mean the Kickoff+Plan Engine needs a real
**question-extraction** step — parsing a question out of a prose turn — which `architecture.md`
now documents but wasn't in the original API contract.

Sibling-repo research (fresh this round, **not yet independently re-verified against a second
source** — flagging that explicitly `[H1]`) found a candidate pattern to copy instead of
inventing one: plugin-hive's own subprocess adapters (`hive/adapters/github/index.ts`,
`hive/adapters/multica/index.ts`) appear to speak close to the wire format AD-1 commits Minerva
to — `#!/usr/bin/env tsx` shebang, no build step, manual stdin chunk-concat + `JSON.parse`,
`process.stdout.write` + exit 0/1. Same caveat for pantheon-orchestrator's `tsconfig.json` /
`package.json` (ES2022, NodeNext, strict, `node:test` via `tsx --test`, no eslint/prettier
anywhere in the ecosystem). CONTEXT.md's canonical references only formally cite
`task-tracking-adapter-abi.md` and pantheon-orchestrator's architecture.md AD-4 — not these
specific adapter/config files — so I'm treating this as a **strong lead for the scaffold story
to confirm on contact**, not settled precedent to build blindly against.

## 3. My Proposed Approach

Vertically, in the order things become useful to build on:

1. **Project scaffold + `capabilities`** — `package.json` (`type: module`, `tsx`, `node:test`),
   `tsconfig.json` (matching pantheon-orchestrator's settings, pending the confirm-on-contact
   check above), `bin/minerva` entrypoint that reads one `{method, params}` envelope from stdin
   and dispatches. `capabilities` ships **here**, not at the end — `docs/architecture.md` frames
   it as the ABI's bootstrapping call and lists it first in the API Contract table; it's also
   nearly free to implement (a static version string), so there's no reason to defer it. `[P1]`
2. **Run Manager + two-case workspace allocation (AD-3)** — `startRun` needs to decide
   worktree-off-`dev` vs. fresh-`git init` based on whether `target_repo` was given, allocate
   the namespaced `.pHive` state dir, and write the initial `Run` record to disk. This is the
   foundation everything else reads/writes against.

   **Fixing a real concurrency bug the architect review caught** `[A1]`: "worktree off `dev`,"
   read literally, means checking out branch `dev` itself into the new worktree. Git refuses to
   have the same branch checked out in two worktrees at once — so a second concurrent run
   targeting the *same* `target_repo` would fail its `git worktree add` outright, directly
   undermining REQ-05's own ≥3-concurrent success metric (nothing stops two ideas from targeting
   the same repo). Fix: each run's worktree checks out a **run-scoped branch cut from `dev`**
   (e.g. `run/<run_id>`), not `dev` itself. This still satisfies AD-3's actual requirement
   ("plugin-hive's `.pHive/` always lives inside a valid git repo," workspace isolated per run)
   — it just means AD-3's existing-repo case needs one more concrete step (`git branch
   run/<run_id> dev && git worktree add <path> run/<run_id>`) that the current architecture.md
   text doesn't spell out. Worth folding back into `docs/architecture.md` AD-3 during story
   writing, not just here.
3. **Kickoff+Plan Engine wrapper (plumbing only)** — spawns `claude -p`/`--resume` against the
   run's workspace and manages session-id bookkeeping/pause-resume. **Split out from extraction**
   `[T2]`, because this half is what the spike actually proved (headless invoke, clean stop,
   disk persistence, resume-with-context) — it's comparatively low-risk and shouldn't be gated on
   solving the harder parsing problem below.
4. **Question extraction (own story, high risk)** — parses the question out of the final prose
   turn. `[T2]` The spike proved kickoff *asks* cleanly headlessly; it did not prove Minerva can
   reliably parse an arbitrary question out of arbitrary Markdown prose across every kickoff/plan
   gate, not just the two phrasings the spike happened to test. This remains the highest-risk
   story in the epic post-spike.
5. **Escalation Classifier (AD-2) — depends on step 4's extraction hook, own story** —
   **resolving the mechanism, which the first draft left unstated** `[H3]`: AD-2 says the
   suggestion is "judged at question-generation time by the same planning persona that generates
   the question." The spike's own captured example (the metrics-tracking gate question) shows
   plugin-hive's kickoff skill does **not** natively emit any `suggested_channel`/`confidence`/
   `reason` alongside its questions. So "the same planning persona" has to mean: the Kickoff+Plan
   Engine **appends its own instructions** (via `--append-system-prompt` or, preferably,
   `claude -p --json-schema` to constrain the output shape directly rather than relying on prose
   discipline — committing to attempt the schema-constrained route first, prose-parsing as
   fallback) asking the *same* driven turn to self-classify each question against the anchored
   escalation principle.

   **Interface with step 4, made explicit** `[T1]`: until this story lands, step 4's extraction
   returns questions with `channel: "human"` unconditionally — the safe default, consistent with
   "when uncertain, escalate." Step 4 is genuinely shippable/testable on its own with that
   default; this story only has to change the default-assignment path, not extraction itself.

   **Known soundness limitation, not fully solved, explicitly named** `[A3]`: a model
   self-grading the ambiguity/confidence of a question it just chose to ask is a biased judge —
   no independent perspective, mild incentive to resolve cleanly. This is exactly *why* AD-2
   makes the channel a "suggestion" decided externally rather than ground truth Minerva trusts —
   the architecture already anticipates the signal being imperfect. But that only mitigates
   *downstream trust* in the signal, not the risk that self-classification is unreliable or
   unparseable in the first place, which is a real, separate implementation risk this story
   carries. Not a thin pass-through — comparable in effort/risk to step 4. `[P2]`
6. **Question/answer channel routing + `WRONG_CHANNEL` guard** — `getQuestions`/`submitAnswers`
   reading and enforcing `channel` (not `suggested_channel`), per REQ-03.
7. **Output Emitter (REQ-04)** — on final-gate approval, write the epic+stories in plugin-hive's
   own `.pHive/epics/` schema into the run's state dir, serve via `getOutput`.
8. **Cleanup Ledger / Event Sink (AD-4)** — append-only ledger + `cleanup_needed` event on
   completion/abort. Small, mechanical, but explicitly required by the Delphi review — not
   optional polish.
9. **`getRunStatus`, `listRuns`, `abortRun`** — round out the API surface; thin reads/writes over
   the same on-disk `Run` record everything else already writes. (`capabilities` moved to step 1
   — see above.)

**Explicitly out of this epic's build order:** REQ-07 (local CLI convenience wrapper, P1 in the
PRD). `[H2]` Nothing above builds it. I'm treating it as legitimately deferrable — it's a thin
convenience layer over the same `startRun`/`getQuestions`/`submitAnswers` surface everything
else already builds, with no architecture component of its own — but flagging that the first
draft simply omitted it without saying so, which is worth this epic's decomposition confirming
explicitly (either "story N covers it" or "deferred past this epic") rather than leaving it
silently absent again.

I'm doing the CLI/wire-format plumbing (1) before the run-semantics stories (2-9) because
everything downstream needs a real dispatch loop to test against — building the engine first
and bolting a CLI on at the end would mean re-testing the whole thing twice.

## 4. What Could Go Wrong

- **[high] Prose-question extraction is genuinely hard, not a formality.** The spike proved
  kickoff *asks* cleanly headlessly; it didn't prove Minerva can reliably *parse* an arbitrary
  question out of arbitrary Markdown prose across every kickoff/plan gate, not just the two
  phrasings tested. `claude -p --json-schema` is a promising escape hatch (confirmed available
  in the spike's own `claude --help` scan) but wasn't prototyped. This is the risk driving the
  Medium scope call in §8, at full severity, not a softened version of it. `[U1]`
- **[high] Self-classification is a separate, comparably hard problem, and it's judge-biased on
  top of being unparseable-risk.** `[A3]` Getting a driven session to reliably self-classify
  escalation channel/confidence/reason in a parseable format (§3 step 5) is its own unprototyped
  risk, compounded by the self-grading model having no independent perspective on its own
  question's ambiguity. AD-2's "suggestion, not ground truth" framing mitigates how much
  Minerva's *architecture* trusts the signal — it does not mitigate the *implementation* risk
  that the signal is unreliable or fails to parse at all.
- **[medium] `submitAnswers` is the only thing that advances a run, and that's easy to violate
  by accident.** The architecture is explicit ("No Autonomous Progress") but it would be easy
  for an implementation detail — e.g. a retry loop around a flaky `claude -p` call — to
  accidentally re-drive a run without an explicit caller answer. Worth a story-level acceptance
  criterion, not just a doc note.
- **[medium] Two-case workspace allocation (AD-3) is untested against a real existing-repo
  case, and the naive reading had a real concurrency bug.** The spike only exercised the
  greenfield fresh-`git init` path. Worktree-off-`dev` against a real target repo — including
  what happens if that repo has no `dev` branch, and now fixed to cut a run-scoped branch rather
  than checking out `dev` itself (§3 step 2) `[A1]` — hasn't been tried once end-to-end.
- **[low] Cost/turn-count of a real run isn't bounded anywhere yet.** Every headless `claude -p`
  call in the spike had an explicit `--model haiku` + tight prompt; a real kickoff+plan run (as
  this very planning session demonstrates) can run long. Nothing in REQ-01..08 caps run cost —
  see Open Question 1, which now also flags a real tension with AD-5. `[U3]`

Five risks total (2 high, 2 medium, 1 low) — all five carried forward into §8's unknowns count.
`[U2]` (Splitting the classification risk out from extraction, per the architect review, raised
the count from four to five and added a second `[high]`.)

## 5. Dependencies and Constraints

- **External dependency:** the `claude` CLI itself (headless `-p`/`--resume`/session
  persistence) — confirmed present and working on this box by the spike, but it's a real
  runtime dependency, not vendored.
- **Internal dependency:** plugin-hive's `kickoff` + `plan` skills, invoked, not modified — this
  epic does not touch the plugin-hive plugin cache.
- **Constraint:** no build step (per sibling-repo convention, pending confirm-on-contact) — ship
  `.ts` run via `tsx` directly, matching pantheon-orchestrator and plugin-hive's adapters.
- **Constraint:** local CI only, no GHA — per this project's own stated discipline.
- **Constraint:** CONTEXT.md's maturity ladder — "named → interfaced → full TDD → locked" —
  applies to every story in this epic. `[C1]` Concretely, this is what `hive.config.yaml`'s
  `execution.default_methodology: tdd` already commits every story to at the workflow level
  (test-spec before implement, per story); §7 below states this explicitly rather than assuming
  it's understood.
- **Not a dependency (deliberately):** Delphi, Auriga, Vulcan, Multica, votem — v1 has zero
  runtime dependency on any of them; the whole point of the v1/v2 split.

## 6. Open Questions

1. **Cost/turn-count ceiling for a driven run** — should `startRun` accept a budget/turn cap
   passed through to the underlying `claude -p` calls, or is that entirely out of scope for v1
   and left to the caller to manage externally? **Tension worth flagging explicitly:** AD-5
   already rules out "timeout-then-default-answer" as a hard exclusion, not a preference — any
   future budget cap that forcibly closes or auto-resolves a run mid-flight would violate that.
   If a cap is ever added, the only AD-5-consistent shape is that exceeding it produces *another
   kind of held state* (e.g. `budget_exceeded`, surfaced like `waiting_on_human`) requiring an
   explicit caller decision to continue or abort — never a silent auto-resolution. `[U3]` For v1
   itself, I'd still default to "out of scope, caller's problem" — just noting the constraint so
   a future "yes, add a cap" doesn't quietly reintroduce what AD-5 forbids.
2. **Question-extraction fallback behavior** — if extraction genuinely can't find a question in
   a prose turn (e.g., the model rambled instead of asking cleanly), what does Minerva do?
   Treat the run as stalled (safe, consistent with "never guess") or surface a distinct error?
   I'd lean toward treating it as `waiting_on_human` with a raw-text fallback question rather
   than a hard error, but want to confirm before writing it into a story's acceptance criteria.
3. **`target_repo` validation** — does `startRun` need to verify the given `target_repo` path
   is actually a valid git repo with a `dev` branch before allocating a worktree, or is a clear
   error on worktree-add failure sufficient? I'd lean toward the latter (don't duplicate git's
   own error reporting) but flagging it since AD-3 doesn't say either way — and per §4, this
   whole code path is currently spike-unverified, so I'd rather over-validate here than under.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: node:test (via `tsx --test`), matching every sibling repo's convention and this
    epic's own spike test. Methodology is TDD per hive.config.yaml and CONTEXT.md's maturity
    ladder (named -> interfaced -> full TDD -> locked) [C1] -- every story gets a test-spec
    step before implement, not just a general "write tests" step.
  Platforms: macOS/Linux dev boxes running Node >=20.19 -- no mobile/browser surface, no UI.
  Automated: all 6 P1 requirements (REQ-01..06, matching the PRD's own priority tier -- there
    is no P0 tier in docs/prd.md) [V1] get real node:test coverage against a live bin/minerva
    subprocess (spawn + stdin/stdout, same pattern as the spike's own
    spike-plugin-hive-drivability-spike.test.ts) -- no mocking the CLI boundary, since the
    CLI boundary IS the contract (AD-1). Additionally, per the architect review [A4]: extraction
    gets a small curated corpus of varied real kickoff/plan question phrasings (not just the
    spike's two), and the classifier gets a curated set of question/expected-channel pairs
    checked against the anchored escalate/absorb principle -- covering judgment-quality, not
    just parseability, which the first draft's plan left untested.
  Manual: BOTH AD-3 workspace cases need a manual dry-run against a real repo before the epic
    is called done. The spike exercised ONLY the greenfield fresh-git-init case -- the
    worktree-off-dev (existing-repo) case has zero spike coverage, not just "less proof." [H4]
    Completion-gate mechanism, per the TPM escalation [T3]: this is a human-gated acceptance
    criterion ON THE AD-3 STORY ITSELF (an explicit AC that only a human check-off satisfies),
    not a doc-only note -- so automated completion tooling structurally cannot mark the story
    done on test-pass alone. Carry this into the story's acceptance_criteria at Phase C.
  Not verifying: v2 integrations (Delphi/Auriga/Vulcan/Multica/votem) -- nothing to verify,
    they're not built. REQ-07 (CLI wrapper) -- explicitly out of this epic's build scope; will
    get an explicit "deferred" marker at Phase C traceability, not silent omission [T4]. Not
    load-testing concurrent runs beyond the PRD's stated floor (>=3 concurrent, per the anchored
    success metric) -- deeper scale testing is a v2 concern.
```

**TPM escalation logged** `[T5]`: `manual-dry-run-completion-gate`, severity moderate, placement
pre-exec, story `ad-3-workspace-allocation` — the concern above (human-gated AC, not a doc note)
is the resolution; this will be written to `.pHive/cycle-state/agent-drivable-core.yaml` as a
tracked escalation per the orchestrator's dedup-on-write process, not just resolved in prose here.

## 8. Scale Assessment

**Size indicators:**
- Files affected: ~17-22 new files (scaffold+capabilities, run manager, engine-wrapper plumbing,
  question extraction, escalation classifier — now four separate build items instead of two,
  per the steps 3-5 split — output emitter, cleanup ledger, plus test files for each).
- Subsystems: one new subsystem end-to-end (there's no existing Minerva code to integrate
  with), but internally it has real layers — wire protocol, run/workspace management, an
  engine wrapper around an external CLI, classification, persistence.
- Migration required: no — nothing exists yet to migrate.
- Cross-team/cross-service coordination: no — v1 is explicitly standalone; nothing outside this
  repo needs to change for v1 to ship.
- Unknowns: 3 open questions (§6) + 5 flagged risks in §4 (2 high, 2 medium, 1 low — updated
  after splitting the classification risk out from extraction per the architect review). `[U2]`

```
SCALE ASSESSMENT:
  Files affected: ~17-22
  Subsystems: 1 new (Minerva), internally multi-layered (wire protocol / run mgmt / engine
    wrapper / extraction / classification / persistence)
  Migration required: no
  Cross-team coordination: no
  Unknowns: 3 open questions + 5 flagged risks (2 high, 2 medium, 1 low)

  RECOMMENDATION: Proceed to H/V planning (Medium), not a full Structured Outline.
  RATIONALE: Both the extraction and self-classification risks are genuinely [high] (§4), not
    softened to justify Medium scope. `[U1]` The Medium call rests on a different axis: this is
    one subsystem in one repo, with no migration and no cross-team coordination -- Large-scope's
    structured-outline ceremony (elicitation, ~1000-line plan) is sized for multi-system/
    cross-team risk, which this epic doesn't have, even with two high-severity technical risks
    inside it. Per the TPM review, Medium sizing must NOT imply normal-confidence point estimates
    for those two risks `[T3]` -- the H/V plan should timebox question-extraction and
    self-classification as an explicit spike-with-checkpoint (a defined re-plan trigger if
    parsing/classification doesn't converge within the box), not point-estimate them on faith
    like the rest of the epic. That's the vertical-slice plan's job: isolate the risky work into
    its own early slice, proven or falsified before the rest of the epic depends on it, with a
    checkpoint instead of full structured-outline elicitation.
```
