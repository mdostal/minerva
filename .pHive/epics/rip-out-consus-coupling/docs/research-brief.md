# Research Brief: Full Rip-Out of Consus/Multica Coupling from Minerva's Core

**Requirement:** Full rip-out of Consus/Multica coupling from Minerva's core so it becomes a genuinely standalone Pantheon god, per the operator's explicit directive and per Minerva's own pre-existing, already-approved v1 product requirement (`docs/product-brief.md`, `docs/initial-info.md` both state: zero dependency on Delphi, Auriga, Vulcan, Multica, or votem existing).

**Audience:** planner/architect. **Method:** full-repo research sweep; findings below are reported as found, not re-derived.

---

## Summary

Minerva's codebase currently violates its own already-approved v1 requirement of standalone operation. Two structurally distinct coupling shapes exist:

1. **Core-woven Consus coupling** — `src/dispatch.ts`, `src/kickoff-engine.ts`, `src/run-manager.ts`. Zero Multica presence in these three files. Most severe: `kickoff-engine.ts`'s `recordTurn()` calls Consus **unconditionally, with no flag gate**, on every `startRun`/`submitAnswers` turn — this is inside the load-bearing core turn-recording path, not an add-on.
2. **Adapter-confined Consus + Multica coupling** — `src/plan-runner.ts` and `bin/minerva-plan.ts`. Mostly behind explicit opt-in params/flags, except one unconditional "surface parked questions to Consus" block in `plan-runner.ts` that bypasses its own `pollConsusForAnswers` flag.

Additionally: **four dedicated Consus modules** (`src/consus-decisions.ts`, `src/consus-poller.ts`, `src/consus-resume.ts`, `src/consus-auto-resume.ts`) exist as deletion candidates; **three independent, near-duplicated Multica-CLI-shell-out implementations** exist with no shared client module; and **two standalone entrypoints** (`bin/minerva-plan.ts`, `bin/ideate-to-consus.mjs`) sit structurally outside `dispatch.ts`'s core ABI, raising a genuine, undecided scoping question about whether they count as "core."

One naming fact previously unconfirmed is now settled: **"Consus" is the operator-confirmed renamed identity of "Delphi"** (the human decision surface referenced throughout `.pHive/CONTEXT.md`, `docs/product-brief.md`, `docs/initial-info.md`, and README's "Delphi / Consus" diagram label) — operator statement, this session. This is no longer an open question; it directly informs Open Question 2 below (whether the "decision surface" concept is deleted outright or moved behind a v2 contract, per CONTEXT.md's existing convention for Delphi).

Pre-existing triage item `t-002` (`.pHive/triage/queue.yaml`, `prioritized`, p0/critical) already carries the operator's "full rip it out and apart" directive (decision logged 2026-08-14T14:34Z) and a stated PoC acceptance bar: re-run the pause/resume PoC from epic `minerva-value-audit` against the ripped-out code plus the already-shipped `fix-startrun-heimdall-routing` fixes.

---

## Key files & surfaces

### Dedicated Consus modules (full-deletion candidates)

| File | Lines | Exports | Notes |
|---|---|---|---|
| `src/consus-decisions.ts` | 97 | `postQuestionToConsusDecisionApi()`, `buildConsusDecisionRequest` | POSTs to `MINERVA_CONSUS_DECISIONS_URL` (default `http://localhost:8722/api/decisions`), 750ms timeout, fails soft |
| `src/consus-poller.ts` | 141 | `pollConsusAnswers()` (registered ABI method), `findParkedConsusQuestions()`, `fetchConsusQuestionStatus()` | Reads `CONSUS_URL` (default `http://localhost:8722`), `MINERVA_CONSUS_POLL_TIMEOUT_MS`; imports `extractAnswerFromItem` from `consus-resume.ts` — cross-module dependency between the two "dedicated" files |
| `src/consus-resume.ts` | 367 | `resumeFromConsusAnswer()` / `resumeAnsweredConsusDecision()` (both registered ABI methods); `fileStoriesToMultica` / `fileAllStoriesToMultica` (Multica CLI shell-out, duplicated near-verbatim from `plan-runner.ts`); `extractAnswerFromItem` / `extractAnsweredConsusDecision` | Header comment claims "core ABI remains provider-neutral... this module is the thin Multica/Consus-aware hook path" — true for this file in isolation, contradicted by `kickoff-engine.ts` |
| `src/consus-auto-resume.ts` | 87 | `pollAndResumeConsusAnswers()` (registered ABI method) | Pure wiring: poll then resume, sequential |

