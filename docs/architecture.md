# Minerva — Architecture

Resolves `docs/prd.md`'s Gap Report and the "Architecture to resolve" items from
`docs/initial-info.md`. TS default, per project discipline.

## Grounding

Minerva's README calls for "the Pantheon subprocess ABI (interchangeable, any-language)."
That ABI already exists and is documented in the sibling `plugin-hive` repo as the
**task-tracking adapter ABI** (`hive/references/task-tracking-adapter-abi.md`, v1.0.0): a
JSON-over-stdio, `{method, params}` request / `{result}` or `{error}` response envelope,
closed error-code enum, `capabilities` method carrying `abi_version`, semver compatibility
rules. Auriga's own architecture doc (`pantheon-orchestrator/.pHive/planning/architecture.md`,
AD-4) deliberately did **not** use this subprocess form for its internal adapters — it's a
single TS codebase, so in-process calls avoid spawn overhead, while keeping the contract
interfaces swappable to subprocess later.

Minerva is the opposite case: its whole point is to be driven by *any* agent (Claude or
otherwise) and eventually by Auriga, across process boundaries, with each run persisting
across many separate calls over time. So unlike Auriga, Minerva's public interface **is** the
real subprocess ABI — reusing the plugin-hive wire format directly rather than inventing a new
one.

## Tech Stack
- **Language/runtime:** TypeScript on Node.js.
- **Wire format:** JSON-over-stdio, plugin-hive adapter-ABI-compatible envelope.
- **Persistence:** Filesystem only in v1 — no external DB. Run state lives inside each run's
  isolated `.pHive` state directory (see AD-3). Consistent with "no special infrastructure
  requirements" from docs/initial-info.md.
- **Isolation primitive:** git worktrees — the same mechanism this ecosystem's CI/CD model
  already uses per unit of work.
- **Underlying engine:** plugin-hive's `kickoff` + `plan` skills, invoked programmatically
  per run rather than interactively.

## Components
- **CLI/subprocess entrypoint (`bin/minerva`)** — the single executable. Reads one `{method,
  params}` envelope from stdin per invocation, dispatches, writes one `{result}`/`{error}`
  envelope to stdout, exits. Fresh process per call (see AD-1) — this is the entire external
  surface; there is no daemon.
- **Run Manager** — owns run lifecycle: allocates a run id, worktree, and namespaced `.pHive`
  state directory on `startRun`; looks up an existing run's paths on every subsequent call.
- **Kickoff+Plan Engine** — wraps plugin-hive's existing `kickoff` + `plan` skills, running them
  against the run's isolated worktree/state.
- **Escalation Classifier** — tags each question the Kickoff+Plan Engine generates as
  `agent`-answerable or `human`-escalated per the anchored principle (see AD-2), before it's
  added to the run's question queue.
- **Output Emitter** — on human approval of the final gate, writes the approved epic+stories in
  plugin-hive's native `.pHive/epics/` schema into the run's state dir, and serves it back
  through `getOutput`.
- **State Store** — plain files under the run's `.pHive` dir: run metadata, the question queue
  (with status/answers), and the final output once emitted. No in-memory state survives between
  CLI invocations — everything needed for the next call is read from disk (same statelessness
  principle as the plugin-hive adapter ABI).

## API Contract

Method list (adapter-ABI-style: `capabilities` first, closed error enum, `abi_version` in every
`capabilities` response):

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `capabilities` | — | `{abi_version}` | Called once by any long-lived caller; declares the Minerva ABI version. |
| `startRun` | `{idea: string, constraints?: object}` | `{run_id}` | Allocates worktree + `.pHive` state; begins kickoff+plan. Resolves REQ-01. |
| `getQuestions` | `{run_id, channel: "agent" \| "human"}` | `{questions: Question[]}` | Returns pending questions on the requested channel only — the escalation boundary is enforced here (REQ-03). |
| `submitAnswers` | `{run_id, channel: "agent" \| "human", answers: Answer[]}` | `{result: {}}` | Rejects an answer submitted on the wrong channel for a given question (REQ-03 AC3). Resolves REQ-02. |
| `getRunStatus` | `{run_id}` | `{status: "in_progress" \| "waiting_on_human" \| "complete" \| "aborted"}` | Resolves REQ-06's status-visibility AC. |
| `getOutput` | `{run_id}` | `{epic: object}` or `NOT_READY` error | Only returns an artifact once the run is `complete` (REQ-04 AC3). |
| `listRuns` | `{}` | `{runs: RunSummary[]}` | P1 / REQ-08. |
| `abortRun` | `{run_id}` | `{result: {}}` | Explicit cleanup — see AD-4. |

