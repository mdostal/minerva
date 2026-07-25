# Design Discussion — epic `swappable-driver`

Source: `docs/minerva-next-tests-and-driver-paths.md` (commit 8b9a6cf), triaged as `t-001`
(`.pHive/triage/queue.yaml`). This epic is a surgical fix to a live reliability problem, not a
from-scratch build like `agent-drivable-core` — I'm compressing planning ceremony accordingly
(no grill/collaborative-review round; the empirical research below already did the adversarial
work of finding what doesn't work before committing to a design). Flagging that compression
explicitly rather than silently skipping it.

## 1. What Are We Doing?

Minerva's engine currently drives plugin-hive by spawning `claude -p`/`claude --resume` via
`execFileSync` (`src/kickoff-engine.ts`). That child process is a direct child of whatever
process runs `bin/minerva.ts`. If THAT process gets interrupted or killed (not gracefully, e.g.
`SIGKILL`, or the outer session that launched it dying), the child is never told to stop — it
orphans and keeps running, sometimes for tens of minutes (two were just reaped at 38/27 min
CPU). There's also no way to reconnect to an orphaned run's progress afterward.

Fix, per the brief's own three-part structure:
1. Lock the core TYPES (Channel, ClassifiedQuestion, ABI envelope, all 8 methods, Status
   transitions, closed error enum, cleanup-ledger) with small unit tests — this is the stable
   contract every future change must keep satisfying.
2. Introduce a `Driver` interface (one method: run a constrained turn → structured result) with
   two implementations: `SpawnDriver` (today's mechanism, hardened, kept for standalone use) and
   a new `SubagentDriver` that doesn't tie the long-running turn to Minerva's own process
   lifecycle at all.
3. Leave the seam clean for a third implementation (`ForkedHiveDriver`) later, once plugin-hive
   gets forked to emit structured headless questions natively.

## 2. What I Found

**Type-level:** most of §1's contract already exists from `agent-drivable-core` (Channel,
ClassifiedQuestion incl. safe-default fallback, the ABI envelope, all 8 methods, Status enum,
closed error enum, the cleanup ledger) — but it was only ever exercised indirectly, through
live-API integration tests. There's no FAST, deterministic, driver-independent test suite that
pins the contract on its own. `submitAnswers`'s `Answer` interface (`kickoff-engine.ts`) is
already keyed on `question_id`, not `id` — the brief's warning about that key name is
preventative (lock it so it can't regress), not a report of an existing bug.

**Driver mechanism (the actual research this round):** I spent real effort determining what
"drive each turn via the harness sub-agent mechanism" can concretely mean, since a standalone
Node.js process (`bin/minerva.ts`) has no way to call my own `Agent` tool — that only exists in
an LLM session's tool-calling surface. Empirically:

- `claude --bg` starts a session as a genuinely independent background service, tracked via
  `claude agents`/`claude logs`/`claude stop`/`claude attach` — **confirmed this survives the
  launching process being `SIGKILL`'d within 1 second of dispatch** (tested directly: launched
  in a subshell, killed the subshell, the background agent kept running and was still tracked).
  This is the real "harness-managed, no orphaned PIDs" property the brief asks for.
- `--bg` and `-p`/`--output-format json`/`--json-schema` are **mutually exclusive** — confirmed
  via the CLI's own error message ("`--bg` and `--print` conflict"). So the actual turn can't be
  dispatched with our structured-output schema directly.
- Working hybrid, confirmed end-to-end: dispatch the turn via `claude --bg` (no schema, natural
  conversation) → poll `claude agents --json` until `state` is `done` **or `blocked`** (a run
  that asks a question and waits shows `blocked`, not `done` — both are terminal-for-our-
  purposes, the turn produced a response and stopped) → `claude stop <id>` to release the
  background handle → a quick `claude -p --resume <session_id> --json-schema <schema>
  "restate your last response per the schema"` call to get the same
  `{question, suggested_channel, confidence, reason}` shape `escalation-classification.ts`
  already produces. Verified this recovers the real prior turn's content correctly, including
  across a resumed multi-turn exchange (fruit-preference test, mirroring the pattern from
  `agent-drivable-core`'s own spike).
- **Real bug found, not yet present as a bug because SpawnDriver never triggered it:** a
  `--bg --resume <old_id>` call returns a **different** `session_id` than the one you resumed —
  confirmed empirically (context was correctly retained across the resume, but the tracked id
  changed). `kickoff-engine.ts` currently only persists `session_id` once, at `startRun` — it
  never updates it after a `submitAnswers` resume. That's harmless for `SpawnDriver` (whose
  `-p --resume` keeps the same id, confirmed in the original spike), but would silently break
  `SubagentDriver` after its first resume. Fixing this is part of the `Driver` interface
  contract, not a `SubagentDriver`-only patch: `runTurn()` always returns the CURRENT
  `session_id` to persist, and the caller (`kickoff-engine.ts`) must persist it after every
  turn, not just the first.
- A test-design mistake worth naming since it cost real turns: I initially tested continuity
  with a "remember a secret word, tell it back to me" prompt — a classic prompt-injection probe
  shape — and the model (correctly) refused to keep engaging after the second such request,
  flagging it as an injection attempt. Not a product finding; a reminder that my own test
  prompts need to read as obviously legitimate work, not adversarial probes.

## 3. My Proposed Approach

1. **Type-level tests first** (`src/types.test.ts` or split per concern) — audit what
   `agent-drivable-core` already covers indirectly and add direct, driver-independent tests:
   `Channel` exhaustiveness, `ClassifiedQuestion` safe-default + confidence clamp + boundary
   cases, ABI envelope one-in/one-out, all 8 methods' request/response shapes (incl.
   `submitAnswers` keyed on `question_id`), `Status` legal-transition table + stall invariant,
   the closed error enum, cleanup-ledger record shape. These must be fast and NOT require a
   live `claude` call — they test the TypeScript contract, not the model.