### Core files with mixed-in Consus/Multica logic (surgical removal)

- **`src/dispatch.ts`** — imports and registers all 4 Consus ABI methods in the `handlers` map alongside the 7 provider-neutral ones (`capabilities, startRun, getRunStatus, listRuns, getQuestions, submitAnswers, getOutput, abortRun`). `capabilities()` (`src/capabilities.ts`) returns only `{abi_version: "1.0.0"}` — does **not** enumerate method names, so removing the 4 methods does not change the `capabilities` wire response. The method list is documented only in `docs/architecture.md`'s markdown table, not runtime-introspectable.
- **`src/kickoff-engine.ts`** — `recordTurn()` (called from both `startRun` and `submitAnswers`, i.e. every turn) calls `await postQuestionToConsusDecisionApi(runId, question)` **unconditionally, no flag gate**. On a truthy `posted.posted` it flips `status` to `"awaiting-consus"` and stamps `consus_question_id` onto the question. Inside the CORE turn-recording path — genuinely load-bearing, not an add-on.
- **`src/run-manager.ts`** — `RunStatus` union includes `"awaiting-consus"` (line 14); `Question` interface (nested inside `RunRecord.questions[]`, NOT `RunRecord` directly) carries `consus_question_id?: string` (line 64). Also: `defaultSeedRepoPath()` returns `~/repos/consus-seeds` — a separate, distinct "Consus" hit (seed-repo naming convention, not the Consus service), **explicitly out of scope** per triage `t-002`, already tracked separately as test-hygiene work in the `minerva-value-audit` epic. Do not conflate with this rip-out.
- **`src/plan-runner.ts`** — ~24 references. `CONSUS_URL` env default `http://localhost:8722`; `pollConsusForAnswers` flag on `PlanRequest` (properly opt-in, only engaged when `req.pollConsusForAnswers` truthy); a **separate, unconditional-when-pending** "surface parked questions to Consus" block at the end of `runHeadlessPlan` (lines ~137–170) that POSTs every pending question to `${CONSUS_URL}/api/questions` regardless of the `pollConsusForAnswers` flag — not as cleanly gated as it first appears. Also contains a full Multica CLI shell-out surface: `_multicaRunner` / `multicaJson` / `__setMulticaRunnerForTest`, `resolveIdeaFromTicket`, `fileStoriesToMultica` / `fileAllStoriesToMultica` (duplicate of `consus-resume.ts`'s same-named functions).
- **`bin/minerva.ts`** — the CORE CLI entrypoint (AD-1: "the entire external surface"). Imports all 4 Consus modules directly; offers `--poll-consus`, `--poll-and-resume`, `--consus-item-file`, `--file-to-multica` as alternate CLI modes baked into `mainArgs()`. Same executable also serves plain ABI dispatch via stdin. Its own `ARG_HELP` string: `"minerva — JSON-over-stdio by default, plus Consus resume shorthand"`.

### Isolated/legitimate integration entrypoints (structurally separate from core coupling)

- **`bin/minerva-plan.ts`** (221 lines) — router-facing (Auriga-invoked) headless "plan a ticket" CLI. Always calls `runHeadlessPlan({..., pollConsusForAnswers: true, ...})` — hardcodes the Consus-poll flag to `true`, not exposed as an opt-out here. `--file-to-multica` is a genuine opt-in CLI flag. Not imported by `dispatch.ts` or any core module.
- **`bin/ideate-to-consus.mjs`** (627 lines) — large, self-contained Node ESM CLI, zero imports from `src/`. Never calls Consus's HTTP API directly — goes exclusively through a **Janus broker seam** (`${JANUS_URL}/api/seam/consus/*`, default port 8726, distinct from Consus's own port 8722). Independently shells out to `multica` CLI (a third separate implementation). Invoked standalone, not part of dispatch/ABI, **no test coverage exists for it**.

### ABI/architecture docs

