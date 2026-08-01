# Spike findings — stateless-turn feasibility + minimum reliable model tier

Story: `spike-stateless-model-tier`. All testing via `claude --plugin-dir
/Users/dostal/Documents/work/dostal/code/plugin-hive-fork` against the local fork checkout, per
the epic's own testing-mechanism decision.

## Headline result: this epic's pre-planning finding was WRONG, and the real cause is more
## interesting and more fixable than "pick a bigger model."

The epic's own design discussion (written during planning, before this spike ran) stated:
`claude-haiku-4-5-20251001` does not reliably follow the headless-routing instruction while
`claude-sonnet-4-5` does — recommending a model-tier decision for `ForkedHiveDriver`. **This
spike's controlled, repeated testing shows that conclusion was based on too few data points and
the wrong variable.** The real, root cause has nothing to do with model tier.

## Round 1 (uncontrolled): both tiers "failed," in two different, revealing ways

Running the bare drive prompt (`/plugin-hive:kickoff <idea>`, no further instruction) against
both tiers, three times each across kickoff and design, produced:

- **Haiku, kickoff:** asked the metrics question inline as prose. No envelope written at all.
- **Sonnet, kickoff:** wrote its OWN custom Node.js wrapper scripts (`run-kickoff.mjs`,
  `run-kickoff-interactive.mjs`) that import `question_gateway.js` directly, then looped through
  every phase — writing an envelope, immediately editing in a plausible answer itself, re-running
  the script — all within a single turn, ending with a self-authored `SPIKE-REPORT.md` summarizing
  what it had "validated." It never stopped to let an external orchestrator answer anything.
- **Sonnet, design (the more complex, topic+round-scoped flow):** the same pattern — wrote a
  custom `emit-question.js` wrapper, looped through the wireframe touchpoint itself, completed
  the entire flow (`DESIGN COMPLETE`), and deleted its own helper script at the end.
- **Opus, design:** same self-completing pattern (did not get as far in transcript inspection,
  but produced a finished wireframe with no envelope on disk either).

Confirmed directly from the raw JSONL transcripts (not inferred from the final `result` text
alone) that the full, correct `SKILL.md` content — including the headless-routing paragraph
naming `detect_interactive_mode()`/`ask_or_emit()` explicitly — WAS loaded correctly via
`--plugin-dir` in every case. This was checked carefully after an initial mis-read of a
truncated debug print led to briefly (and incorrectly) suspecting a `--plugin-dir` content-
loading bug; the full file content is present and correct.

## Root cause: writing a file is not, by itself, a turn-ending signal to an agentic model