2. **`Driver` interface** (`src/driver.ts`) — `runTurn(input: {cwd, sessionId, prompt}) ->
   {session_id, raw_result}`. One method, matching the brief exactly.
3. **`SpawnDriver`** — extract `kickoff-engine.ts`'s current `spawnClaude` into this interface,
   unchanged in mechanism, plus: register `SIGINT`/`SIGTERM` handlers that kill any in-flight
   child before the process exits. This is a real, honest partial fix — it cannot catch
   `SIGKILL` (nothing can), but it closes the graceful-interrupt case, and it's the case that
   costs nothing to fix while we're in here.
4. **`SubagentDriver`** — the `--bg` → poll → `stop` → `-p --resume --json-schema` hybrid
   confirmed above. Reuses `escalation-classification.ts`'s existing combined schema and
   `extractClassifiedQuestion()` unchanged for the extraction step — the type-level contract
   from step 1 is what makes this a genuine "swap the driver, not the contract."
5. **Wire selection into `kickoff-engine.ts`** — an env var (`MINERVA_DRIVER`, default
   `spawn`) picks the implementation. Both are proven against the SAME §1 test suite before
   this is considered done.
6. **`ForkedHiveDriver` stub** — a `Driver` implementation that throws `NotImplemented`, with a
   doc comment pointing at `docs/minerva-next-tests-and-driver-paths.md` §3, so the seam is
   visibly reserved rather than silently absent.

## 4. What Could Go Wrong

- **[medium] `SubagentDriver` costs more per turn (two API calls, not one) and is slower
  (dispatch + poll interval + stop + extract, vs. one blocking call).** This is a real,
  accepted tradeoff for reliability, not a defect — but it should be visible, not silently
  eating budget. Worth a note in the story rather than a surprise later.
