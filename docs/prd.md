# Minerva — PRD

Expands `docs/product-brief.md` into testable requirements. Feeds `docs/architecture.md`.

## Requirements Breakdown

### REQ-01: Programmatic kickoff interface (idea in)
- **Source:** product-brief.md P0 "Programmatic kickoff interface"
- **User value:** An agent operator (or, in v2, Auriga) can start a run without a human typing
  into an interactive terminal prompt.
- **Acceptance criteria:**
  - Given a caller with a valid idea payload, when it invokes the kickoff interface, then
    Minerva starts a new isolated run and returns a run identifier.
  - Given a caller with a malformed/incomplete idea payload, when it invokes kickoff, then
    Minerva rejects the request with a structured error rather than starting a run.
  - Given two callers invoking kickoff concurrently with two different ideas, when both
    requests are received, then two independent runs are created without either affecting the
    other's state.

### REQ-02: Agent-drivable Q&A interface (Pantheon ABI, JSON-over-stdio)
- **Source:** product-brief.md P0 "Agent-drivable Q&A interface"
- **User value:** An agent operator can read pending questions and submit answers
  programmatically, without a human present, enabling true async operation.
- **Acceptance criteria:**
  - Given a run has pending questions, when the driving agent requests the current question
    set, then Minerva returns them as structured JSON over stdio.
  - Given the driving agent submits a structured JSON answer for a pending question, when
    Minerva receives it, then the run advances and the answered question is marked resolved.
  - Given the driving agent submits an answer in an invalid schema, when Minerva receives it,
    then Minerva returns a structured validation error and the run does not advance.

### REQ-03: Escalation boundary
- **Source:** product-brief.md P0 "Escalation boundary"
- **User value:** The driving agent only handles routine intake; the human is only interrupted
  for decisions that actually matter.
- **Acceptance criteria:**
  - Given a generated question is classified as routine, when it's surfaced, then it appears on
    the agent-facing Q&A channel and the driving agent may answer it directly.
  - Given a generated question is classified as strategic/ambiguous/irreversible/low-confidence,
    when it's surfaced, then it appears on a separate human-gate channel, not the agent channel.
  - Given the driving agent attempts to answer a human-escalated question directly, when it
    submits that answer, then Minerva rejects it and keeps the question pending on the
    human-gate channel.

### REQ-04: Output / hand-off contract (epic out)
- **Source:** product-brief.md P0 "Output/hand-off contract"
- **User value:** Downstream consumers (a human, or eventually Auriga) get a spec in the exact
  format plugin-hive already understands — no translation step.
- **Acceptance criteria:**
  - Given a run reaches human approval on its final gate, when approval is granted, then
    Minerva writes an epic+stories artifact conforming to plugin-hive's schema and marks the
    run complete.
  - Given a completed run, when a caller requests its output via the programmatic interface,
    then Minerva returns the epic+stories artifact.
  - Given a run has NOT reached final approval, when a caller requests its output, then Minerva
    returns a "not yet approved" status rather than a partial/fabricated epic.

### REQ-05: Concurrency isolation
- **Source:** product-brief.md P0 "Concurrency isolation"
- **User value:** An operator can run ≥3 ideas at once without one run's kickoff clobbering
  another's `project-profile.yaml`, `epics/`, or `cycle-state/`.
- **Acceptance criteria:**
  - Given two runs are started for two different ideas, when both are in progress, then each
    has a distinct working tree and a distinct `.pHive` state path.
  - Given a run writes to its state directory, when that write happens, then no other
    concurrently running run's files are modified.
  - Given a run completes or is aborted, when its isolated resources are cleaned up, then no
    other in-progress run is affected.

### REQ-06: Stall invariant
- **Source:** product-brief.md P0 "Stall invariant"; hard exclusion "never auto-approve /
  never guess"
- **User value:** Preserves the "never guess" hard exclusion even under async, unattended
  operation.
