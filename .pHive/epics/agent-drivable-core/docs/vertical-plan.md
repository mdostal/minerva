# Vertical Planning — Slice Plan — epic `agent-drivable-core`

Input: `docs/horizontal-plan.md` + `docs/design-discussion.md` + collaborative review findings
(architect: AD-3 concurrency fix, steps-coupling; TPM: timebox the risky pair as an isolated
slice with a checkpoint, not a point-estimated story).

## 1. Slicing Strategy

```
STRATEGY:
  Total horizontal items: ~26 (see horizontal-plan.md Scope Summary)
  Planned slices: 8
  First slice goal: prove the wire protocol dispatch loop end-to-end with the cheapest
    possible method (capabilities) -- nothing else depends on run semantics yet
  Final slice goal: full idea -> spec loop, agent-drivable, human-gated, with cleanup
    bookkeeping and a completeness/verification pass -- REQ-01..06 all satisfied

  Slicing rationale: the load-bearing chain identified in horizontal-plan.md §3 (Engine ->
    Extraction -> Classification -> Channel Routing) is deliberately NOT built as one slice.
    Per the TPM review, it's split into three sequential slices (4, 5, 6) each independently
    working and verifiable, with slices 5 and 6 individually timeboxed as spike-with-checkpoint
    work -- if either doesn't converge in its box, the run still works end-to-end using the
    prior slice's safe default (raw prose passthrough, then always-human channel) rather than
    blocking the epic. This directly answers the TPM's "don't point-estimate the two high-risk
    items on faith" concern.
```

## 2. Vertical Slice Plan

