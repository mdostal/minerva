# Minerva — Initial Info / Product Discovery Brief

Captured during `/plugin-hive:kickoff` greenfield discovery. Feeds `.pHive/planning/product-brief.md` → `prd.md` → `architecture.md`.

**TL;DR:** v1 = a standalone, agent-drivable idea→spec runner. A human or an agent operator
(Claude / any agent) feeds an idea in through a programmatic interface; Minerva runs kickoff+plan,
answers routine questions itself when driven by an agent, escalates only strategic/ambiguous/
irreversible/low-confidence calls to a human "yes, proceed" gate, and emits an approved
plugin-hive epic+stories. All god-integrations (Delphi, Auriga, Vulcan, Multica, votem) are v2,
each behind a contract so they swap in cleanly once those gods exist.

## Problem Statement
Turning an idea into an approved, planned spec today means hand-running `kickoff` + `plan`
per idea, SSH'd into a box, one terminal at a time. That doesn't scale once you want to push
several ideas through in parallel — across repos, across boxes.

## Target Users
- **Primary persona:** An "agent operator" — Claude or any other agent — that programmatically
  drives Minerva's kickoff+plan flow: starts a run, monitors it, answers routine intake
  questions, and escalates only strategic/uncertain decisions to a human.
- **Also primary (not secondary):** The human operator, who can feed ideas in directly through
  the same interface, and who is always the one who answers escalated gate questions. Audience
  is **both** human-initiated and service-initiated — not "just me" (drops the Auriga path) and
  not "services only" (drops the direct human feed).
- **Consumer:** Auriga (the orchestrator) — nothing prevents Auriga from invoking Minerva
  through the same programmatic interface an agent-operator uses today; formal Auriga-side
  routing/wiring is v2, but the interface is not Auriga-specific throwaway work.
- **User evidence:** Personal experience — the operator is doing this by hand today, across
  multiple terminals/repos.

## Competitive Landscape — resolved
The real alternative is literally hand-running `/hive:kickoff` + `/hive:plan` per idea in a
terminal — serial, babysat, one-at-a-time. No off-the-shelf tool does "idea → autonomous
kickoff/plan → human-gated → approved spec, in parallel": PM/AI tools (Linear/Notion AI, PRD
generators) are surface-level doc helpers; agent frameworks (LangGraph/CrewAI/etc.) are
*execution* frameworks, not idea-to-spec-with-gates. The bar is "better than by hand" (async,
parallel, non-babysat), and the moat is wrapping plugin-hive's proven kickoff+plan as a
parallel, human-gated planning service. No further competitive CBA needed here (unlike Auriga's
real market) — the differentiator is clear.

## Value Proposition
- **Core differentiator:** A programmatic, agent-drivable kickoff+plan interface with a built-in
  escalation boundary — routine Q&A handled by the driving agent, strategic decisions surfaced
  to a human gate. No other Pantheon component does this: Auriga routes, Vulcan provisions,
  Delphi is a (future) UI.
- **Unfair advantage:** Built directly on plugin-hive's already-proven kickoff+plan flow —
  not reinventing planning, just making it agent-drivable and parallelizable.
- **Switching motivation:** An operator (or Auriga) stuck hand-running the CLI flow per idea can
  instead spin up N Minerva sessions and let driving agents carry the routine load.

## Success Metrics — anchored
- **Primary:** **≥3 ideas in flight concurrently, each progressing idea→spec with ZERO
  hand-run commands per idea** — true async drop-in: ideas are fed in, they plan themselves in
  parallel, the human only answers escalated gate questions. Architecture may tune the target N
  upward; ≥3 is the v1 floor, not a ceiling.
- **Secondary:** Idea-drop → approved-epic latency, unattended except for human answer-gates.
- **Minimum success bar:** Drop several ideas, walk away, come back to approved epics — without
  having SSH'd in to run a single command per idea.

## MVP Scope

**In v1:**
- **Agent-drivable programmatic kickoff + Q&A interface** — an agent (Claude or other) starts a
  Minerva run, receives generated human-gate questions, submits answers, and iterates. This is
  the actual async mechanism for v1 (not a file-based stopgap — see refinement below). *User
  value:* removes the requirement for a human to hand-run kickoff+plan per idea.
- **Escalation boundary** — Minerva distinguishes routine questions (answerable by the driving
  agent) from strategic/uncertain decisions that must be escalated to a human "yes, proceed"
  checkpoint. *User value:* async operation without sacrificing real oversight on decisions
  that matter.
- **Output/hand-off contract** — Minerva emits the approved work in plugin-hive's native
  epic+stories format (the same schema plugin-hive already writes to `.pHive/epics/`), retrievable
  through the same programmatic interface used to drive the run. *User value:* symmetric contract
  — what goes in (idea) and what comes out (approved epic) are both programmatic, so v2's Auriga
  wiring is "start calling the existing interface," not new integration work.
