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
- **Isolation primitive:** a per-run isolated git workspace — a worktree off the target repo's
  `dev` branch when the idea targets an existing repo, or a fresh `git init` scratch repo (with
  an initial commit) when the idea is greenfield and no codebase exists yet. See AD-3.
- **Underlying engine:** plugin-hive's `kickoff` + `plan` skills, invoked programmatically
  per run rather than interactively.

## No Autonomous Progress

Minerva has no daemon and nothing polls or advances a run on its own. A run only moves when a
caller invokes `submitAnswers` — that is the sole write path that lets the Kickoff+Plan Engine
continue. `getRunStatus: in_progress` between calls does not mean work is happening in the
background; it means the run is **paused, awaiting the next drive call**. No component in this
architecture should be built to expect, or wait for, autonomous movement between calls.

## Components
- **CLI/subprocess entrypoint (`bin/minerva`)** — the single executable. Reads one `{method,
  params}` envelope from stdin per invocation, dispatches, writes one `{result}`/`{error}`
  envelope to stdout, exits. Fresh process per call (see AD-1) — this is the entire external
  surface; there is no daemon.
- **Run Manager** — owns run lifecycle: allocates a run id, an isolated workspace
  (worktree-off-`dev` for an existing-repo idea, fresh git-init scratch repo for a greenfield
  idea — see AD-3), and a namespaced `.pHive` state directory on `startRun`; looks up an
  existing run's paths on every subsequent call.