- `docs/architecture.md` — API Contract table **documents** `pollConsusAnswers` / `pollAndResumeConsusAnswers` as first-class ABI methods with full signatures. Data Model/API Contract tables list `Run.status` as only `in_progress | waiting_on_human | complete | aborted` — `awaiting-consus` is absent from the doc even though the code has it (pre-existing doc/code drift, independent of any rip-out).
- `README.md` — architecture diagram's dispatch method list already omits all 4 Consus methods (out of sync with `dispatch.ts`). Names `"Delphi / Consus\n(human decision surface)"` as a single sibling-god node.
- `VISION.md` — lists "wire the decision surface... connect human-channel questions to the live Delphi/Consus surface" as **future, not-yet-done** work — directly contradicted by `kickoff-engine.ts` already doing this unconditionally today.
- `.pHive/CONTEXT.md` — "every god-integration (Delphi, Auriga, Vulcan, Multica, votem) is v2, each behind a contract... v1 is standalone." Consus not named separately (consistent with Consus = renamed Delphi, per operator confirmation).
- `docs/product-brief.md` (line 56) and `docs/initial-info.md` (lines 9, 142, 158) — **both explicitly state as an approved v1 requirement**: "Standalone operation — no dependency on Delphi, Auriga, Vulcan, Multica, or votem existing" / "v1 just needs Minerva to expose [ABI]... those are v2 infrastructure upgrades." Pre-existing, already-approved product requirement the current code violates.
- `.pHive/project-profile.yaml` — `integrations.cli_tools.multica.impact`: "v2 remote compute dispatch... wiring is deferred to v2" — another explicit "not yet" statement contradicted by current direct Multica CLI shell-outs.
- `.pHive/triage/queue.yaml` (`t-002`) — near-complete pre-existing brief on this exact problem, `prioritized`, priority p0/severity critical, with a `DECISION` entry (2026-08-14T14:34Z) recording the operator's "full rip it out and apart" directive and stated PoC acceptance bar: re-run the pause/resume PoC from epic `minerva-value-audit` against the ripped-out code plus the already-shipped `fix-startrun-heimdall-routing` fixes.
- `.pHive/triage/queue.yaml` (`t-003`, `t-004`) — separate, currently-open bugs, explicitly out of scope for this rip-out. `t-003` (already fixed on the `fix-startrun-heimdall-routing` branch this branch is based on) is `SpawnDriver`'s non-fail-open Heimdall call — contrast: `agnostic-plan-driver.ts`'s Heimdall call IS fail-open ("BULLETPROOF CLAUDE FALLBACK"), useful prior art for how an optional external call should be structured. `t-004` is an unrelated plan_runtime bug.

### Test files

