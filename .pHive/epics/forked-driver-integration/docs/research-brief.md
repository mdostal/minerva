# Research Brief — forked-driver-integration

Research for this epic was performed incrementally across the tail end of the `swappable-driver`
epic and a dedicated follow-up investigation, and is captured in full at
`docs/scope/forked-driver-integration-next-phase.md` (this repo, `dev` branch) — that document is
the primary research artifact and is treated as authoritative; this brief summarizes it for the
planning flow's canonical path.

## Tech stack / architecture (unchanged from prior epics)

TypeScript, `node:test`, no framework. Minerva's `Driver` abstraction (`src/driver.ts`,
introduced in epic `swappable-driver`) already defines the seam this epic fills in:
`ForkedHiveDriver` exists as an inert stub throwing `NotImplemented`, alongside working
`SpawnDriver` and `SubagentDriver` implementations, all validated against the same
driver-independent contract in `src/types.test.ts`.

## What this epic is

Wire `ForkedHiveDriver` to the real headless-question-protocol shipped in
`firefly-events/plugin-hive#341` (branch `feat/headless-question-protocol`, checked out locally
at `/Users/dostal/Documents/work/dostal/code/plugin-hive-fork`). That protocol replaces the
`AskUserQuestion`-unavailable-headlessly workaround `SubagentDriver` exists for
(`--bg`/poll/stop/resume-extract) with a file-based handoff: `.pHive/questions/*.yaml` envelopes
that a skill writes-and-exits on, and an orchestrator answers by writing directly onto the file.

**PR #341 status:** converged (17 commits, 4 rounds of CodeRabbit review, 63/63 tests, no known
open findings) but not yet merged upstream. This is not a blocker — `claude --plugin-dir <path>`
loads a plugin from a local checkout for one session, confirmed working directly against this
fork's branch. Every story in this epic implements/tests against the local fork checkout via
that flag; the upstream merge timeline is orthogonal to this epic's own work.

## Key findings (full detail in the scope doc)

1. **Envelope schema**: one file per skill *phase* (batches every question raised at that
   boundary), not per question. `id`/`skill`/`phase`/`status`/`provenance`/`deadline`/
   `renewal_count` + a `questions[]` array of `{qid, text, kind, options, required, answer}`.
2. **Delete-on-consume** (load-bearing, added in PR #341's review round 3): the gateway deletes
   an envelope the instant it extracts a `status: answered` envelope's answers — it is not an
   audit trail, and a driver must never try to re-read one after answering it.
3. **Read-vs-consume separation** (review round 4): a read-only probe primitive exists
   separately from the one-time consuming call, needed for design's multi-round flows.
4. **Two empirical findings from direct testing this repo did against the fork** (not in the
   upstream PR description):
   - Headless-routing compliance is **model-capability-dependent**: `claude-haiku-4-5-20251001`
     (Minerva's current cost-optimized default) does not reliably follow the prose-instructed
     "check headless, route through the gateway" mechanism; `claude-sonnet-4-5` does, reliably.
   - `kind` is **not a validated closed enum** in practice — a real Sonnet-driven run produced
     `kind: yes-no`, outside the documented `single-select|multi-select|free-text` set.
5. **Six open design questions remain**, gating parts of the implementation (stateless-turn
   feasibility, question-shape/classification mismatch, type extension, multi-question-batch vs.
   Minerva's one-question-per-turn model, deadline renewal ownership, minimum model tier) — see
   the scope doc for full detail. These map directly to story 1 (spike) and design-decision
   sub-steps within stories 3/4/5/7.

## Why this matters

`SubagentDriver`'s `--bg` mechanism keeps a background `claude` process alive across the
question-wait boundary — the orphan risk `swappable-driver` was built to fix, mitigated but not
eliminated (a poll-timeout reap is best-effort cleanup, not architectural absence of the risk).
The real protocol removes that boundary entirely: state lives in a file, nothing is running while
a question is unanswered, so there is no orphan risk on that step at all.