- **Kickoff+Plan Engine** — wraps plugin-hive's existing `kickoff` + `plan` skills, running them
  headlessly against the run's isolated workspace/state via `claude -p`/`--resume`. Includes a
  **question-extraction step**: headlessly, plugin-hive's `AskUserQuestion`-based gate questions
  are unavailable and the underlying skill degrades to asking them as prose at turn-end (see
  `docs/spike-plugin-hive-drivability-findings.md`), so this component parses the question out
  of that prose rather than reading a structured tool-call payload.

  **As-built (question-extraction story, checkpoint MET — see
  `.pHive/epics/agent-drivable-core/docs/extraction-corpus.md`):** every `claude -p`/`--resume`
  call passes `--json-schema {question: string}`, constraining the driven turn's own final
  output directly rather than parsing free prose after the fact. Two prompt-engineering guards
  in the schema field description were required to hit the convergence bar: an explicit
  "reproduce verbatim, don't paraphrase" instruction, and an explicit "exactly ONE atomic
  question, never batch multiple gates together" instruction (without the latter, one real run
  bundled five upcoming kickoff-protocol gates into a single response, which would have broken
  the engine's one-question-per-turn `submitAnswers` semantics). Result: 16/16 real corpus
  entries extracted cleanly, including both spike-verified phrasings. No prose-parsing fallback
  was needed in practice, though `src/question-extraction.ts` still keeps one for the
  architecturally-real case of a turn ending without the schema firing.

  **As-built (swappable-driver epic):** the mechanism that actually drives a turn is a swappable
  `Driver` (see `src/driver.ts`), not hardcoded into this component. One method, `runTurn(input:
  {cwd, sessionId, prompt}) -> {session_id, raw_result}`, validated against the same
  driver-independent contract (`src/types.test.ts`) regardless of implementation. Three
  implementations: **SpawnDriver** (today's default — `claude -p`/`--resume` via an async
  `child_process.spawn`, with SIGINT/SIGTERM hardening that kills any in-flight child before the
  process exits; empirically confirmed `execFileSync` cannot support this — a signal handler
  never runs while blocked in a synchronous spawn); **SubagentDriver** (opt-in via
  `MINERVA_DRIVER=subagent` — dispatches each turn via `claude --bg`, polled through `claude
  agents --json` until terminal, released via `claude stop`, then extracted via a `-p --resume
  --json-schema` call; confirmed empirically to survive its launching process being SIGKILL'd,
  closing the orphaning gap SpawnDriver's hardening can't reach; also required
  `findCompletedEpic` to search `.claude/worktrees/*` in addition to the workspace root, since
  `--bg` auto-creates its own git worktree whenever the workspace is a git repo, which every
  Minerva workspace always is per AD-3); **ForkedHiveDriver** (inert stub — throws
  `NotImplemented`, not wired into `MINERVA_DRIVER` selection; the seam plugin-hive-fork's future
  structured headless-question protocol drops into with zero ABI change, per
  `docs/minerva-next-tests-and-driver-paths.md` §3). `session_id` is always returned fresh and
  re-persisted after every turn, not just at `startRun` — required because SubagentDriver's
  tracked session id changes on every `--bg --resume` call even though conversation context is
  correctly retained.

  **Post-merge hardening (2026-07-26 production finding):** a real kickoff→planning transition
  turn legitimately runs past the original hardcoded 120s poll ceiling, causing SubagentDriver
  to time out short of planning. The ceiling (shared by SpawnDriver's own spawn timeout and
  SubagentDriver's poll budget) is now `MINERVA_TURN_TIMEOUT_MS`-configurable, defaulting to
  10 minutes. Separately, a poll timeout previously left the underlying `--bg` session running
  and untracked — never `claude stop`'d — accumulating until manually reaped; `SubagentDriver`
  now reaps it on any failure path, not just on success. (An empirical side-investigation into
  whether a `--bg` session needs to be *polled* periodically to stay alive found no evidence for
  that — an unpolled session that reached a terminal state stayed alive and trackable for
  several minutes untouched; the orphaning was purely our own missing `stop` call on timeout.)
- **Escalation Classifier** — for each *extracted* question, emits a structured suggestion
  (`suggested_channel`, `confidence`, `reason`) per the anchored principle (see AD-2). It does
  not itself decide the enforced channel.

  **As-built (escalation-classification story, checkpoint MET — see
  `.pHive/epics/agent-drivable-core/docs/classification-pairs.md`):** the classification fields
  are added directly into the SAME `--json-schema` question-extraction.ts already uses (one
  combined call, not a second model invocation — matches AD-2's "same planning persona, same
  turn" requirement). Result: 10/10 (100%) parseable across a live kickoff-driven corpus, and
  10/10 (100%) correct escalate/absorb judgment against a deliberately diverse curated
  question/expected-channel set spanning both directions of the anchored principle (real
  kickoff gate questions were, without exception, classified `human` — consistent with
  kickoff's protocol design as genuine human decision points; the "agent" side of the
  discrimination proof used constructed synthetic scenarios instead, since real kickoff doesn't
  naturally ask mechanical questions). No fallback to an always-human default was needed.
- **Output Emitter** — on human approval of the final gate, writes the approved epic+stories in
  plugin-hive's native `.pHive/epics/` schema into the run's state dir, and serves it back
  through `getOutput`.
- **Cleanup Ledger / Event Sink** — on run completion or abort, appends a durable ledger record
  and emits a `cleanup_needed` event. Minerva never deletes a workspace itself (see AD-4).
- **State Store** — plain files under the run's `.pHive` dir: run metadata, the question queue
  (with status/answers), and the final output once emitted. No in-memory state survives between
  CLI invocations — everything needed for the next call is read from disk (same statelessness
  principle as the plugin-hive adapter ABI). This is also what makes pause/resume free: a held
  run is just a run whose on-disk state hasn't been advanced yet (see AD-5).

## API Contract

Method list (adapter-ABI-style: `capabilities` first, closed error enum, `abi_version` in every
`capabilities` response):

| Method | Params | Returns | Notes |
|--------|--------|---------|-------|
| `capabilities` | — | `{abi_version}` | Called once by any long-lived caller; declares the Minerva ABI version. |
| `startRun` | `{idea: string, target_repo?: string, constraints?: object}` | `{run_id}` | `target_repo` present → worktree-off-`dev` case; absent → greenfield fresh-init case (AD-3). Allocates the workspace + `.pHive` state; begins kickoff+plan. Resolves REQ-01. |
| `getQuestions` | `{run_id, channel: "agent" \| "human"}` | `{questions: Question[]}` | Returns pending questions whose **enforced** `channel` matches the request (REQ-03). Each question also carries the classifier's original `suggested_channel`/`confidence`/`reason` — see AD-2. |
| `submitAnswers` | `{run_id, channel: "agent" \| "human", answers: Answer[]}` | `{result: {}}` | Rejects (`WRONG_CHANNEL`) an answer submitted on a channel that doesn't match the question's **enforced** channel (REQ-03 AC3). Resolves REQ-02. This is the only method that advances a run — see "No Autonomous Progress" above. |
| `getRunStatus` | `{run_id}` | `{status: "in_progress" \| "waiting_on_human" \| "complete" \| "aborted"}` | Resolves REQ-06's status-visibility AC. `in_progress` between calls means paused, not "working." |
| `getOutput` | `{run_id}` | `{epic: object}` or `NOT_READY` error | Only returns an artifact once the run is `complete` (REQ-04 AC3). |
| `listRuns` | `{}` | `{runs: RunSummary[]}` | P1 / REQ-08. |
| `abortRun` | `{run_id}` | `{result: {}}` | Explicit cleanup trigger — see AD-4. Writes a `CleanupLedgerRecord` and emits `cleanup_needed`; does not delete the workspace. Natural completion (the final `submitAnswers` that closes a run) triggers the same ledger write + event as a side effect. |

### `Question` shape
```json
{
  "id": "string",
  "text": "string",
  "suggested_channel": "agent | human",   // Escalation Classifier's suggestion — not enforced
  "confidence": 0.0,                      // 0.0-1.0, classifier's confidence in the suggestion
  "reason": "string",                     // why the classifier suggested this channel
  "channel": "agent | human",             // ENFORCED routing; defaults to suggested_channel until
                                           // an external policy (v2: Vesta via Delphi) overrides it
  "status": "pending | answered"
}
```
`getQuestions`/`submitAnswers` gate on `channel` (enforced), never on `suggested_channel`. See
AD-2 — Minerva classifies and defers; it does not own approval policy.

### Error codes (closed enum, adapter-ABI-aligned)
`NOT_FOUND` (bad `run_id`), `VALIDATION_FAILED` (malformed payload — resolves REQ-01 AC2 /
REQ-02 AC3), `WRONG_CHANNEL` (answer submitted on a channel that doesn't match a question's
enforced `channel` — resolves REQ-03 AC3), `NOT_READY` (`getOutput` before completion),
`UNKNOWN_METHOD`.

## Data Model
```
Run {
  run_id: string
  workspace_path: string        // git worktree (existing-repo case) or fresh-init repo
                                 // (greenfield case) -- see AD-3
  workspace_kind: worktree | fresh_init
  state_path: string            // namespaced .pHive dir for this run, inside workspace_path
  status: in_progress | waiting_on_human | complete | aborted
  created_at: ISO8601
  questions: Question[]
  output: Epic | null           // plugin-hive epic+stories schema, only set when complete
}

CleanupLedgerRecord {           // appended (never overwritten) on run completion/abort -- AD-4
  run_id: string
  workspace_path: string
  state_path: string
  status: complete | aborted
  closed_at: ISO8601
}
```
The ledger is a shared, append-only log across all runs (not per-run state), so an external GC
process has one place to read from. Each ledger append also emits a `cleanup_needed` event —
same shape as the ledger record plus an event timestamp — following this ecosystem's existing
events-sink convention (plugin-hive's own `<state_dir>/metrics/events/` pattern). Minerva writes
the record and fires the event; it never deletes `workspace_path` or `state_path` itself.

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

**AD-2 — Escalation = structured output + confidence, decided externally.** *(refined
2026-07-24, kickoff review)*
The Escalation Classifier does **not** own the escalate/absorb decision. For each generated
question it emits structured data only — `{question, suggested_channel: agent | human,
confidence: 0.0-1.0, reason}` — judged at question-generation time by the same planning persona
that generates the question, against the anchored principle from docs/initial-info.md (escalate
strategic/ambiguous/irreversible/low-confidence; absorb routine/mechanical/pre-decided). An
external system consumes that signal and decides the **enforced** `channel`: in v2 that's
Delphi's approval surface backed by Vesta policy (Vesta = the policy knob, Delphi = the
enforcer); in v1, with neither wired yet, the enforced channel simply defaults to
`suggested_channel` — nothing currently overrides it. `WRONG_CHANNEL` stays as a guard, but it
guards the enforced `channel`, not the raw suggestion. *Rationale:* approval policy is a
Pantheon-wide concern, not a per-plugin one — Minerva emits classification + confidence and
defers; it does not enforce policy itself. Because the shape is emit-and-defer from the start,
wiring a real external override in v2 requires zero changes to Minerva's classification logic.
*Alternative considered (original, superseded):* the classifier directly deciding and enforcing
`channel` — rejected because it puts approval policy inside a plugin instead of the Pantheon's
policy layer. *Alternative considered:* a standalone rule/keyword classifier — still rejected:
"ambiguous" and "low-confidence" are judgment calls, not lexical patterns. Resolves PRD GAP-02.

**AD-3 — Isolated per-run workspace: two-case base, not a single "worktree per run" rule.**
*(refined 2026-07-24, kickoff review — Risk B)*
A run's isolated workspace is not always a worktree — a worktree requires a parent repo with
commits, and a greenfield idea has none. Two cases, selected by whether `startRun` is given a
`target_repo`:
- **Idea targets an existing repo** → allocate a git **worktree off that repo's `dev` branch**
  (per this project's branching convention: `main`/`master` are pristine-merge-only, `dev` is
  the default working branch).
- **Greenfield idea** (no codebase yet) → allocate a fresh **`git init` scratch repo** in the
  run directory, with an initial commit, as the isolated workspace.

Either way, plugin-hive's `.pHive/` always lives inside a valid git repo — the Kickoff+Plan
Engine's assumption that it's operating inside *some* git repo holds in both cases; only how
that repo came to exist differs. *Alternative considered (original, insufficient):* "worktree
per run" as a single universal rule — rejected because it silently breaks for greenfield ideas,
which have no parent repo to branch a worktree from; one base rule undercounted the actual
case split. *Alternative considered:* a single shared `.pHive` with run-id-prefixed filenames —
still rejected: the Kickoff+Plan Engine invokes plugin-hive's own skills, which assume canonical
`.pHive/` paths; sharing one directory would require patching every downstream skill to be
namespace-aware. Resolves REQ-05 and PRD Open Question #3 / GAP-03's isolation half.

**AD-4 — No automatic cleanup of completed runs in v1; record + emit instead.** *(refined
2026-07-24, kickoff review)*
Minerva still never auto-deletes a run's workspace — deletion is another system's
responsibility. But on every run completion or `abortRun`, Minerva now: (1) appends a durable
`CleanupLedgerRecord` — `{run_id, workspace_path, state_path, status, closed_at}` — to a shared,
append-only ledger, and (2) emits a `cleanup_needed` event so an external GC process can gather
and act later. A completed run's output must remain retrievable via `getOutput` (REQ-04 AC2)
indefinitely by default — Minerva records and signals, it does not delete. *Alternative
considered:* recording nothing and leaving discovery of closed runs entirely to an external
scanner — rejected: without a ledger/event, an external GC has no reliable signal for *when* a
run closed, only what it can infer by re-scanning the filesystem. *Alternative considered:*
TTL-based auto-GC — still deferred to v2; premature without usage data on how long operators
need completed runs retrievable. Resolves PRD GAP-03.

**AD-5 — The stall invariant has no timeout; the hold is unbounded, and resume-from-disk IS
pause/resume.**
`getRunStatus` reports `waiting_on_human` for as long as the escalated question goes
unanswered — indefinitely, with no auto-resolution. Because all durable run state lives on disk
(see State Store above) and nothing advances a run except an explicit `submitAnswers` call (see
"No Autonomous Progress"), a held run resuming after an arbitrary gap is not a special code
path — it's the same resume-from-disk mechanism the run already uses between any two calls. The
Risk-A spike (`docs/spike-plugin-hive-drivability-findings.md`) is what confirms this holds true
for the underlying plugin-hive kickoff+plan engine, not just for Minerva's own wrapper state.
*Alternative considered:* timeout-then-default-answer — rejected outright, not just deferred: it
directly violates the hard exclusion against auto-approving or guessing. Resolves REQ-06 /
PRD GAP-04.

## PRD Gap Report — resolution status
- GAP-01 (Q&A message schema) — **resolved**, see API Contract above.
- GAP-02 (escalation threshold mechanics) — **resolved**, see AD-2.
- GAP-03 (cleanup/retention policy) — **resolved**, see AD-4.
- GAP-04 (stall-wait duration) — **resolved**, see AD-5.
