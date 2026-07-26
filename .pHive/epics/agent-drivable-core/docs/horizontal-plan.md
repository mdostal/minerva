# Horizontal Planning Scan — epic `agent-drivable-core`

Input: `docs/design-discussion.md` (revised, post-grill, post-collaborative-review) +
`.pHive/epics/agent-drivable-core/docs/research-brief.md` + user sign-off (Medium scope,
proceed to H/V).

## 1. Layer Inventory

- **CLI / Wire Protocol** — the single external surface (`bin/minerva`). New: everything.
- **Run & Workspace Management** — run lifecycle, two-case isolated workspace (AD-3). New:
  everything.
- **Kickoff+Plan Engine (plumbing)** — drives `claude -p`/`--resume` against a run's workspace.
  New: everything.
- **Question Extraction** — parses a question out of the engine's prose turn. New: everything.
- **Escalation Classification** — self-classifies each question (`suggested_channel`,
  `confidence`, `reason`); enforced-channel defaulting. New: everything.
- **Channel Routing / Answer Submission** — `getQuestions`/`submitAnswers`, `WRONG_CHANNEL`
  guard. New: everything.
- **Output / Hand-off** — writes the approved epic+stories in plugin-hive's schema; serves via
  `getOutput`. New: everything.
- **Cleanup Ledger / Event Sink** — append-only ledger + `cleanup_needed` event (AD-4). New:
  everything.
- **State Store (persistence substrate)** — plain files under each run's namespaced `.pHive`
  dir; read/written by nearly every other layer. New: everything.

No layer is "modified" — this is a from-scratch build (no existing Minerva source), so every
layer is 100% new. The interesting structure is in cross-layer dependencies (§3), not
new-vs-modified.

## 2. Per-Layer Requirements

