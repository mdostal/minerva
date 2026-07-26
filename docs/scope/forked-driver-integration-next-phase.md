# Minerva — next phase: wire ForkedHiveDriver to the real headless-question-protocol

Seed doc for a future planning kickoff. `firefly-events/plugin-hive#341` (branch
`feat/headless-question-protocol`, `plugin-hive-fork` repo) shipped the real protocol
`ForkedHiveDriver` (`src/driver.ts`) was stubbed against — this captures what changed and the
open design questions a real implementation needs to resolve before `/plugin-hive:plan`
decomposes it into stories.

**Status as of 2026-07-26: converged, ready for merge review.** 17 commits, 4 rounds of
CodeRabbit review, 63/63 tests passing (32 py + 19 js + 12 bash), no known open findings,
planning docs reconciled against final shipped behavior (a real drift-check pass, not just
"tests pass so we're done" — see `docs: reconcile planning artifacts against final shipped
behavior (hqp-7 drift-check)`), and a **live end-to-end smoke test** (a real `claude -p
--plugin-dir` session, not just diff review) confirmed headless detection, envelope write,
resume-consume-without-reprompt, and correct progression to the next phase. Independently
re-verified from this repo on 2026-07-26 (see "Independent verification" below): 12/12 hook
tests, 19/19 js + 19/19 py gateway tests, all pass locally.

## What shipped upstream

- `HIVE_HEADLESS=1` env var forces headless mode (`CI=true` also triggers it; default is
  unchanged, interactive).
- `.pHive/questions/<skill>-<invocation-id>.yaml` — one envelope **per skill phase** (not per
  question), batching every question raised at that phase boundary. Full schema:
  `hive/references/question-envelope-schema.md` in the fork.
- Wired into `kickoff` (6 phases, 7 questions — corrected from the plan-time estimate of 4
  phases/5 questions once the actual touchpoints were counted), `design`, and `plan` skills.
  Interactive behavior is byte-unchanged.
- The skill **writes-and-exits** on a pending envelope — it never sits in a loop watching the
  file. An orchestrator answers by writing `answer:` + `status: answered` directly onto the
  envelope, then re-invokes the skill, which re-reads its own on-disk state (including the
  now-answered envelope) and continues from where it left off.
- **Deletion on consume (added in review round 3 — load-bearing, not cosmetic).** The gateway
  deletes an envelope file the moment it successfully extracts a `status: answered` envelope's
  answers on resume — it does **not** persist as an answered record. This exists because skill
  phase ids (`1a`, `1b`, etc.) are reused across genuinely separate invocations of the same
  skill (e.g. a re-kickoff months later reuses phase `1a`); without deletion, a stale answered
  envelope would match forever and silently short-circuit every future invocation's prompts.
  **Consequence for ForkedHiveDriver:** never try to re-read an envelope after answering it to
  confirm the answer landed — it will be gone. The only correct confirmation signal is the
  skill's own next output (progression to a new phase, a new envelope, or completion). Also:
  the envelope is not an audit trail — if Minerva wants a durable record of what was
  asked/answered, that's Minerva's own responsibility to persist (e.g. onto the `RunRecord`),
  not something to read back off the protocol.
- **Read-vs-consume separation (design's multi-round flows specifically).** `design`'s
  touchpoints can loop across several rounds before resolving
  (`touchpoint-1-round-1-<topic>`, `touchpoint-1-round-2-<topic>`, ...), and determining which
  round is "current" requires probing multiple candidate phase ids. The gateway exposes two
  distinct primitives for this: `find_envelope_for_phase`/`findEnvelopeForPhase` is read-only
  reconnaissance that never deletes (safe to call repeatedly while probing rounds);
  `ask_or_emit`/`askOrEmit` is the only call that ever extracts-and-deletes. A driver
  implementation must preserve this distinction — round-probing must go through the read-only
  path, and the actual consume must happen exactly once, via `ask_or_emit`'s equivalent
  behavior (reading the file, extracting `answer`s, then treating it as gone).
- **Design's phase-id scoping is topic-embedded**, not simple, because `/design` supports
  multiple concurrent topics (`.pHive/design/<topic>/`) — phase ids always carry the topic
  slug plus a round-counter suffix. Kickoff/plan use simple phase ids because (combined with
  delete-on-consume) at most one invocation is ever in flight per project for those skills.
- Deadline is renewable (OAuth-refresh shape): default 1800s, extend with a later `deadline` +
  incremented `renewal_count` rather than a poll loop. On expiry with no renewal, the gateway
  either re-emits a fresh envelope (default) or fails, per `headless.deadline_expired_action`.
  Renewal only has meaning **before** an envelope is consumed — once deleted, there is nothing
  left to renew.
- Explicitly documented as "mirrors Minerva's own `submitAnswers` contract."
- Known gap (upstream, unchanged across all 4 review rounds): `plan`'s sidecar-retention
  question isn't wired yet (newer release feature, not on the `develop` branch this PR
  targets).