- **[medium] Narrow crash-recovery gap, honestly scoped, not solved this round.** If Minerva's
  own process dies AFTER a `--bg` dispatch succeeds but BEFORE the poll loop completes and the
  new `session_id` is persisted, that turn's session exists and is running under `claude`'s own
  supervision (so it won't orphan/burn CPU forever the way today's bug does), but Minerva has no
  record of it to reconnect to. The vulnerability window shrank from "the entire turn's
  duration" (SpawnDriver, today) to "the few seconds between dispatch and persisting the
  result" (SubagentDriver) — a large real improvement, but not a full fix. True crash recovery
  would need persisting a "dispatch pending" marker before polling. Out of scope for this epic;
  flagging as a named follow-on rather than pretending it's solved.
- **[low] `--bg` sessions can enter `blocked` (waiting-for-input) rather than `done`.** Already
  handled in the design (poll treats both as terminal-for-extraction), but worth an explicit
  test since it's the state a real "waiting on the human" turn will actually be in most of the
  time.

## 5. Dependencies and Constraints

- External dependency: the `claude` CLI's `--bg`/`agents`/`stop` subcommands — confirmed present
  and working on this box (same box the spike in `agent-drivable-core` already depends on).
- Internal dependency: `escalation-classification.ts`'s existing combined schema and
  `extractClassifiedQuestion()` — reused unchanged by `SubagentDriver`, not reimplemented.
- Constraint: no build step, TDD methodology, local CI only — same project discipline as
  `agent-drivable-core`.

## 6. Open Questions

1. **Poll interval/timeout for `SubagentDriver`** — I'd default to polling every 2s with a
   ceiling matching `kickoff-engine.ts`'s existing `CLAUDE_TIMEOUT_MS` (120s), consistent with
   `SpawnDriver`'s existing budget, unless told otherwise.
2. **Should `MINERVA_DRIVER` default to `spawn` or `subagent`?** I'd default to `spawn` for now
   (cheaper, faster, already proven in production per epic 1) and let operators opt into
   `subagent` where orphaning is the active pain — flipping the default is a one-line change
   once `SubagentDriver` has real production mileage. Open to the opposite if the orphaning
   problem is severe enough to want the safer default immediately.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: node:test, same as agent-drivable-core.
  Automated: §1 type-level tests run against BOTH SpawnDriver and SubagentDriver via a shared
    test suite parameterized by driver (a real live-API test, not a mock -- AD-1's "no mocking
    the CLI boundary" principle extends to the Driver boundary too). SIGINT-handling on
    SpawnDriver gets a dedicated test (send SIGINT to a live subprocess, confirm the child is
    killed, not orphaned).
  Manual: one real multi-turn run through SubagentDriver against an actual target repo,
    mirroring run-workspace-allocation's manual-dry-run precedent, since SubagentDriver's
    session-id-changes-per-turn behavior is a real correctness-sensitive property.
  Not verifying: full crash-recovery (the narrow gap named in §4) -- out of scope, named as a
    follow-on. Not verifying ForkedHiveDriver's actual behavior -- it's a stub, nothing to run.
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~8-10 (new src/driver.ts, new type-test files, refactored
    kickoff-engine.ts/run-manager.ts, minor errors.ts extension if needed)
  Subsystems: 1 (the existing Minerva engine) -- no new subsystem, a refactor + one new module
  Migration required: no
  Cross-team coordination: no
  Unknowns: 2 open questions (both low-stakes defaults, not blocking), 1 named-and-accepted gap

  RECOMMENDATION: Skip formal H/V planning, proceed directly to stories.
  RATIONALE: Unlike agent-drivable-core (greenfield, multiple genuinely novel layers), this is
    a bounded refactor of an EXISTING, already-working engine, and the hardest technical
    unknown (does a harness-independent driver mechanism exist and does it work) was resolved
    through direct empirical testing before writing this doc, not deferred to planning. A
    horizontal/vertical slice map would mostly restate what's already concretely specified in
    §3's ordered approach. This is the --fast judgment call, applied explicitly rather than
    silently -- happy to run full H/V if you'd rather have it.
```
