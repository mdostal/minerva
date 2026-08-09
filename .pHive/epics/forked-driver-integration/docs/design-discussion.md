# Design Discussion — epic `forked-driver-integration`

## 1. What Are We Doing?

Wiring `ForkedHiveDriver` (`src/driver.ts`, currently an inert `NotImplemented` stub left by the
`swappable-driver` epic) to the real headless-question-protocol shipped in
`firefly-events/plugin-hive#341`. This replaces `SubagentDriver`'s `--bg`/poll/stop/resume-extract
workaround — built specifically because `AskUserQuestion` is unavailable headlessly — with a
file-based handoff protocol that removes the orphan-risk boundary entirely, since nothing runs
while a question sits unanswered.

## 2. What I Found

Full detail: `docs/scope/forked-driver-integration-next-phase.md` and
`.pHive/epics/forked-driver-integration/docs/research-brief.md`. Headlines:

- The protocol batches every question raised at a skill-phase boundary into one
  `.pHive/questions/<skill>-<invocation-id>.yaml` envelope. A skill writes-and-exits on a pending
  envelope; an orchestrator answers by writing `answer:`/`status: answered` directly onto it,
  then re-invokes the skill.
- **Delete-on-consume** (load-bearing): the gateway deletes an envelope the instant it extracts a
  `status: answered` envelope's answers. Never an audit trail; never re-readable after answering.
- **Read-vs-consume separation**: design's multi-round flows need a read-only probe distinct from
  the one-time consuming call.
- **PR #341 is converged but not merged upstream** — 17 commits, 4 CodeRabbit rounds, 63/63
  tests, no open findings. Not a blocker: `claude --plugin-dir <path>` loads a plugin from a
  local checkout for one session, confirmed directly against this fork's actual branch. Every
  story tests against the local checkout at `/Users/dostal/Documents/work/dostal/code/plugin-hive-fork`,
  not the marketplace install, until the PR ships in a release.
- **Two empirical findings from direct testing** (this repo, not in the upstream PR): (a)
  headless-routing compliance is model-capability-dependent — Haiku 4.5 does not reliably follow
  the prose-instructed routing mechanism, Sonnet 4.5 does; (b) `kind` is not a validated closed
  enum in practice — a real run produced `kind: yes-no`, outside the documented three-value set.

## 3. My Proposed Approach

Seven stories, largely already drafted (scope doc + Multica board PAN-3989..PAN-3996 — this plan
run confirms/finalizes them as the canonical story YAMLs):

1. **Spike: stateless-turn feasibility + minimum model tier.** Resolve whether each phase
   invocation can be session-id-free (the skill's own on-disk state as continuity, unlike
   SpawnDriver/SubagentDriver) and the minimum model tier that reliably follows headless-routing
   (Haiku confirmed unreliable, Sonnet confirmed reliable; the floor between them is untested).
2. **Envelope detection + parsing.** `.pHive/questions/*.yaml` → typed shape, defensive to
   unexpected `kind` values, read-only (no consume side effects).
3. **`Question`/`Answer` type extension decision + implementation.** Extend to carry
   `kind`/`options`/`qid`, or flatten to free-text for v1 — a real decision, not a default.
4. **Escalation classification for envelope questions.** Reuse/adapt
   `escalation-classification.ts`'s schema+logic for a structured (not extracted-from-prose)
   question.
5. **Real `ForkedHiveDriver.runTurn()` implementation.** Composes 1-4: dispatch, read-only
   detect, classify, consume-and-answer exactly once, re-invoke. Never re-reads a consumed
   envelope.
6. **Deadline renewal ownership.** Proactive renewal vs. accepting upstream's re-emit-on-expiry
   default — scoped strictly to the pre-consumption waiting-on-human window.
7. **`MINERVA_DRIVER=forked` wiring + full regression.** Same contract-validation pattern as
   `wire-driver-selection`'s own precedent from the prior epic.

Dependency order: 1 → {2,3,4 in parallel-ish, 3 blocks 2's typed-parsing target} → 5 → 6 → 7.

## 4. What Could Go Wrong

- **Wrong model-tier choice.** Too cheap silently breaks headless compliance (protocol degrades
  back to interactive prose-asking with no error); too conservative needlessly inflates cost.
  Mitigation: story 1's spike explicitly tests the floor, not just "does sonnet work."
- **Re-reading a consumed envelope.** Delete-on-consume means any code path that tries to
  re-verify an answer by reading the envelope back will find nothing and could misinterpret
  absence as failure. Mitigation: explicit design-decision notes on stories 2 and 5 forbidding
  this; the skill's own next output is the only valid confirmation signal.
- **`kind` parsing throwing on an unrecognized value.** Confirmed empirically that real envelopes
  can carry values outside the documented enum. Mitigation: story 2/3 require defensive
  normalization, not a strict enum match.
- **Testing-mechanism drift.** If a story's test suite accidentally exercises the marketplace-
  installed plugin-hive instead of the local fork checkout via `--plugin-dir`, results would
  reflect stale (pre-PR-341) behavior. Mitigation: every story explicitly names the
  `--plugin-dir` flag and the fork's absolute path in its acceptance criteria.

## 5. Dependencies and Constraints

- Depends on `plugin-hive-fork`'s `feat/headless-question-protocol` branch remaining stable at
  its current commit (or later, if the branch moves) — not on the upstream PR merging.
- No task-tracking adapter is configured for this project (`task_tracking.adapter` is unset in
  `hive.config.yaml`); Phase D publishing is a no-op. The Multica board tickets already filed
  (PAN-3988..PAN-3996) were created manually via `multica issue create`, not through this
  dispatch path — they coexist with this plan's story YAMLs as the source of truth on disk.

## 6. Open Questions

Six open design questions, unresolved by design — each maps to a specific story's own
design-decision sub-step, not to this discussion:

1. Can each phase invocation be stateless? → story 1
2. Question-shape/classification mismatch (no `suggested_channel`/`confidence`/`reason`
   upstream)? → story 4
3. `Question`/`Answer` type extension shape? → story 3
4. Multi-question envelope batching vs. Minerva's one-question-per-turn model + the closure
   invariant's per-envelope (not per-question) completion tracking? → story 5's design (folded
   into the real implementation, since it's the composing story)
5. Deadline renewal ownership? → story 6
6. Minimum reliable model tier? → story 1

## 7. Verification Strategy

Every story tests against a local checkout of `plugin-hive-fork` via `claude --plugin-dir
/Users/dostal/Documents/work/dostal/code/plugin-hive-fork ...` — real, live `claude -p` calls,
same "no mocking the CLI boundary" discipline as every prior epic (AD-1). Story 7's final
regression re-runs the same `src/types.test.ts` contract every other Driver implementation is
validated against, confirming the driver swap doesn't change observable behavior.

## 8. Scale Assessment

**Medium.** Multi-file (driver.ts additions, possibly new type/classification modules, test
files), multiple conceptual layers (protocol parsing, type design, classification, driver
composition, wiring), but a single cohesive feature — not a multi-system migration. Directly
comparable in shape and size to `swappable-driver`'s own `subagent-driver` story (one new Driver
implementation added to an existing, proven abstraction). Recommend skipping H/V ceremony and
proceeding straight to stories, mirroring `swappable-driver`'s own precedent — the scope doc
already did the decomposition-informing research; H/V would re-derive rather than add value here.