```
## Slice 1: Wire protocol skeleton

WHAT WORKS AFTER THIS SLICE:
  A caller can spawn `bin/minerva`, send {"method":"capabilities","params":{}} on stdin, and
  get back {"result":{"abi_version":"1.0.0"}} on stdout with exit 0. Malformed input gets a
  VALIDATION_FAILED error, not a crash.

LAYERS TOUCHED:
  CLI/Wire Protocol:
    - package.json, tsconfig.json (pending confirm-on-contact against pantheon-orchestrator)
    - bin/minerva entrypoint: stdin chunk-concat, JSON.parse, method dispatch, stdout write,
      exit 0/1
    - capabilities handler (static abi_version)
    - Closed error enum scaffolding (all 5 codes defined, even if only VALIDATION_FAILED and
      UNKNOWN_METHOD are reachable yet)

NOT YET:
  - Any run semantics (startRun, workspace, engine, extraction, classification)
  - Real answers to any method other than capabilities

VERIFIED BY:
  node:test spawning a real bin/minerva subprocess (per AD-1, no mocking the CLI boundary) --
  capabilities returns the right shape; malformed envelope returns VALIDATION_FAILED; unknown
  method returns UNKNOWN_METHOD.

COMMIT REPRESENTS: Minerva's wire protocol exists and speaks the ABI correctly for the one
  method that needs no run context.

---

## Slice 2: Run & workspace management (no engine yet)

BUILDS ON: Slice 1

WHAT WORKS AFTER THIS SLICE:
  A caller can startRun{idea, target_repo?} and get back a run_id. getRunStatus and listRuns
  correctly report the new run. The two AD-3 workspace cases both actually allocate a real,
  isolated git workspace on disk (run-scoped branch off dev for the existing-repo case, fresh
  git init for greenfield) -- but nothing drives kickoff+plan inside it yet, so the run just
  sits in `in_progress` forever.

LAYERS TOUCHED:
  CLI/Wire Protocol: startRun, getRunStatus, listRuns dispatch
  Run & Workspace Management: full two-case allocation logic (AD-3, with the run-scoped-branch
    concurrency fix), Run record creation
  State Store: Run record read/write conventions established here, reused by every later slice

NOT YET:
  - Kickoff+Plan Engine (the run never actually progresses)
  - Question extraction, classification, channel routing, output, cleanup

VERIFIED BY:
  node:test: startRun against a real throwaway existing repo produces a worktree on a
  run-scoped branch (not `dev` itself -- explicit assertion that two concurrent startRuns
  against the SAME target_repo both succeed, directly testing the architect-review fix).
  startRun with no target_repo produces a fresh git-init repo with an initial commit.
  MANUAL: one real dry-run of each case against an actual target repo (per design-discussion
  §7's human-gated AC commitment) -- tracked as a required, non-bypassable acceptance criterion
  on this slice's story, not just a test.

COMMIT REPRESENTS: Runs exist, are isolated from each other on disk, and survive a restart --
  but nothing makes them progress yet.

---

## Slice 3: Kickoff+Plan Engine plumbing + raw-prose passthrough

BUILDS ON: Slice 2

WHAT WORKS AFTER THIS SLICE:
  startRun actually spawns `claude -p` inside the run's workspace. getQuestions returns
  something for a paused run -- the RAW, unparsed final-turn text, wrapped in a single
  always-`channel:"human"` question (no extraction or classification yet). submitAnswers
  resumes via `claude -p --resume` and the run genuinely advances. This is the first slice
  where the full idea-in -> question -> answer -> continue loop works end-to-end, even though
  the question surface is crude.

LAYERS TOUCHED:
  Kickoff+Plan Engine (plumbing): spawn on startRun, resume on submitAnswers, session_id
    persisted via State Store
  CLI/Wire Protocol: getQuestions/submitAnswers now return real (if crude) data instead of
    stubs
  Channel Routing: minimal version -- everything is channel "human", so WRONG_CHANNEL is
    reachable (agent channel is always empty) but classification-aware routing isn't built yet

NOT YET:
  - Question extraction (raw prose, not a parsed question)
  - Escalation classification (hardcoded human-only)
  - Output emitter, cleanup ledger

VERIFIED BY:
  node:test reusing the spike's own pattern (spike-plugin-hive-drivability-spike.test.ts) but
  driven THROUGH bin/minerva's CLI boundary instead of raw `claude -p` calls -- startRun ->
  getQuestions (raw text) -> submitAnswers -> getRunStatus advances past waiting_on_human.

COMMIT REPRESENTS: Minerva can drive a real plugin-hive kickoff run end-to-end headlessly --
  the core async loop the whole epic exists to prove, even before the surface is polished.

---

## Slice 4: Question extraction (TIMEBOXED, spike-with-checkpoint)

BUILDS ON: Slice 3

WHAT WORKS AFTER THIS SLICE (if the checkpoint is met):
  getQuestions returns a real, cleanly parsed question string instead of Slice 3's raw prose
  blob. Extraction attempts `claude -p --json-schema` first; falls back to prose-parsing if
  schema-constrained extraction isn't viable within the timebox.

CHECKPOINT (per TPM review -- this is the point, not a footnote; made quantitative per
architect self-review of this doc, since "reliably" and "the box" were both vague on first
draft):
  Timebox: 2 implementation days. Convergence bar: the extraction implementation must correctly
  parse a clean question from >=90% of a >=15-entry curated corpus of real kickoff/plan question
  phrasings (horizontal-plan.md's Question Extraction layer), with zero failures on the two
  spike-verified phrasings (metrics-tracking, project_type) as a hard floor -- those two are
  already proven extractable by hand in the spike, so a regression on either is a stop condition
  regardless of the aggregate percentage. If the bar isn't met inside the 2-day box, do NOT
  block the epic -- ship Slice 3's raw-prose passthrough as v1's actual behavior, document it
  as a known limitation, and re-plan extraction as a follow-up epic. The run-advancement loop
  proven in Slice 3 still works either way.

LAYERS TOUCHED:
  Question Extraction: full implementation, replacing Slice 3's passthrough
  CLI/Wire Protocol: getQuestions now serves parsed text

NOT YET:
  - Escalation classification (still hardcoded human-only from Slice 3)
  - Output emitter, cleanup ledger

VERIFIED BY:
  node:test against the curated corpus of real kickoff/plan question phrasings (per architect
  review) -- not just the spike's original two examples. Extraction-failure fallback
  (Open Question 2: waiting_on_human + raw-text fallback) gets its own explicit test.

COMMIT REPRESENTS: Either "clean question extraction works across a real phrasing corpus," or
  an explicit, documented decision to ship raw-prose passthrough for v1 with extraction
  deferred -- both are valid, checkpointed outcomes of this slice.

---

## Slice 5: Escalation classification (TIMEBOXED, spike-with-checkpoint)

BUILDS ON: Slice 4

WHAT WORKS AFTER THIS SLICE (if the checkpoint is met):
  Each extracted question carries a real self-classified {suggested_channel, confidence,
  reason}. The enforced `channel` defaults to `suggested_channel` (v1, no Vesta/Delphi
  override). Channel Routing becomes meaningful -- agent-channel questions actually route
  differently from human-channel ones, and WRONG_CHANNEL is exercised for real.

CHECKPOINT (per TPM review, same shape as Slice 4, made quantitative for the same reason):
  Timebox: 2 implementation days. Convergence bar: self-classification must produce a parseable
  {suggested_channel, confidence, reason} for >=90% of the same curated corpus used in Slice 4,
  AND correctly match the anchored escalate/absorb principle's expected channel for >=80% of a
  separately curated set of >=10 question/expected-channel pairs spanning both "should escalate"
  and "should absorb" cases -- parseability alone is not sufficient, per the architect review's
  distinction between parseability and judgment-quality (horizontal-plan.md's Escalation
  Classification layer). If either bar isn't met inside the 2-day box, do NOT block the epic --
  ship Slice 3/4's always-human default as v1's actual behavior (safe, consistent with "when
  uncertain, escalate"), document the limitation, and re-plan classification as a follow-up
  epic.

LAYERS TOUCHED:
  Escalation Classification: full implementation (append classification instructions at the
    Kickoff+Plan Engine's spawn point, per design-discussion §3 step 5)
  Channel Routing / Answer Submission: enforced-channel defaulting logic, real WRONG_CHANNEL
    exercise

NOT YET:
  - Output emitter, cleanup ledger

VERIFIED BY:
  node:test against the curated question/expected-channel pairs (per architect review) --
  checks classification against the anchored escalate/absorb principle, not just parseability.

COMMIT REPRESENTS: The escalation boundary (REQ-03) is real, not just architecturally described
  -- or an explicit, documented decision to ship human-only routing for v1.

---

## Slice 6: Output emitter — full idea-to-spec loop closes

BUILDS ON: Slice 5 (or Slice 4/3's fallback state, if 4/5's checkpoints weren't met -- this
  slice works identically either way, since it only depends on a run reaching its final gate,
  not on HOW questions got there)

WHAT WORKS AFTER THIS SLICE:
  On final-gate human approval, Minerva writes the approved epic+stories in plugin-hive's own
  schema into the run's state dir. getOutput serves it once status is `complete`; NOT_READY
  before that -- never a partial/fabricated epic. This is the PRD's stated minimum success bar,
  achieved end-to-end for the first time.

LAYERS TOUCHED:
  Output / Hand-off: full implementation
  CLI/Wire Protocol: getOutput now serves real data

NOT YET:
  - Cleanup ledger / event sink
  - abortRun, polish

VERIFIED BY:
  node:test: full run through bin/minerva from startRun to a written, schema-valid epic+stories
  artifact, retrievable via getOutput. getOutput on an incomplete run returns NOT_READY.

COMMIT REPRESENTS: Minerva delivers on its core promise -- idea in, approved spec out,
  headlessly, human-gated.

---

## Slice 7: Cleanup ledger / event sink (AD-4)

BUILDS ON: Slice 6

WHAT WORKS AFTER THIS SLICE:
  Run completion and abortRun both append a CleanupLedgerRecord to the shared ledger and emit a
  cleanup_needed event. Minerva still never deletes anything itself.

LAYERS TOUCHED:
  Cleanup Ledger / Event Sink: full implementation
  CLI/Wire Protocol: abortRun dispatch

NOT YET:
  - Corpus/completeness verification pass (Slice 8)

VERIFIED BY:
  node:test: completing a run appends exactly one ledger record and emits exactly one event;
  abortRun does the same; workspace/state_path are confirmed still present on disk after both.

COMMIT REPRESENTS: The Delphi-review-mandated cleanup bookkeeping exists and is exercised, not
  just documented in architecture.md.

---

## Slice 8: Completeness pass

BUILDS ON: Slice 7

WHAT WORKS AFTER THIS SLICE:
  listRuns is fully accurate across many concurrent runs; every closed error-enum branch
  (NOT_FOUND, WRONG_CHANNEL, NOT_READY, UNKNOWN_METHOD, VALIDATION_FAILED) has explicit test
  coverage; REQ-07's exclusion is confirmed as an explicit deferred marker at traceability
  (Phase C), not silent omission (per TPM review). Any Slice 4/5 checkpoint misses get their
  fallback behavior explicitly documented in docs/architecture.md rather than left implicit.

LAYERS TOUCHED: all -- this is a verification/documentation slice, not a new-capability one.

NOT YET: nothing in-scope for this epic. (v2: Delphi, Multica, Auriga wiring, votem, REQ-07's
  CLI wrapper.)

VERIFIED BY: full node:test suite green across all prior slices' tests; the ≥3-concurrent-runs
  success metric exercised directly (start 3 runs against 3 different scratch repos, drive all
  three to completion, confirm no cross-run interference).

COMMIT REPRESENTS: epic `agent-drivable-core` complete -- REQ-01..06 satisfied, REQ-07
  explicitly deferred, ready for /hive:standup.
```

