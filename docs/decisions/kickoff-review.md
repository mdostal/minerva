# Minerva — Kickoff Review Decisions (Delphi)

**Date:** 2026-07-24 · **Ruled by:** Mathew, via manual Delphi review of the kickoff docs
(product-brief, PRD, architecture). **Status:** APPROVED with refinements. These update
`docs/architecture.md` and gate `/hive:plan` behind a mandatory PoC spike.

---

## AD-2 — Escalation = structured output + confidence, decided externally
The Escalation Classifier does **not** own the escalate/absorb decision. For each generated
question it emits structured data only:
```
{ question, suggested_channel: "agent" | "human", confidence: 0.0–1.0, reason }
```
An external system (Delphi / Vesta policy) consumes this signal and decides the gate. Minerva
produces the classification + confidence; it does **not** enforce policy. Keep `WRONG_CHANNEL`
as a guard, but treat `suggested_channel` as a suggestion an external policy may override.
*Rationale:* approval policy is central (Vesta = knob, Delphi = enforcer); plugins emit-and-defer.

## AD-4 — No auto-cleanup, but RECORD + EMIT cleanup events
Keep: no automatic GC in v1 — deletion is another system's responsibility. **Add:** on run
completion/abort,
1. append a durable **cleanup-ledger record** — `{ run_id, worktree_path, state_path, status, closed_at }` — to an append-only log, and
2. **emit a `cleanup_needed` event** so an external GC can gather and act later.

Minerva never deletes; it records the record and fires the event. Add the ledger + event sink to
the data model and API surface.

## AD-5 — Unbounded stall hold; resume-from-disk IS pause/resume
Keep: no timeout, ever. The resume-from-disk model gives pause/resume for free — the spike must
confirm a held run resumes cleanly from disk after an arbitrary gap.

## AD-3 / Risk B — Isolated per-run workspace (TWO cases — verified)
Replace "worktree per run" with an explicit two-case base:
- **Idea targets an EXISTING repo** → create a git **worktree off that repo's `dev` branch**.
- **Greenfield idea (no codebase yet)** → a fresh **`git init` scratch repo** in the run dir
  (with an initial commit) as the isolated workspace.

Either way plugin-hive's `.pHive/` always lives inside a valid git repo. (A worktree requires a
parent repo with commits — a greenfield idea has none, so it cannot be a worktree; it must be a
fresh init. This is why one base rule was insufficient.) One paragraph in `architecture.md`.

## NOTE — Nothing advances a run on its own (make explicit)
Add to `architecture.md`: with no daemon, a run only moves when a caller invokes `submitAnswers`.
`getRunStatus: in_progress` between calls means "paused, awaiting the next drive call." No
background progress; no poller should expect autonomous movement.

## Branching (ALL repos)
`main`/`master` = pristine merges only. **`dev` = the default working branch.** Base this
planning and the spike off **`dev`**, and merge back into `dev` as you go. Do not branch off main.

## Risk A — PoC SPIKE FIRST (gates `/hive:plan`) — MANDATORY
Before `/hive:plan`, build a tiny end-to-end walking skeleton that proves the load-bearing
assumption of the whole design:
1. plugin-hive `kickoff` can be invoked **headless / programmatically** (not the interactive TUI),
2. **stopped at a generated question**,
3. run state **persisted to disk**, and
4. **resumed from disk** to continue past that question.

**Deliverable:** the spike code + a short findings doc, mirroring Auriga's lock-spike →
`docs/spike-plugin-hive-drivability-findings.md`.
**Gate:** works → proceed to `/hive:plan`. Doesn't → **STOP**, redesign the engine, do **not**
write stories on a false assumption. This is a PoC gate, not a story.

## Process note (Pantheon-wide)
Tech spikes / PoCs + CBAs become a standard **Delphi phase BETWEEN plan and execute** — an
approval checkpoint and a reusable tool, like the CBAs we run consistently.
Sequence: `kickoff → plan → [Delphi: spike/PoC + CBA + human approval] → execute`.