## Testing against the fork before it merges upstream

`firefly-events/plugin-hive#341` is open but not yet merged. **This does not block implementation
or testing** — `claude`'s `--plugin-dir <path>` flag loads a plugin from a local directory for
one session, bypassing the installed marketplace/cache copy entirely. Confirmed directly (this
repo, 2026-07-26): `claude -p --plugin-dir /path/to/plugin-hive-fork ...` against the fork's
actual `feat/headless-question-protocol` checkout correctly loads the fork's skills/hooks —
Stop-hook artifacts and headless-mode envelope files were both produced from the fork's own
code, not the marketplace install. `ForkedHiveDriver`'s implementation and every story's test
suite should point at a local checkout of the fork via this flag until #341 ships in a real
plugin-hive release — there is no reason to wait on the merge, and doing so would just stall
this epic behind an unrelated review-and-merge timeline.

## Two new findings from direct empirical testing (this repo, 2026-07-26) — not in the PR description

**1. Headless-routing compliance is model-capability-dependent, not just code-dependent.** The
whole "check `detect_interactive_mode()`, route through `ask_or_emit()`" mechanism is
*prose-instructed* in each skill's `SKILL.md` — there is no code that intercepts or enforces it;
the model has to actually read and follow that instruction. Tested identically against the same
fork checkout, same `HIVE_HEADLESS=1`, same fresh-kickoff prompt:

- `claude-haiku-4-5-20251001` (Minerva's current default drive model) **did not** follow the
  headless-routing instruction — it asked the metrics question inline as prose, exactly as if
  headless mode were off, and wrote no envelope file at all.
- `claude-sonnet-4-5` **did** follow it correctly and reliably across two independent
  invocations (fresh kickoff writing 3 envelopes across phases `1a`/`1b`/`project-classification`;
  resume after answering `1a`, which correctly deleted that envelope, reported the answer,
  and listed the two still-pending envelopes untouched).

**Consequence:** ForkedHiveDriver almost certainly cannot inherit SpawnDriver/SubagentDriver's
cost-optimized Haiku default (`MINERVA_DRIVE_MODEL`) — that default would make the whole
protocol silently degrade back to prose-asking, defeating the point of building this driver.
Needs its own model-tier decision, and the stateless-turn spike (story 1) should establish the
*minimum* reliable tier empirically (only Haiku vs. Sonnet has been tested so far — Haiku 4.5
vs. Opus, or a cheaper Sonnet variant, is unexplored), not just re-use "sonnet worked once."

**2. `kind` is not a strictly-enforced closed enum in practice, despite being documented as
one.** The schema doc states `kind: single-select | multi-select | free-text`, and the gateway
code (`question_gateway.py`'s `ask_or_emit`) does nothing to validate or constrain it —
`q.get("kind", "single-select")` just passes through whatever value the calling skill (i.e. the
model, writing the envelope via its own tool calls per `SKILL.md`'s prose instructions) decided
to use. A real Sonnet-driven kickoff run wrote `kind: yes-no` for the metrics opt-in question —
a value that appears nowhere in the documented enum. **Consequence:** Minerva's envelope-question
parsing (open question 3 below) cannot assume `kind` is closed to the three documented values —
it must handle/normalize unexpected values defensively (e.g. treat any unrecognized `kind` as
free-text, or specifically recognize `yes-no` as a `single-select` with implied `[yes, no]`
options) rather than throwing or silently misparsing.

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
   human channel could otherwise render as real choices). Either way, `kind` parsing must be
   defensive — confirmed empirically that real (Sonnet-driven) envelopes can carry a `kind`
   value (`yes-no`) outside the three documented enum values; the gateway does not validate it.
4. **Multi-question envelopes vs. Minerva's one-question-per-turn model.** A phase can batch
   multiple questions into one envelope (kickoff's 6 phases carry 7 questions total). Minerva's
   `getQuestions`/`submitAnswers` flow is currently shaped around answering one pending question
   at a time. Confirm whether that composes cleanly against a batch, or whether `submitAnswers`
   needs to accept multiple answers in one call for this driver path. Note the closure
   invariant: an envelope is only consumable once EVERY `required: true` question in it has a
   non-null answer — a partial batch answer leaves the envelope `pending`, not consumed, so
   Minerva must track per-envelope completion, not just per-question.
5. **Deadline renewal ownership.** Does Minerva proactively renew an envelope's `deadline` while
   a question sits waiting on a human (matching AD-5's "unbounded stall is fine" stance), or
   accept the upstream default (`re-emit` on expiry) as an acceptable degraded behavior? Since
   renewal only applies pre-consumption (see "Deletion on consume" above), this is purely about
   the waiting-on-human window, not anything post-answer.
6. **Minimum reliable model tier.** Confirmed empirically that `claude-haiku-4-5-20251001`
   (Minerva's current cost-optimized default) does not reliably follow the headless-routing
   instruction (see "Two new findings" above) while `claude-sonnet-4-5` does. The stateless-turn
   spike (story 1) should establish the actual minimum viable tier — untested territory beyond
   these two data points — since a wrong choice either silently breaks headless compliance
   (too cheap) or needlessly inflates cost (too conservative).

## Proposed story shape (draft — for the planning kickoff to confirm/revise, not to build from directly)

1. Spike: stateless-turn feasibility + minimum reliable model tier (resolves open questions 1
   and 6) — must test against a local checkout of `plugin-hive-fork` via `--plugin-dir`, not
   wait for #341 to merge/ship
2. Envelope detection + parsing (`.pHive/questions/*.yaml` -> typed shape), defensive to
   unexpected `kind` values
3. `Question`/`Answer` type extension decision + implementation (resolves open question 3)
4. Escalation classification for envelope questions (resolves open question 2)
5. Real `ForkedHiveDriver.runTurn()` implementation (dispatch, detect, parse via the read-only
   probe path, classify, answer-write via the consume path, re-invoke) — must respect the
   read-vs-consume separation (probe with `find_envelope_for_phase`'s equivalent, consume
   exactly once) and never attempt to re-read a consumed envelope
6. Deadline renewal handling (resolves open question 5)
7. `MINERVA_DRIVER=forked` wiring + full regression against the same `types.test.ts` contract,
   mirroring `wire-driver-selection`'s own precedent

## Independent verification (this repo, 2026-07-26)

Re-ran the upstream test suites directly against the `feat/headless-question-protocol` branch
(17 commits, post all 4 CodeRabbit review rounds) from a checkout of `plugin-hive-fork`:
`hooks/test/metrics-stop-dispatch.test.sh` (12/12), `hive/lib/test/question_gateway.test.mjs`
+ `runtime_mode.test.mjs` via vitest (19/19), and the Python equivalents via pytest (19/19).
All pass cleanly. This is in addition to the Stop-hook fix (#341's `hqp-6`) already verified
end-to-end against a real Minerva `SubagentDriver` run in the swappable-driver epic — see
`.pHive/epics/swappable-driver/` commit history and PR #2's description in this repo.

Also ran two real, separate `claude -p --plugin-dir <fork-checkout>` sessions against the fork
(not the marketplace install, not a simulation): a fresh headless kickoff with
`claude-sonnet-4-5` correctly wrote 3 envelopes across phases `1a`/`1b`/`project-classification`;
answering `1a` and re-invoking correctly deleted that envelope, reported the answer, and left
the other two envelopes' `status: pending` untouched — direct, first-hand confirmation of
delete-on-consume and phase-batching, not just review of the PR's own claims. See "Two new
findings" above for the model-tier and `kind`-enum discoveries this testing surfaced.

## References

- Upstream PR: `firefly-events/plugin-hive#341`
- Upstream epic: `.pHive/epics/headless-question-protocol/` in `plugin-hive-fork`
  (`docs/design-discussion.md`, `docs/pr-description.md`, `hqp-1`..`hqp-7` stories)
- `hive/references/question-envelope-schema.md` (fork) — the schema this doc summarizes,
  including the "Deletion on consume" and "Phase-id scoping" sections added in the drift-check
  pass
- This repo's `src/driver.ts` — `ForkedHiveDriver` stub + `docs/minerva-next-tests-and-driver-paths.md` §3, the original seam this phase fills in