```
## Layer: CLI / Wire Protocol

METHODS NEEDED (per docs/architecture.md API Contract):
  - capabilities — returns {abi_version}
  - startRun — {idea, target_repo?, constraints?} -> {run_id}
  - getQuestions — {run_id, channel} -> {questions: Question[]}
  - submitAnswers — {run_id, channel, answers} -> {result: {}}
  - getRunStatus — {run_id} -> {status}
  - getOutput — {run_id} -> {epic} | NOT_READY
  - listRuns — {} -> {runs: RunSummary[]}
  - abortRun — {run_id} -> {result: {}}

DISPATCH:
  - Read one {method, params} JSON envelope from stdin per invocation (manual chunk-concat,
    per the sibling-adapter pattern found in research)
  - Route to the matching handler; write {result} or {error} to stdout; exit 0/1
  - Closed error enum: NOT_FOUND, VALIDATION_FAILED, WRONG_CHANNEL, NOT_READY, UNKNOWN_METHOD

SCAFFOLD:
  - package.json (type: module, tsx, node:test) -- pending confirm-on-contact against
    pantheon-orchestrator's actual settings
  - tsconfig.json (ES2022, NodeNext, strict, noUncheckedIndexedAccess, noEmit)
  - bin/minerva shebang entrypoint

---

## Layer: Run & Workspace Management

RUN LIFECYCLE:
  - Allocate run_id on startRun
  - Two-case workspace allocation (AD-3, revised): target_repo given -> git worktree checking
    out a NEW run-scoped branch (run/<run_id>) cut from that repo's dev, not dev itself
    (concurrency fix from architect review). No target_repo -> fresh `git init` scratch repo
    with an initial commit.
  - Allocate namespaced .pHive state dir inside the workspace
  - Write initial Run record to the State Store layer

RUN RECORD FIELDS (per architecture.md Data Model):
  - run_id, workspace_path, workspace_kind (worktree|fresh_init), state_path, status,
    created_at, questions[], output

LOOKUPS:
  - Resolve an existing run's workspace_path/state_path from run_id on every subsequent call
    (capabilities excepted -- it needs no run context)

---

## Layer: Kickoff+Plan Engine (plumbing)

RESPONSIBILITIES (plumbing only -- extraction and classification are separate layers):
  - Spawn `claude -p --session-id <uuid> ...` against the run's workspace on startRun
  - Persist the session_id as part of the Run record (State Store)
  - On submitAnswers, spawn `claude -p --resume <session_id> "<answer text>"` to continue
  - Surface the raw final-turn text (prose) to the Question Extraction layer -- this layer does
    NOT parse it itself

WHAT THE SPIKE ALREADY PROVED (reusable, not net-new risk):
  - Headless invocation works
  - Clean stop at end_turn, no hang
  - Session persists to disk automatically (no Minerva-side snapshot code needed)
  - --resume correctly continues with full protocol-state context

---

## Layer: Question Extraction

RESPONSIBILITIES:
  - Given the engine's raw final-turn prose text, extract the actual question being asked
  - Primary approach: `claude -p --json-schema <schema>` to constrain output shape directly
  - Fallback: prose parsing if schema-constrained extraction isn't viable
  - On failure to extract anything: per design-discussion Open Question 2, default to
    `waiting_on_human` with the raw text as a fallback question rather than a hard error

UNPROVEN SURFACE (real risk, not formality):
  - Only 2 real question phrasings tested by the spike (metrics, project_type) -- the full
    space of kickoff/plan gate questions is much larger
  - Needs a curated corpus (per architect review) covering varied real phrasings, not just the
    two spike examples

---

## Layer: Escalation Classification

RESPONSIBILITIES:
  - When driving the headless session (Kickoff+Plan Engine layer), append instructions asking
    the SAME turn to self-classify each question it asks: {suggested_channel, confidence,
    reason} per the anchored escalate/absorb principle
  - Extraction (previous layer) pulls the classification out alongside the question
  - Enforced `channel` defaults to `suggested_channel` in v1 (no Vesta/Delphi to override it)
  - INTERFACE WITH EXTRACTION: until this layer exists/lands, extraction returns
    channel: "human" unconditionally (safe default)

KNOWN LIMITATION (named, not solved):
  - Self-grading bias -- the same model that chose to ask the question is grading its own
    ambiguity/confidence. AD-2's "suggestion, not ground truth" framing mitigates trust in the
    signal architecturally; it does not mitigate the implementation risk that the signal itself
    is unreliable or fails to parse.

VERIFICATION NEED (not just parseability):
  - Curated question/expected-channel pairs checked against the anchored principle, not just
    "did a channel value parse out"

---

## Layer: Channel Routing / Answer Submission

RESPONSIBILITIES:
  - getQuestions{channel} returns only questions whose ENFORCED channel matches the request
  - submitAnswers{channel, answers} rejects (WRONG_CHANNEL) any answer submitted on a channel
    that doesn't match a question's enforced channel
  - This is the only path that advances a run (see "No Autonomous Progress" in architecture.md)
    -- must be provably impossible to trigger from a retry loop or any other implicit path

---

## Layer: Output / Hand-off

RESPONSIBILITIES:
  - On the run's final human-approval gate, write the approved epic+stories in plugin-hive's
    native .pHive/epics/ schema into the run's own state dir
  - getOutput returns the artifact once status is `complete`; NOT_READY error otherwise (never
    a partial/fabricated epic)

---

## Layer: Cleanup Ledger / Event Sink

RESPONSIBILITIES (AD-4, refined post-Delphi-review):
  - On run completion OR abortRun: append a CleanupLedgerRecord {run_id, workspace_path,
    state_path, status, closed_at} to a SHARED (not per-run) append-only ledger
  - Emit a cleanup_needed event, following this ecosystem's existing events-sink convention
    (plugin-hive's own <state_dir>/metrics/events/ pattern)
  - Never deletes workspace_path or state_path itself -- record + signal only

---

## Layer: State Store (persistence substrate)

RESPONSIBILITIES:
  - Plain files under each run's namespaced .pHive dir: Run record, question queue (with
    status/answers), final output once emitted
  - No in-memory state survives between CLI invocations -- every layer above reads what it
    needs from disk on each call (this is what makes resume-from-disk == pause/resume free,
    per AD-5)
  - Shared cleanup ledger lives OUTSIDE any single run's state dir (see Cleanup layer)
```

## 3. Cross-Layer Dependencies