- **Concurrency isolation** — each concurrent Minerva run gets its own isolated working tree and
  `.pHive` state (mirroring the worktree-per-unit-of-work pattern already used in this
  ecosystem's CI/CD model), namespaced by run/idea id. *User value:* parallel ideas don't stomp
  each other's `project-profile.yaml`, `epics/`, or `cycle-state/`.
- **One interface, two callers** — the same programmatic interface serves both the
  agent-operator path and (eventually) the Auriga routing path. *User value:* single integration
  surface, not two.
- **Local/SSH execution** (today's model). *User value:* ships v1 without needing Multica
  remote dispatch built first.
- **Stall invariant** — if a run can't get an answer to an escalated question, it holds and
  waits; it does not spin, guess, or proceed uninformed. Same invariant as Auriga.

**Deferred to v2+:**
- **Delphi integration** (rendered survey/chat human surface) — v1's escalation is a manual
  "yes, proceed" checkpoint through the agent-drivable interface; Delphi is a nicer *human*
  surface layered on top later, not a blocker.
- **Multica remote dispatch** (push compute to other boxes) — v1 runs local/SSH; distributed
  execution is an execution-model upgrade, not core to proving the agent-drivable interface.
- **votem plugin-based approval** — v1 uses a manual human gate; votem is a richer
  quorum/approval mechanism for later.
- **Formal Auriga routing wiring** — v1's interface is Auriga-compatible by design, but Auriga
  isn't wired to call it automatically yet.

**Hard exclusions (never):**
- **Auto-approving a spec/epic without a real human gate on strategic decisions** — Minerva
  must not cut corners or proceed when uncertain or under-informed.
- **Minerva executing, routing, or provisioning work itself** — that's Auriga's (routing) and
  Vulcan's (provisioning) job; Minerva only plans.
- No GHA; no rogue-overwrite; no advancing unlocked/untested parts (per project Discipline).

## Technical Constraints
- **Platform:** Service / subprocess — no direct UI (`has_ui: false`). TS by default; Pantheon
  subprocess ABI (any-language, interchangeable).
- **Performance:** No real-time requirements; async/long-running per idea is fine; must support
  ≥3 concurrent instances (one per repo / idea-intake session) without collision.
- **Compliance:** None identified.
- **Infrastructure:** Local/SSH execution for v1; Multica-based remote compute dispatch is a
  v2 infrastructure upgrade. Concurrency isolation (worktree + namespaced `.pHive` state) is a
  v1 requirement regardless of where execution happens.
- **Q&A transport:** Constrained to the Pantheon subprocess ABI already in use across this
  ecosystem — JSON-over-stdio. Architecture picks the exact message schema, but the transport
  must not fight the ABI (e.g. no one-off flat-file protocol as a permanent mechanism — the
  earlier file-based stopgap idea is superseded by the agent-drivable refinement below).
- **Escalation trigger — anchored principle:** Escalate what is strategic, ambiguous,
  irreversible, or low-confidence. Absorb what is routine, mechanical, or already decided.
  Architecture refines the exact boundary/threshold logic, but this is the governing principle,
  not an open question.
- **Integrations:**
  - v1 — none required as external dependencies; the same programmatic interface an
    agent-operator drives is Auriga-compatible by construction.
  - v2+ — Delphi (human surface), Multica (remote compute), votem (approval plugin), Vulcan
    (provisioning handoff downstream of an approved spec), formal Auriga routing wiring.

## Key Decisions Made
- Minerva's async story for v1 is **agent-drivable**, not **UI-drivable** — an agent operator
  plays the role Delphi will play in v2. (This superseded an earlier file-based "stopgap
  question surface" idea, which doesn't actually deliver async — someone would still have to
  watch and answer it.)
- Human escalation is scoped to strategic/ambiguous/irreversible/low-confidence decisions only,
  not every intake question — the driving agent absorbs routine Q&A.
- The programmatic kickoff+Q&A interface is intentionally the same for both a human's
  agent-operator and for Auriga's (future) routing calls — one interface, two callers.
- The interface is symmetric: idea-in (programmatic) and epic-out (programmatic, plugin-hive
  format) — not just an input contract.
- Never build in auto-approval or give Minerva execution/routing/provisioning responsibility —
  strict separation of concerns from Auriga/Vulcan is a hard boundary, not a preference.
- All god-integrations (Delphi/Auriga/Vulcan/Multica/votem) are v2, each behind a contract, to
  avoid the chicken-and-egg of blocking Minerva on every other god existing first.

## Open Questions
All prior open questions are now resolved or anchored (see Success Metrics, Competitive
Landscape, and the Escalation trigger / Q&A transport constraints above). Remaining for
Architecture to resolve, not Discovery:
1. Exact Q&A message schema over the JSON-over-stdio transport.
2. Exact confidence/ambiguity threshold logic within the anchored escalation principle.
3. Exact worktree/state-namespacing scheme for concurrency isolation (per-run directory naming,
   cleanup policy, collision detection).

## Session Notes
Discovery ran as a short conversational Q&A rather than a full 7-area form, since README.md and
docs/north-star.md already answered Problem Space and most of Target Users going in. The
richest discussion was MVP boundary definition: v1's "async" story doesn't require Delphi,
Multica, or votem at all — those are v2 infrastructure upgrades. v1 just needs Minerva to expose
a programmatic interface an agent can drive, with a hard-line human gate on real decisions. A
review pass afterward closed the remaining gaps: the brief had specified the input contract
(idea-in) but not the symmetric output contract (epic-out), and had said "multiple concurrent
instances" without saying how they avoid colliding — both are now folded in above, along with
anchoring the three items that were previously left open.
