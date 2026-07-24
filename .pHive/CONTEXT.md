# Project CONTEXT

Minerva is the Pantheon's Planner — a standalone, agent-drivable engine that turns an idea into
an approved, planned spec via plugin-hive's kickoff+plan flow.

## Terminology

- **Pantheon** — the multi-service system Minerva is one component ("god") of. Sibling gods:
  Auriga (orchestrator — routes, never plans), Vulcan (builder — provisions/maintains repos),
  Delphi (human decision surface), Multica (remote compute / task-tracking substrate).
- **god** — a Pantheon component with one strict responsibility; see README.md § Why it's its
  own thing for the separation rationale.
- **run** — one idea's pass through Minerva's kickoff+plan loop. Identified by `run_id`,
  isolated to its own git worktree and namespaced `.pHive` state directory (see
  docs/architecture.md AD-3).
- **driving agent** — the agent (Claude or any other) that programmatically operates a run:
  starts it, answers agent-channel questions, polls status. This is v1's async mechanism —
  not a UI. See docs/initial-info.md.
- **agent channel / human channel** — the two question queues a run's generated questions split
  into. See `escalation`.
- **escalation** — routing a strategic / ambiguous / irreversible / low-confidence question to
  the human channel instead of leaving it for the driving agent. Judged inline by the planning
  persona at question-generation time, not a keyword rule (docs/architecture.md AD-2).
- **stall** — a run holding in `waiting_on_human` status with no auto-resolution. Unbounded by
  design — never times out into a guessed or default answer (docs/architecture.md AD-5).
- **Pantheon subprocess ABI** — the JSON-over-stdio, `{method, params}` → `{result}`/`{error}`
  wire contract this ecosystem's subprocess-based integrations use. Originally defined in
  plugin-hive's `hive/references/task-tracking-adapter-abi.md`. Minerva's own CLI interface
  reuses this contract directly rather than defining a new one (docs/architecture.md AD-1).

## Key paths

- `docs/initial-info.md` — resolved Product Discovery Brief; source of truth for v1 scope
  (what's in, what's v2, what's never).
- `docs/product-brief.md` → `docs/prd.md` → `docs/architecture.md` — the planning chain, in
  order. Each resolves open items left by the previous one.
- `.pHive/project-profile.yaml` — Hive project profile: `project_type`, `has_ui`,
  `ship_target`, `north_star`, `integrations`.
- `hive.config.yaml` — Hive workflow config: methodology, developer preferences, metrics.

## Conventions

- TS by default. Full TDD discipline: named → interfaced → full TDD → locked.
- Local CI only — no GitHub Actions.
- v1/v2 split: every god-integration (Delphi, Auriga, Vulcan, Multica, votem) is v2, each
  behind a contract, so it swaps in cleanly once that god exists. v1 is standalone.
- Never auto-approve; never let Minerva execute, route, or provision — it only plans.

## Canonical references

- `README.md` — mission and why Minerva is split out from Auriga/Vulcan/Delphi.
- `docs/north-star.md` — original north star (pre-discovery).
- `docs/architecture.md` — component list, API contract, data model, and the 5 architecture
  decisions (AD-1..AD-5).
- `plugin-hive` (sibling repo) `hive/references/task-tracking-adapter-abi.md` — the subprocess
  ABI Minerva's own interface reuses.
- `pantheon-orchestrator` (sibling repo) `.pHive/planning/architecture.md` AD-4 — Auriga's
  contrasting choice (in-process, not subprocess) and why Minerva's case differs.