```
DEPENDENCIES:

CLI/Wire Protocol -> every other layer (it's the dispatch point; every method call reaches
  into exactly one of the layers below)

Run & Workspace Management -> State Store (writes the initial Run record; every other layer's
  reads/writes are scoped inside the workspace_path/state_path this layer allocates)

Kickoff+Plan Engine (plumbing) -> Run & Workspace Management (needs workspace_path to spawn
  claude -p IN the right directory; needs session_id persisted via State Store to resume)

Question Extraction -> Kickoff+Plan Engine (consumes its raw prose turn output)

Escalation Classification -> Kickoff+Plan Engine (the instructions it appends must be injected
  at the SAME spawn point the engine owns) AND -> Question Extraction (the classification is
  extracted alongside the question, not via a separate call)

Channel Routing / Answer Submission -> Escalation Classification (reads enforced `channel`,
  which depends on Classification's default-then-possibly-overridden value) AND -> State Store
  (question queue read/write)

Output / Hand-off -> Channel Routing (only writes output once the FINAL gate's answer has been
  submitted through the normal channel path) AND -> State Store

Cleanup Ledger / Event Sink -> Run & Workspace Management (needs workspace_path/state_path to
  record) AND is triggered by BOTH Output/Hand-off's completion path AND abortRun

State Store -> nothing (it's the leaf -- every other layer depends on it, it depends on none)
```

The load-bearing chain is **Kickoff+Plan Engine -> Question Extraction -> Escalation
Classification -> Channel Routing** — this is exactly the chain the design discussion's steps
3-6 cover, and exactly where both collaborative-review passes concentrated their findings (the
steps 3/4/5 coupling, the self-grading bias risk). Vertical planning (next doc) has to decide
how to slice through this chain without violating "later slices never require rework of a
completed slice."

## 4. Layer Map Diagram

```
HORIZONTAL LAYER MAP
──────────────────────────────────────────────────────────────────────────────────────
CLI/Wire      │ capabilities  │ startRun      │ getQuestions/ │ getOutput /  │ getRunStatus/
Protocol      │ (bootstrap)   │ dispatch      │ submitAnswers │ abortRun     │ listRuns
              │               │               │ dispatch      │ dispatch     │ dispatch
──────────────┼───────────────┼───────────────┼───────────────┼──────────────┼──────────────
Run &         │               │ two-case      │               │              │ Run record
Workspace     │               │ workspace     │               │              │ reads
              │               │ alloc (AD-3)  │               │              │
──────────────┼───────────────┼───────────────┼───────────────┼──────────────┼──────────────
Kickoff+Plan  │               │ spawn claude  │ resume claude │              │
Engine        │               │ -p (start)    │ -p (continue) │              │
──────────────┼───────────────┼───────────────┼───────────────┼──────────────┼──────────────
Question      │               │ extract Q1    │ extract Qn    │              │
Extraction    │               │ from prose    │ from prose    │              │
──────────────┼───────────────┼───────────────┼───────────────┼──────────────┼──────────────
Escalation    │               │ self-classify │ self-classify │              │
Classification│               │ (appended     │ (appended     │              │
              │               │ instructions) │ instructions) │              │
──────────────┼───────────────┼───────────────┼───────────────┼──────────────┼──────────────
Channel       │               │               │ enforce       │              │
Routing       │               │               │ channel,      │              │
              │               │               │ WRONG_CHANNEL │              │
──────────────┼───────────────┼───────────────┼───────────────┼──────────────┼──────────────
Output /      │               │               │               │ write epic,  │
Hand-off      │               │               │               │ serve output │
──────────────┼───────────────┼───────────────┼───────────────┼──────────────┼──────────────
Cleanup       │               │               │               │ ledger +     │ (abortRun
Ledger/Events │               │               │               │ event on     │ path too)
              │               │               │               │ completion   │
──────────────┼───────────────┼───────────────┼───────────────┼──────────────┼──────────────
State Store   │ (none needed) │ Run record    │ question queue│ output write │ reads only
              │               │ write         │ read/write    │              │
──────────────────────────────────────────────────────────────────────────────────────
```

## 5. Scope Summary

```
HORIZONTAL SCOPE:
  Layers affected: 9 (all new -- greenfield epic, no existing Minerva code)
  Total items: ~26 (8 API methods + 2 workspace-allocation cases + engine spawn/resume +
    extraction + classification + channel enforcement + output write/read + ledger/event +
    state-store read/write conventions)
  New vs modified: 26 new, 0 modified
  Estimated total effort: medium (per design-discussion §8's scale assessment)

  LARGEST LAYER: Run & Workspace Management (two-case allocation logic, now with the
    run-scoped-branch fix, is the most structurally involved single layer)
  RISKIEST LAYER: the Question Extraction / Escalation Classification pair -- both [high] risk
    per design-discussion §4, both unprototyped, and structurally coupled to each other and to
    the Kickoff+Plan Engine's spawn point (see §3's "load-bearing chain" note above)
```
