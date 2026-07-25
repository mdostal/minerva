# Minerva — next work: type-level tests + swappable driver (current sub-agents, future fork)

Context (2026-07-25): Minerva v1 ABI is LIVE and agent-callable. What keeps dying
is the long RUN, because Minerva drives plugin-hive by spawning `claude -p` /
`claude --resume` via child_process (`src/run-manager.ts` execFileSync,
`src/question-extraction.ts`) — those detached procs ORPHAN and hang (two were just
reaped at 38/27 min CPU). Fix strategy: **lock the TYPES with small tests (stable
contract), then make the DRIVER swappable** — sub-agents NOW, the plugin-hive fork
LATER — every driver conforming to the same tested contract.

## 1) Build VALID unit tests around the core TYPES — smallest level

These are the contract every driver path must satisfy. Test each in isolation:

- **`Channel`** (`"agent" | "human"`) — exhaustive; reject anything else.
- **`ClassifiedQuestion`** `{ text, suggested_channel, confidence, reason }`
  (`src/escalation-classification.ts`): valid parse; **safe-default fallback**
  (bad/missing JSON → `{human, confidence:0}`, never guess/throw); confidence
  clamp 0.0-1.0; agent-vs-human boundary (routine+safe-default → agent; strategic/
  ambiguous/irreversible/low-confidence → human).
- **ABI envelope** `{method, params}` → `{result}` | `{error}` (`bin/minerva.ts`,
  `src/dispatch.ts`): one-in/one-out; unknown method → error; malformed input → error.
- **Methods** each: `capabilities`, `startRun`, `getQuestions({channel})`,
  `submitAnswers({question_id, answer})` — **key is `question_id` not `id`**,
  `getRunStatus`, `getOutput`, `listRuns`, `abortRun`.
- **Status** (`in_progress | waiting_on_human | complete | aborted`): legal
  transitions only; `waiting_on_human` blocks until answered (stall invariant);
  answered → advances.
- **Error enum** (`src/errors.ts`): `VALIDATION_FAILED | WRONG_CHANNEL | NOT_READY
  | NOT_FOUND` — each raised by its trigger; closed set.
- **Cleanup-ledger** (`src/cleanup-ledger.ts`, AD-4): events recorded, not acted on.

Property/table-driven where it fits. These tests are the fixed point: they must pass
identically no matter which driver produces the questions.

## 2) DEEP-DIVE the CURRENT solution — sub-agents, NOT forking

The reliability win available RIGHT NOW, without the fork:
- **Problem:** Minerva spawns detached `claude -p`/`--resume` → orphans on
  interrupt, no resume path, no harness tracking.
- **Current path:** drive the plugin-hive turns via the **harness sub-agent
  mechanism** (Claude Code Task/Agent tool) instead of spawning detached claude
  procs. A wrapping agent calls Minerva; Minerva (or the wrapping agent) runs each
  plugin-hive turn as a **sub-agent** — harness-managed, tracked, structured
  return, no orphaned PIDs.
- **Deep-dive to produce:** what changes in `run-manager.ts` / `dispatch.ts` to
  swap the driver from `execFileSync(claude ...)` to a sub-agent request?
  Define a `Driver` interface (one method: run a constrained turn → structured
  result) with two impls: `SpawnDriver` (today, keep for standalone) and
  `SubagentDriver` (harness-managed, preferred). Prove `SubagentDriver` against the
  §1 type tests.

## 3) PREP the FUTURE path — the plugin-hive fork

- The fork (`plugin-hive-fork` / `docs/scope/plugin-hive-headless-question-protocol.md`)
  makes plugin-hive emit **structured headless questions** instead of degrading to
  prose. Minerva then consumes those directly → a third `Driver` impl
  (`ForkedHiveDriver`) with no spawn-and-parse-prose at all.
- Because §1 pins the contract, adding `ForkedHiveDriver` later is a drop-in — the
  ABI/types dont move. Prep now: keep the `Driver` seam clean so the fork slots in.

## Principle
Tests (contract) are stable; the driver is a swappable adapter:
`SpawnDriver (today) → SubagentDriver (now, reliability) → ForkedHiveDriver (future)`.
Validate every driver against the same §1 type tests.