- **Acceptance criteria:**
  - Given a run has an unanswered human-escalated question, when the driving agent polls run
    status, then Minerva reports "waiting on human," not "in progress" or "complete."
  - Given a run is in "waiting on human" state, when time passes with no answer, then Minerva
    does not auto-select a default answer or advance the run.
  - Given a human eventually answers the escalated question, when the answer is submitted, then
    the run resumes from where it held.

### REQ-07: Local CLI convenience wrapper *(P1)*
- **Source:** product-brief.md P1 "Local/CLI convenience wrapper"
- **User value:** Preserves the existing manual workflow as a fallback / for local debugging
  without requiring a driving agent.
- **Acceptance criteria:**
  - Given a human runs the CLI with an idea description, when the command executes, then it
    invokes the same programmatic kickoff interface used by agent operators.
  - Given a human-escalated question arises during a CLI-driven run in the foreground, when the
    CLI is attached, then it prompts the human interactively for an answer.

### REQ-08: Run status/listing across instances *(P1)*
- **Source:** product-brief.md P1 "Basic status/listing"
- **User value:** An operator (or driving agent) can see the state of everything in flight at a
  glance instead of tracking run ids manually.
- **Acceptance criteria:**
  - Given N runs are active, when a caller requests the run list, then Minerva returns all N
    with their current status.
  - Given a run has completed, when the run list is requested, then it still appears (marked
    complete) until explicitly cleaned up.

## Gap Report
- **GAP-01:** Exact message schema for the Q&A JSON-over-stdio protocol is undefined. —
  Evidence: docs/initial-info.md constrains the transport but defers the schema to
  Architecture. — Recommended resolution: define request/response schemas in
  `docs/architecture.md` (REQ-02 depends on it).
- **GAP-02:** Exact confidence/ambiguity threshold logic for escalation classification (REQ-03)
  is undefined. — Evidence: docs/initial-info.md anchors the *principle* (strategic/ambiguous/
  irreversible/low-confidence → escalate) but not the mechanics. — Recommended resolution:
  Architecture doc specifies how classification is computed (rule-based vs. model-judged).
- **GAP-03:** Cleanup/retention policy for isolated run resources (REQ-05) after
  completion/abort is unspecified. — Recommended resolution: Architecture doc defines retention
  policy for worktrees and `.pHive` state per run.
- **GAP-04:** "Bounded wait" duration for the stall invariant (REQ-06) is unspecified. —
  Recommended resolution: confirm in Architecture whether the hold is unbounded by design (most
  consistent with "never guess") or has an operator-configurable ceiling that still never
  auto-resolves.

## Scope Boundaries
**In scope:** see `docs/product-brief.md` → Scope Boundaries → In scope (v1).

**Out of scope:** see `docs/product-brief.md` → Scope Boundaries → Deferred (v2) and Never.

## Priority Matrix
| Feature | User Value | Effort | Priority |
|---------|-----------|--------|----------|
| REQ-01 Programmatic kickoff | High — unblocks async entirely | Medium | P1 |
| REQ-02 Agent-drivable Q&A | High — the core async mechanism | High | P1 |
| REQ-03 Escalation boundary | High — preserves oversight while async | Medium | P1 |
| REQ-04 Output/hand-off contract | High — makes output usable by anything downstream | Medium | P1 |
| REQ-05 Concurrency isolation | High — required for the ≥3-concurrent success metric | Medium | P1 |
| REQ-06 Stall invariant | High — hard exclusion compliance | Low | P1 |
| REQ-07 CLI wrapper | Medium — convenience/fallback, not core loop | Low | P2 |
| REQ-08 Run status/listing | Medium — usability at ≥3 concurrent runs | Low | P2 |

## Success Metrics
See `docs/product-brief.md` → Success Metrics (≥3 concurrent zero-hand-run runs; idea-drop →
approved-epic latency).