## 3. Overlay Diagram

```
VERTICAL SLICE OVERLAY
────────────────────────────────────────────────────────────────────────────────────────
              │ Slice 1  │ Slice 2  │ Slice 3   │ Slice 4  │ Slice 5   │ Slice 6 │ Slice 7 │ Slice 8
              │ (wire)   │ (runs)   │ (engine)  │ (extract)│ (classify)│ (output)│ (clean) │ (polish)
──────────────┼──────────┼──────────┼───────────┼──────────┼───────────┼─────────┼─────────┼─────────
CLI/Wire      │ caps,    │ startRun,│ getQ/     │ getQ     │ getQ/     │ getOut  │ abortRun│ listRuns
Protocol      │ dispatch │ status,  │ submitAns │ (parsed) │ submitAns │         │         │ accuracy
              │          │ listRuns │ (raw)     │          │ (routed)  │         │         │
──────────────┼──────────┼──────────┼───────────┼──────────┼───────────┼─────────┼─────────┼─────────
Run &         │          │ two-case │           │          │           │         │         │
Workspace     │          │ alloc    │           │          │           │         │         │
──────────────┼──────────┼──────────┼───────────┼──────────┼───────────┼─────────┼─────────┼─────────
Kickoff+Plan  │          │          │ spawn +   │          │ +classify │         │         │
Engine        │          │          │ resume    │          │ prompt    │         │         │
──────────────┼──────────┼──────────┼───────────┼──────────┼───────────┼─────────┼─────────┼─────────
Question      │          │          │ (raw      │ real     │           │         │         │
Extraction    │          │          │ passthru) │ parse    │           │         │         │
──────────────┼──────────┼──────────┼───────────┼──────────┼───────────┼─────────┼─────────┼─────────
Escalation    │          │          │           │          │ real      │         │         │
Classification│          │          │           │          │ classify  │         │         │
──────────────┼──────────┼──────────┼───────────┼──────────┼───────────┼─────────┼─────────┼─────────
Channel       │          │          │ human-only│          │ real      │         │         │
Routing       │          │          │ stub      │          │ routing   │         │         │
──────────────┼──────────┼──────────┼───────────┼──────────┼───────────┼─────────┼─────────┼─────────
Output/       │          │          │           │          │           │ full    │         │
Hand-off      │          │          │           │          │           │         │         │
──────────────┼──────────┼──────────┼───────────┼──────────┼───────────┼─────────┼─────────┼─────────
Cleanup       │          │          │           │          │           │         │ full    │
Ledger/Events │          │          │           │          │           │         │         │
──────────────┼──────────┼──────────┼───────────┼──────────┼───────────┼─────────┼─────────┼─────────
State Store   │ (none)   │ Run rec  │ session_id│          │           │ output  │ ledger  │ (verify)
────────────────────────────────────────────────────────────────────────────────────────

Each column is a commit-worthy, working state. Slices 4 and 5 are the two TIMEBOXED
spike-with-checkpoint slices -- both degrade gracefully to the prior slice's safe default if
their checkpoint isn't met, so the overlay is valid even if 4 or 5 "fails."
```

