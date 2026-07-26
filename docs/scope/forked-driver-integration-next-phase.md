# Minerva — next phase: wire ForkedHiveDriver to the real headless-question-protocol

Seed doc for a future planning kickoff. `firefly-events/plugin-hive#341` (branch
`feat/headless-question-protocol`, `plugin-hive-fork` repo) shipped the real protocol
`ForkedHiveDriver` (`src/driver.ts`) was stubbed against — this captures what changed and the
open design questions a real implementation needs to resolve before `/plugin-hive:plan`
decomposes it into stories.

## What shipped upstream

- `HIVE_HEADLESS=1` env var forces headless mode (`CI=true` also triggers it; default is
  unchanged, interactive).
- `.pHive/questions/<skill>-<invocation-id>.yaml` — one envelope **per skill phase** (not per
  question), batching every question raised at that phase boundary. Full schema:
  `hive/references/question-envelope-schema.md` in the fork.
- Wired into `kickoff`, `design`, and `plan` skills. Interactive behavior is byte-unchanged.
- The skill **writes-and-exits** on a pending envelope — it never sits in a loop watching the
  file. An orchestrator answers by writing `answer:` + `status: answered` directly onto the
  envelope, then re-invokes the skill, which re-reads its own on-disk state (including the
  now-answered envelope) and continues from where it left off.
- Deadline is renewable (OAuth-refresh shape): default 1800s, extend with a later `deadline` +
  incremented `renewal_count` rather than a poll loop. On expiry with no renewal, the gateway
  either re-emits a fresh envelope (default) or fails, per `headless.deadline_expired_action`.
- Explicitly documented as "mirrors Minerva's own `submitAnswers` contract."
- Known gap (upstream): `plan`'s sidecar-retention question isn't wired yet (newer release
  feature, not on the `develop` branch this PR targets).

## Why this is a bigger win than SubagentDriver's mechanism

SubagentDriver's `--bg`/poll/stop/resume-extract dance exists entirely to work around
`AskUserQuestion` being unavailable headlessly — it has to keep a background `claude` session
alive, poll it, then force a *second* `-p --json-schema` call just to get a question back out in
structured form. The real protocol removes the need for a live session across the question
boundary at all: state lives in a **file**, not in a tracked background job. There is no orphan
risk on the question-wait step, because nothing is running while the question is unanswered.

## Open design questions (unresolved — do not guess; these gate the actual story breakdown)

1. **Can each phase invocation be stateless?** The skill's own on-disk state
   (`.pHive/epics/`, and now `.pHive/questions/`) may be sufficient continuity — meaning
   ForkedHiveDriver might not need `--resume`/session tracking *at all* between phases, unlike
   SpawnDriver and SubagentDriver, both of which depend on conversation continuity. This would be
   a meaningful reliability win (no session_id juggling) if true. **Needs an empirical spike**,
   not an assumption — mirrors this project's own "prove it, don't guess" precedent
   (`docs/spike-plugin-hive-drivability-*`).
2. **Question-shape mismatch.** The envelope's question object (`qid`, `text`, `kind`
   [`single-select`\|`multi-select`\|`free-text`], `options`, `required`, `answer`) carries no
   `suggested_channel`/`confidence`/`reason` — AD-2's escalation classification has no upstream
   equivalent. ForkedHiveDriver likely needs its own classification pass over each envelope
   question (reusing `escalation-classification.ts`'s schema/logic, adapted from
   classifying-extracted-prose to classifying-a-structured-question).
3. **`Question`/`Answer` type extension.** Minerva's current types are free-text only. Decide:
   extend to carry `kind`/`options`/`qid` end-to-end (more faithful, more surface area), or
   flatten `single-select`/`multi-select` to free-text for v1 (simpler, loses the option list a
   human channel could otherwise render as real choices).
4. **Multi-question envelopes vs. Minerva's one-question-per-turn model.** A phase can batch
   multiple questions into one envelope (kickoff alone has "7+ prompt points across ~4 phases").
   Minerva's `getQuestions`/`submitAnswers` flow is currently shaped around answering one pending
   question at a time. Confirm whether that composes cleanly against a batch, or whether
   `submitAnswers` needs to accept multiple answers in one call for this driver path.
5. **Deadline renewal ownership.** Does Minerva proactively renew an envelope's `deadline` while
   a question sits waiting on a human (matching AD-5's "unbounded stall is fine" stance), or
   accept the upstream default (`re-emit` on expiry) as an acceptable degraded behavior?

## Proposed story shape (draft — for the planning kickoff to confirm/revise, not to build from directly)

1. Spike: stateless-turn feasibility (resolves open question 1)
2. Envelope detection + parsing (`.pHive/questions/*.yaml` -> typed shape)
3. `Question`/`Answer` type extension decision + implementation (resolves open question 3)
4. Escalation classification for envelope questions (resolves open question 2)
5. Real `ForkedHiveDriver.runTurn()` implementation (dispatch, detect, parse, classify,
   answer-write, re-invoke)
6. Deadline renewal handling (resolves open question 5)
7. `MINERVA_DRIVER=forked` wiring + full regression against the same `types.test.ts` contract,
   mirroring `wire-driver-selection`'s own precedent

## References

- Upstream PR: `firefly-events/plugin-hive#341`
- Upstream epic: `.pHive/epics/headless-question-protocol/` in `plugin-hive-fork`
  (`docs/design-discussion.md`, `docs/pr-description.md`, `hqp-1`..`hqp-7` stories)
- `hive/references/question-envelope-schema.md` (fork) — the schema this doc summarizes
- This repo's `src/driver.ts` — `ForkedHiveDriver` stub + `docs/minerva-next-tests-and-driver-paths.md` §3, the original seam this phase fills in