| File | Coverage | Disposition implication |
|---|---|---|
| `src/consus-auto-resume.test.ts` (6 tests) | dedicated module | delete alongside module |
| `src/consus-decisions.test.ts` (4 tests) | dedicated module | delete alongside module |
| `src/consus-poller.test.ts` (10 tests) | dedicated module | delete alongside module |
| `src/consus-resume.test.ts` (6 tests) | dedicated module | delete alongside module |
| `src/full-loop.test.ts` (2 tests) | imports `mockConsusServer` from `test-cli.ts`; asserts `consus.posts.length === 1` as a REAL behavioral assertion (the test's whole purpose) | needs a real rewrite/removal decision, not a mechanical strip |
| `src/e2e-auto-resume.test.ts` (1 test, 211 lines) | full end-to-end park→post→poll→answer→resume cycle, entirely Consus-shaped | full rewrite or deletion |
| `src/kickoff-engine.test.ts` | one test (line 344) sets `MINERVA_CONSUS_DECISIONS_URL: ""` specifically because a real reachable Consus service would flip status to `awaiting-consus` and make the test flaky | a workaround for the exact bug this epic fixes, patched around instead of fixed at the source |
| `src/types.test.ts` | exhaustive `switch` over `RunStatus` (line 156) | will fail to compile if `"awaiting-consus"` is removed without updating this test in the same change |
| `bin/minerva.test.ts` | one test asserts `pollAndResumeConsusAnswers` is registered as a real ABI method | positive-contract test needing deletion/inversion |
| `src/plan-runner.test.ts` | imports `fileStoriesToMultica, __setMulticaRunnerForTest`; real test coverage of the Multica-filing path | already hermetic via runner-injection seam ("Fake-driver driven, no claude and no multica process") |
| `src/test-cli.ts` | shared test infra; exports `mockConsusServer()` (real local HTTP server capturing POSTed bodies) alongside `mockHeimdallServer()` | `mockHeimdallServer` is Consus-independent, stays regardless of rip-out scope; consumed by `full-loop.test.ts` |

---

## Patterns & conventions

1. **Two structurally distinct coupling shapes, not one.** (a) *Core-woven*: `dispatch.ts` (registry), `kickoff-engine.ts` (unconditional call inside load-bearing `recordTurn`), `run-manager.ts` (type system) — Consus-only, zero Multica presence in any of these three files. (b) *Adapter-confined*: `plan-runner.ts` + `bin/minerva-plan.ts` — both Consus and Multica appear here, mostly behind explicit params/flags, except one unconditional "surface to Consus" block. `consus-resume.ts`'s own header comment ("core ABI stays provider-agnostic") is accurate for Multica everywhere, but inaccurate as a description of the whole system's Consus coupling — `kickoff-engine.ts`'s call is not thin/optional/adjacent, it's inside the core turn-recording path every `startRun`/`submitAnswers` call goes through.
2. **Three independent Multica-CLI-shell-out implementations exist**, near-duplicated: `plan-runner.ts`, `consus-resume.ts` (same function names, separate implementation, separate test seam), `ideate-to-consus.mjs` (own PATH/env resolution). No shared Multica client module.
3. **`bin/ideate-to-consus.mjs` never talks to Consus directly** — exclusively through a Janus broker seam. The one place in the repo where Consus access is already behind an abstraction rather than a raw fetch call.
4. **Consistent port default**: every direct-fetch Consus reference defaults to `http://localhost:8722`. `ideate-to-consus.mjs`'s Janus default is a different port (8726) and a different service entirely.
5. **Fail-soft-but-unconditional is the dominant Consus call pattern**: every direct Consus call has a short timeout (750ms) and catches all errors — never throws, degrades to "Consus unreachable, proceed as if not posted." Doesn't crash callers, but silently and non-deterministically changes returned status values depending on ambient network reachability — the exact test-flakiness mechanism `t-002` caught live.
6. **A working "fail-open external dependency" precedent already exists in this codebase**: `agnostic-plan-driver.ts`'s Heimdall-route lookup, explicitly documented "BULLETPROOF CLAUDE FALLBACK... returns null on ANY doubt." Directly relevant prior art for how an optional external call should be structured if anything Consus-shaped survives in any form.

### Utilities available for reuse

- `test-cli.ts`: `mockConsusServer()` and `mockHeimdallServer()` — reusable local-HTTP-server test doubles; `mockHeimdallServer` is Consus-independent, stays regardless of scope.
- `__setMulticaRunnerForTest` seam exists independently in both `plan-runner.ts` and `consus-resume.ts` — an established DI pattern for shelling out to external CLIs in tests, reusable for whatever design replaces direct coupling.
- `agnostic-plan-driver.ts`'s `resolveAgnosticPlanDriver()` "returns null on ANY doubt" pattern — a working, tested, in-repo template for "fail-open, core never depends on this being reachable."

---

## Constraints

- `docs/product-brief.md` and `docs/initial-info.md` both state, as an already-approved v1 requirement, zero dependency on Delphi/Auriga/Vulcan/Multica/votem existing. The rip-out is compliance restoration, not novel policy.
- `docs/architecture.md`'s AD-5 (stall invariant, no timeout, resume-from-disk IS pause/resume) and "No Autonomous Progress" are core, load-bearing guarantees that must survive the rip-out untouched — the generic `waiting_on_human` + `submitAnswers` mechanism is Minerva's actual core value proposition, entirely independent of Consus. `awaiting-consus` is a Consus-specific enum value layered ON TOP of this generic mechanism, not underneath it — removing it should not require reinventing park-and-wait, only deleting the extra state.
- `consus-poller.ts` depends on `consus-resume.ts` for `extractAnswerFromItem` — the two "dedicated modules" are not independent; deletion order/atomicity matters.
- `bin/minerva.ts` is the single external CLI surface (AD-1). Removing its Consus imports changes real, currently-documented CLI flags (`--poll-consus`, `--poll-and-resume`, `--consus-item-file`, `--file-to-multica`) described in its own `ARG_HELP` output.
- `docs/architecture.md`'s API Contract table is the closest thing to a formal spec for the 2 documented Consus ABI methods — removing them is a documented-contract change, not merely a code change.

---

## Risks

- **Silent behavior change for real callers.** `bin/minerva-plan.ts` hardcodes `pollConsusForAnswers: true` on every `runHeadlessPlan` call. If Consus polling is removed from `plan-runner.ts` without updating this call site, `bin/minerva-plan.ts` either breaks at compile time (best case) or silently no-ops a parameter that used to matter (worse case).
- **`types.test.ts`'s exhaustive switch on `RunStatus`** will fail to compile the moment `"awaiting-consus"` is removed from the type unless the test is updated in the same commit.
- **ABI/documentation contract break**: if the 4 Consus dispatch methods are removed without updating `docs/architecture.md`'s API Contract table, the doc claims methods exist that would now return `UNKNOWN_METHOD` — worse than the current undocumented-but-working drift.
- **`docs/minerva-dev-agent-instructions.md`** is a live operator instruction set for a "minerva-dev" agent persona referencing `--file-to-multica` and Multica ticket workflows as its PRIMARY mode of operation. If Multica coupling in `plan-runner.ts`/`bin/minerva-plan.ts` is removed or gated behind new opt-in without updating this doc, it describes a workflow that no longer functions as written.
- **Duplicate Multica-shell-out logic** (`plan-runner.ts` vs `consus-resume.ts`) means a rip-out touching only one leaves the other behind, silently forking behavior between `bin/minerva-plan.ts` and `bin/minerva.ts`.
- **`ideate-to-consus.mjs` has zero test coverage** — any rip-out work here has no regression-test backing, unlike every other touchpoint.

---

## Open questions

1. ~~Is "Consus" the same service as "Delphi"?~~ **Resolved.** Confirmed by operator this session: Consus is the renamed identity of Delphi (the human decision surface named throughout `.pHive/CONTEXT.md`, `docs/product-brief.md`, `docs/initial-info.md`, and README's "Delphi / Consus" diagram label). Treat as settled fact, not open — cited to "operator statement, this session."
2. **Does "Consus = renamed Delphi" mean the entire "decision surface" concept should be excised from Minerva, or should it go behind a v2 contract per `.pHive/CONTEXT.md`'s existing convention** ("every god-integration... is v2, each behind a contract... v1 is standalone")? Now that the naming question is settled, this becomes the live design question the naming ambiguity was blocking: delete outright vs. re-home behind a formal v2 contract boundary.
3. **Are `bin/minerva-plan.ts` and `bin/ideate-to-consus.mjs` in-scope for "no Consus/Multica coupling," or may they legitimately remain as separate, clearly-labeled, opt-in integration tools?** Neither is wired into `dispatch.ts`'s core ABI. The operator's own words — "if it requires all of the others to do anything, then it is a process piece or a flag in the pantheon itself" — plausibly reads as: the CORE ABI/engine must be standalone; separate, non-required CLI tools shipped in the same repo are a different question. This research does not pre-decide it.

---

## Recommendation *(synthesis — not raw finding, flagged for planner judgment)*

- Treat `kickoff-engine.ts`'s unconditional `postQuestionToConsusDecisionApi()` call as the P0 fix within the rip-out: it is the only Consus touchpoint inside the genuinely load-bearing core path (every turn), and it is the direct cause of the flakiness workaround already visible in `src/kickoff-engine.test.ts` line 344.
- Delete the 4 dedicated Consus modules and their status-only test files as a single atomic change (respecting the `consus-poller.ts` → `consus-resume.ts` dependency), together with removing `"awaiting-consus"` from `RunStatus` in `src/run-manager.ts` and the corresponding branch in `src/types.test.ts`'s exhaustive switch, in the same commit to avoid a compile break.
- Resolve Open Question 2 before deciding whether any Consus-adjacent code is preserved-but-gated vs. deleted outright — the fail-open pattern in `agnostic-plan-driver.ts` is the reusable template if any survives.
- Resolve Open Question 3 (scope boundary for `bin/minerva-plan.ts` / `bin/ideate-to-consus.mjs`) explicitly in the epic's design doc rather than leaving it implicit, since it changes the blast radius materially — `bin/minerva-plan.ts`'s hardcoded `pollConsusForAnswers: true` and `docs/minerva-dev-agent-instructions.md`'s Multica-centric workflow both depend on the answer.
- Update `docs/architecture.md`'s API Contract table and `docs/minerva-dev-agent-instructions.md` in the same epic, not as follow-up debt — both are currently-accurate-looking docs that would become actively misleading (claiming methods/workflows that no longer exist) if left stale.
- Use the triage `t-002` PoC acceptance bar (re-run the `minerva-value-audit` pause/resume PoC against the ripped-out code plus `fix-startrun-heimdall-routing` fixes) as the epic's Definition of Done gate.