## 4. Deferred Items

```
DEFERRED (not in current slice plan):
  - REQ-07 (local CLI convenience wrapper) -- P1 in the PRD, no architecture component of its
    own, thin layer over the same startRun/getQuestions/submitAnswers surface every slice above
    already builds. Deferred past this epic; will get an explicit "deferred" marker at Phase C
    traceability (per TPM review), not silent omission.
  - REQ-08 (run status/listing) partial polish beyond Slice 8's accuracy pass -- basic listRuns
    ships in Slice 2, refined in Slice 8; anything beyond that (filtering, pagination) is v2.
  - All v2 god-integrations (Delphi, Auriga, Vulcan, Multica, votem) -- out of this epic
    entirely, per docs/initial-info.md's v1/v2 split.

RATIONALE: REQ-07 and deep REQ-08 polish are convenience/UX layers with no architectural
  dependency from anything else in the epic -- nothing above needs them to exist. The v2
  integrations are excluded by explicit product decision, not a slicing choice.
```

## 5. Risk by Slice

```
RISK PER SLICE:
  Slice 1: Low -- pure protocol plumbing, closely mirrors the spike's own proven patterns and
    sibling-repo adapter conventions.
  Slice 2: Medium -- AD-3's two-case allocation is spike-unverified end-to-end (only the
    fresh-init case was exercised, and only in isolation, not via a real startRun path); the
    run-scoped-branch fix is new and needs its own real verification.
  Slice 3: Low-Medium -- the underlying mechanism (headless invoke/resume) is spike-proven;
    the new risk is wiring it correctly behind the CLI/Run-Manager layers, not the mechanism
    itself.
  Slice 4: High -- unprototyped, explicitly timeboxed with a checkpoint. This is the epic's
    single riskiest slice.
  Slice 5: High -- unprototyped, explicitly timeboxed with a checkpoint, and depends on Slice
    4's extraction existing. Second-riskiest slice, compounding on the first.
  Slice 6: Low -- mechanical schema-conformant file write once a run reaches its final gate;
    no new external dependency.
  Slice 7: Low -- append-only bookkeeping, no deletion, no complex logic.
  Slice 8: Low -- verification/documentation, not new capability.
```

## 6. Moldability Notes

- **Slices 4 and 5 can each independently degrade to their prior slice's fallback** without
  invalidating anything after them — Slice 6 (Output/Hand-off) only depends on a run reaching
  its final gate, not on how cleanly questions were extracted or classified along the way. This
  is the plan's main safety valve against the epic's two high-risk items.
- **Slices 1-3 are not reorderable** — each is a hard prerequisite for the next (protocol before
  runs, runs before an engine to drive them).
- **Slices 6-8 are reorderable relative to each other** if priorities shift (e.g., cleanup
  bookkeeping could ship before output emission if AD-4's Delphi-review mandate needs to land
  first for unrelated reasons) — neither depends on the other's internals, only both depend on
  Slices 1-3 existing.
- **New slices that might be needed if Slice 4 or 5's checkpoint isn't met:** a follow-up epic
  scoped specifically to extraction and/or classification, informed by whatever the timeboxed
  attempt actually learned — not predictable in advance, which is exactly why these are
  checkpointed spikes rather than committed scope.
