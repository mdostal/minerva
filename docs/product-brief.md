# Minerva — Product Brief

Synthesized from `docs/initial-info.md` (Product Discovery Brief). Feeds `docs/prd.md`.

## Problem
Turning an idea into an approved, planned spec today means hand-running `kickoff` + `plan` per
idea, SSH'd into a box, one terminal at a time. That blocks parallel idea intake — an operator
who wants several ideas moving through planning at once has no way to do that without physically
driving each one by hand.

## Target Users
- **Primary:** An agent operator (Claude or any other agent) that programmatically drives
  Minerva — starts a run, answers routine intake questions, escalates strategic/ambiguous/
  irreversible/low-confidence decisions to a human.
- **Also primary:** The human operator, who can feed ideas in directly through the same
  interface and always answers escalated gate questions.
- **Future consumer (v2 wiring):** Auriga, via the same interface an agent-operator uses today.

## Core Features

**P0 — v1, must-have:**
- Programmatic kickoff interface (idea in)
- Agent-drivable Q&A interface over the Pantheon subprocess ABI (JSON-over-stdio) — the actual
  async mechanism for v1
- Escalation boundary: routine/mechanical/pre-decided questions are absorbed by the driving
  agent; strategic/ambiguous/irreversible/low-confidence decisions escalate to a human
  "yes, proceed" gate
- Output/hand-off contract: emits the approved epic+stories in plugin-hive's native format,
  retrievable through the same programmatic interface
- Concurrency isolation: isolated working tree + namespaced `.pHive` state per concurrent run
  (worktree-per-run, mirroring this ecosystem's CI/CD worktree pattern)
- Stall invariant: if an escalated question goes unanswered, the run holds — it does not spin,
  guess, or proceed uninformed

**P1 — v1-adjacent, can slip without breaking the core loop:**
- A thin local/CLI convenience wrapper for direct human-invoked use (SSH'd in, like today)
- Basic status/listing across concurrently running instances

**P2 — explicitly v2, out of v1:**
- Delphi integration (rendered survey/chat human surface)
- Multica remote dispatch (push execution to other boxes)
- votem plugin-based approval gate
- Formal Auriga routing wiring (auto-invocation, response handling)
- Vulcan hand-off automation downstream of an approved spec

## Success Metrics
- **Primary:** ≥3 ideas in flight concurrently, each progressing idea→spec with zero hand-run
  commands per idea (Architecture may tune the target N upward; ≥3 is the v1 floor).
- **Secondary:** Idea-drop → approved-epic latency, unattended except for human answer-gates.
- **Minimum bar:** Drop several ideas, walk away, come back to approved epics without having
  SSH'd in to run a single command per idea.

## Scope Boundaries

**In scope (v1):**
- Standalone operation — no dependency on Delphi, Auriga, Vulcan, Multica, or votem existing
- Agent-drivable programmatic interface (kickoff, Q&A, epic retrieval)
- Human escalation gate (manual checkpoint)
- Concurrency isolation for parallel runs

**Out of scope — deferred (v2), not excluded:**
- Delphi, Multica, votem, formal Auriga wiring, Vulcan automation — each behind a contract so
  it swaps in cleanly once that god exists. Rationale: avoids blocking v1 on every other
  Pantheon component being built first.

**Out of scope — never:**
- Auto-approving a spec/epic without a real human gate on strategic decisions — Rationale:
  explicit hard exclusion; Minerva must not cut corners or proceed when uncertain.
- Minerva executing, routing, or provisioning work itself — Rationale: strict separation of
  concerns; that's Auriga's (routing) and Vulcan's (provisioning) job.
- GitHub Actions / GHA — Rationale: project discipline is local CI only.
- Rogue-overwrite behavior; advancing unlocked/untested parts — Rationale: project discipline
  (named → interfaced → full TDD → locked).