A normal chat turn naturally ends when the model asks a question in prose — that's ordinary
conversational behavior every model does reliably (confirmed throughout epics
`agent-drivable-core` and `swappable-driver`: SpawnDriver/SubagentDriver's existing prompts,
which ask questions as prose, have never had this problem). Writing a **file** and then stopping
is not a naturally-occurring stopping point for an autonomous coding agent — the model's default,
sensible instinct is to keep working, verify its work, and complete the task it was given. The
existing `SKILL.md` prose ("route it through `ask_or_emit()` instead... the skill writes-and-
exits") states the *intended* behavior but does not include a **forceful, explicit, singular**
instruction that literally means "your response ends here, right now, unconditionally" — and
without that, both tested tiers filled the gap with their own reasonable-seeming initiative
(Haiku: just answer it like a normal question; Sonnet/Opus: build tooling and self-verify
end-to-end). Neither is "wrong" from the model's own perspective — the instruction was
genuinely ambiguous about what should happen the instant a file gets written.

## The fix, confirmed directly: an explicit stop instruction in the DRIVE PROMPT

Appending this to the drive prompt (not modifying the fork's own `SKILL.md` — this is something
`ForkedHiveDriver` controls, exactly analogous to `kickoff-engine.ts`'s existing
`buildDrivePrompt()`):

> IMPORTANT: You are running headlessly with no human present. When the kickoff protocol's
> headless routing tells you to call ask_or_emit()/askOrEmit(), you MUST invoke that real
> function via the Bash tool against hive/lib/question_gateway.py or .js — do NOT write a
> wrapper script that simulates or loops through phases. The MOMENT an envelope is written with
> status: pending, your response MUST end immediately. Do not answer the question yourself, do
> not continue to the next phase, do not simulate what an orchestrator would do. Print the
> envelope path and STOP.

...produced a clean, correct result in **every** subsequent test:

| Test | Model | Skill | Result |
|---|---|---|---|
| Fresh dispatch | `claude-sonnet-4-5` | kickoff | Wrote exactly 1 well-formed envelope (`phase: 1a`, `kind: single-select`), stopped immediately, no wrapper script |
| Fresh dispatch | `claude-haiku-4-5-20251001` | kickoff | Same — 1 envelope, stopped immediately, no wrapper script |
| Fresh dispatch | `claude-sonnet-4-5` | design | Wrote 1 envelope at `phase: touchpoint-1-round-1-spike-test-topic-settings` (correct topic+round-scoped phase id per the schema's Phase-id scoping section), stopped immediately, no wrapper script |
| Stateless resume | `claude-sonnet-4-5` | kickoff | Answered the `1a` envelope directly on disk (no session), then a genuinely **fresh, non-`--resume`** invocation correctly detected the answered-and-now-deleted `1a` envelope, progressed to `project-classification`, wrote a new envelope, stopped immediately |

## Conclusions

1. **Stateless-turn feasibility: CONFIRMED FEASIBLE.** A fresh `claude -p` call with no
   `--resume`/session tracking correctly continues a headless run using on-disk state alone
   (workspace files + the envelope directory), when driven with the explicit-stop instruction.
   `ForkedHiveDriver` does not need session-id juggling the way `SpawnDriver`/`SubagentDriver` do.

2. **Model tier: NOT the limiting factor, and the epic's pre-spike recommendation is superseded.**
   Both `claude-haiku-4-5-20251001` and `claude-sonnet-4-5` correctly comply once given the
   explicit stop instruction. **Recommendation: `ForkedHiveDriver` should use the same
   `MINERVA_DRIVE_MODEL` default (Haiku) as `SpawnDriver`/`SubagentDriver` — no new, more
   expensive model tier is needed.** This directly contradicts the epic's own design discussion
   and the earlier ad-hoc pre-planning tests; those were based on too few uncontrolled samples
   and conflated a prompt-engineering gap with a model-capability gap.

3. **Load-bearing implementation requirement for `real-forked-hive-driver`:** the drive prompt
   `ForkedHiveDriver` sends must always append an explicit, forceful stop instruction (the text
   above, or an equivalent), analogous to how `kickoff-engine.ts`'s `buildDrivePrompt()` already
   composes the idea text into a fixed prompt template. This is not optional polish — without it,
   the driver will observe the self-completing/self-simulating failure mode this spike documented,
   regardless of model tier.

4. **The earlier `kind: yes-no` anomaly (documented in the epic's scope doc / Multica ticket
   PAN-3991) likely does NOT reflect genuine real-gateway behavior.** It was observed in a
   pre-fix, self-simulating Sonnet run — i.e., from a model-improvised wrapper script, not the
   real `question_gateway.js`. Every post-fix envelope observed in this spike correctly used
   `kind: single-select`. **This does not fully retire the defensive-parsing requirement** in
   story `question-answer-type-extension` — it should still be built defensively, since a
   genuinely malformed/self-simulated run remains a real failure mode `ForkedHiveDriver` could
   encounter in production (e.g. if the explicit-stop instruction is ever dropped or a future
   protocol version changes shape) — but the specific `yes-no` example should be treated as an
   observed *symptom of the self-simulation bug*, not confirmed real-gateway output, when citing
   evidence in that story's implementation.

5. **Design's more complex, topic+round-scoped flow uses the identical fix successfully.** No
   evidence found that design specifically needs a stronger model tier than kickoff does, though
   only one round of one touchpoint was exercised — multi-round retry behavior specifically
   (`touchpoint-1-round-2-<topic>`, etc.) was not tested in this spike and remains an item for
   `real-forked-hive-driver`'s own test suite to cover directly.

## What this changes in the epic

- `docs/scope/forked-driver-integration-next-phase.md`'s "minimum reliable model tier" framing
  (open question 6) is resolved: no tier change from the existing default is needed.
- `real-forked-hive-driver`'s dispatch logic must always compose the explicit-stop instruction
  into its prompt — added as an explicit acceptance criterion.
- `question-answer-type-extension`'s defensive-`kind`-parsing requirement is retained, but its
  cited evidence (the `yes-no` example) should be caveated as likely-simulation-artifact, not
  confirmed real-gateway output, pending a clean re-observation.