### `Question` shape
```json
{
  "id": "string",
  "text": "string",
  "channel": "agent | human",
  "reason": "string",           // why this was classified onto this channel
  "status": "pending | answered"
}
```

### Error codes (closed enum, adapter-ABI-aligned)
`NOT_FOUND` (bad `run_id`), `VALIDATION_FAILED` (malformed payload — resolves REQ-01 AC2 /
REQ-02 AC3), `WRONG_CHANNEL` (answer submitted on a channel that doesn't own that question —
resolves REQ-03 AC3), `NOT_READY` (`getOutput` before completion), `UNKNOWN_METHOD`.

## Data Model
```
Run {
  run_id: string
  worktree_path: string
  state_path: string            // namespaced .pHive dir for this run
  status: in_progress | waiting_on_human | complete | aborted
  created_at: ISO8601
  questions: Question[]
  output: Epic | null           // plugin-hive epic+stories schema, only set when complete
}
```

## Decisions

**AD-1 — Fresh-subprocess-per-call, JSON-over-stdio, no daemon.**
Reuses plugin-hive's adapter ABI wire format directly instead of inventing a new one — same
envelope, same statelessness discipline (a run's durable state lives on disk, not in process
memory), same "any executable, any language" property the README requires. *Alternative
considered:* a long-lived local HTTP/RPC server — rejected: adds a persistent process to
install/monitor/restart, which fights "interchangeable, any-language" and complicates
per-run isolation. *Alternative considered:* the original file-based stopgap Q&A surface —
superseded by the agent-drivable refinement in docs/initial-info.md; a bare file drop has no
request/response envelope, no error model, and doesn't compose with a driving agent the way a
real ABI call does.

**AD-2 — Escalation classification is judged at question-generation time, against the anchored
principle, not a keyword rule engine.**
The Kickoff+Plan Engine's underlying planning persona (the same one that generates each
question) tags it `agent` or `human` per the principle already anchored in docs/initial-info.md
(escalate strategic/ambiguous/irreversible/low-confidence; absorb routine/mechanical/
pre-decided), and records a short `reason`. *Alternative considered:* a standalone rule/keyword
classifier — rejected: "ambiguous" and "low-confidence" are judgment calls, not lexical
patterns; a keyword rule would either over-escalate (defeats the point of an agent-drivable
loop) or under-escalate (violates the hard "never guess" exclusion). Resolves PRD GAP-02.

**AD-3 — One worktree + one namespaced `.pHive` state directory per run, allocated at
`startRun`.**
Mirrors the worktree-per-unit-of-work pattern already used in this ecosystem's CI/CD model.
*Alternative considered:* a single shared `.pHive` with run-id-prefixed filenames — rejected:
the Kickoff+Plan Engine invokes plugin-hive's own skills, which assume canonical `.pHive/`
paths; sharing one directory would require patching every downstream skill to be
namespace-aware. A full worktree per run keeps plugin-hive's existing skills unmodified.
Resolves REQ-05 and PRD Open Question #3 / GAP-03's isolation half.

**AD-4 — No automatic cleanup of completed runs in v1; `abortRun` is explicit only.**
A completed run's output must remain retrievable via `getOutput` (REQ-04 AC2) indefinitely by
default — auto-deleting it would risk losing an approved spec before it's been consumed.
*Alternative considered:* TTL-based auto-GC — deferred to v2; premature without usage data on
how long operators need completed runs retrievable. Resolves PRD GAP-03.

**AD-5 — The stall invariant has no timeout; the hold is unbounded.**
`getRunStatus` reports `waiting_on_human` for as long as the escalated question goes
unanswered — indefinitely, with no auto-resolution. *Alternative considered:* timeout-then-
default-answer — rejected outright, not just deferred: it directly violates the hard exclusion
against auto-approving or guessing. Resolves REQ-06 / PRD GAP-04.

## PRD Gap Report — resolution status
- GAP-01 (Q&A message schema) — **resolved**, see API Contract above.
- GAP-02 (escalation threshold mechanics) — **resolved**, see AD-2.
- GAP-03 (cleanup/retention policy) — **resolved**, see AD-4.
- GAP-04 (stall-wait duration) — **resolved**, see AD-5.
