# Research Brief — minerva-value-audit

**Requirement:** Investigate whether plugin-hive's own runner-agnostic / headless pause-resume
capabilities already provide what Minerva provides, and determine what value Minerva retains as
a layer that wraps/enforces Hive plugin command usage for agentic environments.

## Summary

Three distinct, non-overlapping efforts inside plugin-hive are each partial answers to "does
plugin-hive already do what Minerva does," and none of them is a stateless dispatch-then-poll-later
ABI of the kind Minerva's `startRun`/`getRunStatus` model provides:

1. **Upstream PR #341** (`firefly-events/plugin-hive#341`, headless question protocol) adds a
   file-based Q&A handoff for 3 of ~8+ skills (kickoff, design, plan). It is **open, unreviewed by
   a human, 18+ days stale** as of 2026-08-13.
2. **Fork-only runner-agnostic dispatch work** (`mdostal/plugin-hive-fork` PRs #3, #6, #11, #12 —
   codex/opencode/Gemini backends, declarative process manifest, agnostic PLAN port) is merged to
   the fork's `dev` branch but **not promoted even to the fork's own `main`** (PR #10, open since
   2026-08-02), and **not sent upstream** at all.
3. **The native DAG-executor `pause` node type** (shipped, installed, plugin cache v2.15.0) is a
   **synchronous blocking poll loop** inside one process — not a resumable, cold-start-friendly
   primitive. It defaults to interactive assumptions and fails closed (not gracefully) for
   non-interactive callers unless explicitly configured otherwise.

None of the three constitutes the "any harness that can pause and resume" bar implied by
Minerva's north_star framing. Additionally, Minerva's own dependency on the fork's agnostic-plan
CLI currently appears unreachable on the researcher's machine, meaning the runner-agnostic PLAN
driver code path may not be exercising in practice today.

## Key files & surfaces

**plugin-hive canonical repo** (`firefly-events/plugin-hive`, checked out locally at
`/Users/mdostal/Code/plugin-hive`, branch `feat/dos-334-codex-headless-backend`):
- `hive/references/dispatch-parity.md` — documents existing multi-substrate execution concept
  (`default`/`multica`/`cc-workflows`, future `sandcastle`/`gh-actions-legacy`) predating the
  DOS-327/329/334 fork work.
- `hive/references/workflow-schema.md` (§"Pause / Approve Gates", §"Conditional User Gates",
  §`under_scheduler`, ~lines 207-254 and ~448-456) — spec for `node_type: pause`.
- `hive/decisions/001-executor-cutover.md` — DAG-executor graduation/rollout record.
- `hive/lib/codex-backend.mjs` — headless `codex exec --json --ephemeral` dispatcher.
- `hive/manifests/plan.process.yaml` — declarative, executor-neutral workflow manifest.

**plugin-hive installed plugin cache** (`/Users/mdostal/.claude/plugins/cache/plugin-hive/plugin-hive/2.15.0`
— the version actually executing):
- `hive/lib/dag_executor/pause/__init__.py`, `signal.py`, `token.py`, `errors.py`
- `hive/lib/dag_executor/executor/handlers/pause.py`
- `hive/lib/dag_executor/executor/dispatcher.py`
- `hive/lib/dag_executor/run_state/resume.py`

**Minerva repo** (`/Users/mdostal/Documents/work/pantheon/minerva`):
- `src/agnostic-plan-driver.ts` (lines 1-80) — Heimdall-routed driver selection; calls
  `GET {HEIMDALL_URL}/available-route?task-type=planning` (default `http://localhost:4870`),
  fails open to Minerva's built-in claude `SpawnDriver` on any error.
- `src/run-manager.ts`, `src/kickoff-engine.ts` — grepped for "Heimdall" references only.
- `.pHive/project-profile.yaml` (north_star + open strategic question, lines 195-212).

**GitHub PRs (via `gh` CLI):**
- `firefly-events/plugin-hive#341` — Headless question protocol + bounded Stop hook (OPEN).
- `firefly-events/plugin-hive#39` — DAG-executor foundation incl. resume/pause (MERGED; stories
  hde-0..2, hde-5..8).
- `mdostal/plugin-hive-fork#12` — runner-agnostic PLAN port (MERGED 2026-08-09) — this is the
  exact entrypoint (`hive/agnostic/plan-agnostic.mjs`) Minerva's `agnostic-plan-driver.ts` spawns.
- `mdostal/plugin-hive-fork#3` — codex headless backend + process manifest, DOS-327/329/334 (MERGED).
- `mdostal/plugin-hive-fork#11` — test+review handoff runner-agnostic (MERGED).
- `mdostal/plugin-hive-fork#6` — runner-agnostic OpenAI-compat backend (MERGED).
- `mdostal/plugin-hive-fork#10` — "Promote: dev -> main" (OPEN since 2026-08-02) — gates all of
  the above fork work from reaching even the fork's own `main`.

## Patterns & conventions

- **Headless-question handoff (PR #341) mirrors Minerva's shape.** `hive/lib/runtime_mode.{py,js}`
  detects headless via explicit env signals only (`HIVE_HEADLESS=1/0` wins, else `CI=true`, else
  interactive-by-default — no TTY-probe fallback). `hive/lib/question_gateway.{py,js}` batches all
  questions at a phase boundary into `.pHive/questions/<skill>-<invocation-id>.yaml`, prints
  `AWAITING_ANSWERS`, and exits; an external orchestrator writes `answer:` + `status: answered`
  back onto the same file. The PR author's own text states this "mirrors Minerva's own
  `submitAnswers` shape." Envelopes are deleted on consume (fixed in review round 3, to prevent
  stale reuse of repeated phase ids like `1a` across invocations).
- **Scope of PR #341 is narrow**: wired into kickoff (7 phase points), design (2 touchpoints,
  loop-aware), plan (2 points: branch-switch-confirm, version_bump) — explicitly not execute,
  test, review, ship, etc. A newer plan question (step 14c, "sidecar-retention") isn't wired
  because it postdates the branch this PR is based on.
- **Native `pause` is a blocking poll loop, not a resumable ABI.** `Dispatcher.dispatch()` →
  `PauseHandler.handle()` → `wait_for_signal()` (`pause/signal.py`) runs
  `while True: check sentinel files; sleep(poll_interval=5.0s)` until an `.approve`/`.reject`
  sentinel appears at `<runs_root>/<run_id>/pause/<node_id>.{approve,reject}`, or a hard 30-day
  ceiling elapses (`DEFAULT_HARD_CEILING_SECONDS`). Security: HMAC-SHA256 resume tokens
  (`pause/token.py`) bound to `(run_id, node_id)`, signing key persisted at
  `<runs_root>/<run_id>/.signing_key` (mode 0600); sentinel body must carry the verified token.
- **Resume-from-fresh-process is explicitly a different, non-overlapping path.**
  `run_state/resume.py`'s generic `--resume <run-id>` CLI (for replaying FAILED/interrupted runs)
  raises `ResumeFromInvalidStateError` on a `SUSPENDED` run by design — code comment: "SUSPENDED →
  delegated to hde-8 pause-resume path." The pause-resume mechanism is the blocking loop itself,
  not a later re-invocation.
- **plugin-hive already had a multi-substrate concept before this fork work**
  (`dispatch-parity.md`), which the DOS-327/329/334 process-manifest work generalized further:
  "any executor (CC plugin, Codex, direct API, hive-dag) can consume" the declarative manifest.
- **"Heimdall" is Minerva/Pantheon-only infrastructure** — zero hits anywhere in plugin-hive
  (canonical or fork, cache or checkout). It is an external routing service Minerva calls,
  fail-open by design.

## Constraints

- PR #341's headless protocol covers only kickoff/design/plan — not execute, test, review, ship,
  or other Hive command surfaces Minerva might need to drive.
- `node_type: pause` requires the executing process to physically block in a `while`/`sleep(5.0s)`
  loop for up to 30 days; it is not a fresh-process-per-poll model. A caller wanting "dispatch
  once, poll status later from a different process" must set `under_scheduler.auto_approve: false`
  to fail closed rather than block — there is no built-in "reconnect and keep waiting" primitive
  for a caller that wasn't the one originally blocking.
- `node_type: pause` is scoped to the DAG-executor runtime only, itself opt-in per workflow
  (`executor_default: false` by default per `hive/decisions/001-executor-cutover.md`) and
  graduated only for `ui-design`, `design-review`, `daily-ceremony` workflows. Most Hive skills,
  including kickoff/plan as Minerva invokes them today, do not run under this executor at all.
- `hive/agnostic/plan-agnostic.mjs` (the CLI Minerva's `agnostic-plan-driver.ts` depends on)
  exists only on the fork's `dev` branch — not fork `main`, not upstream at all. Minerva's three
  hardcoded candidate paths (`~/code/plugin-hive-fork`, `~/Code/plugin-hive-fork`,
  `~/.claude/plugins/plugin-hive/hive/agnostic/plan-agnostic.mjs`) resolve to **none of these** on
  the researcher's machine (verified directly: neither fork path exists; the installed plugin
  cache at 2.15.0 has no `hive/agnostic/` directory; confirmed absent on the fork's own `main` via
  `gh api repos/mdostal/plugin-hive-fork/contents/hive/agnostic` → 404).

## Risks

- **Minerva's "bulletproof claude fallback" is likely always triggering silently today.**
  `agnosticPlanCliPath()` returns `null` unless one of three hardcoded candidate paths exists;
  none do on this machine. `resolveAgnosticPlanDriver()` is presently a no-op in this environment
  — the runner-agnostic PLAN driver path may never execute for real outside the PR #12 author's
  own demo environment, undermining any claim that Minerva benefits today from cross-runtime
  planning.
- PR #341 has been open 18+ days (2026-07-26 → 2026-08-13) with zero human review engagement —
  only automated CodeRabbit rounds and the author's own responses (19 PR comments total, all from
  author `mdostal` or the CodeRabbit bot). "OPEN" should not be read as "actively being reviewed";
  it may be stalled awaiting a maintainer.
- The native pause mechanism's blocking-poll-loop design is a **structural**, not incidental, gap
  relative to a "dispatch and walk away" harness (a scheduler, a CI job, another LLM harness
  checking back periodically without holding a process open) — this is precisely the shape
  Minerva's north_star bar ("any harness that can pause and resume") implies is needed.
- **Fork-vs-upstream state is easy to conflate.** Work that could be summarized as "plugin-hive is
  gaining native agnostic pause/resume" is actually three unrelated pieces at three different
  maturities: (a) an open, unreviewed upstream PR (#341 — headless *questions*, not DAG-executor
  pause/resume); (b) a merged-but-unpromoted fork branch (`dev`, not yet fork `main`, not upstream
  at all) implementing headless *runtime dispatch* (codex/opencode backends) with no pause/resume
  relationship; (c) an already-shipped (2.15.0, installed), narrow-scope, synchronous/blocking DAG
  pause primitive unrelated to either of the above.
- Minerva's `agnostic-plan-driver.ts` code comments assert Heimdall routing and the ported CLI as
  working infrastructure, but the actual dependency is unreachable on this machine via any of its
  three candidate paths — described behavior and actual resolvable state appear to have diverged.

## Open questions

- Does `hive/agnostic/plan-agnostic.mjs` (PR #12) function as a substitute for Minerva's own
  kickoff/plan question-and-answer loop, or only for the single-shot DECOMPOSE write? (Only the PR
  description/proof snippet was checked, not the full `adapters.mjs`/`plan-agnostic.mjs` source.)
- Whether `node_type: pause`'s sentinel-file protocol could in practice be driven end-to-end by a
  non-Claude-Code, non-interactive harness was not fully resolved by code alone — the
  `under_scheduler.auto_approve` documentation strongly implies "no" by default (fails closed
  rather than adapting), but no test or example of a real non-interactive caller successfully
  using it was found in the time available.
- Not verified whether PR #341's `hive/references/kickoff-protocol.md` /
  `question-envelope-schema.md` prose documents interop guidance for an external ABI like
  Minerva's, versus only describing plugin-hive-internal behavior.
- Maintainer sentiment on PR #341 was not checked outside GitHub PR comments (no issue-tracker or
  external discussion channel was consulted).

## Recommendation (synthesis — not sourced from raw findings, interpretation only)

Based strictly on the maturity/scope gaps documented above: none of plugin-hive's three
pause/resume-adjacent efforts currently substitutes for Minerva's dispatch-then-poll-later
contract. Minerva's retained value, if this evidence holds, is narrower and more specific than "a
whole orchestration layer" — it is the piece none of the three plugin-hive efforts provide: a
stable, cold-start-tolerant external ABI (`startRun`/`getRunStatus`/`submitAnswers`) that does not
require holding a process open, does not require opting into the DAG executor per-workflow, and
does not depend on unmerged/unpromoted fork branches to function. Two things should be validated
before further scoping: (1) whether the agnostic-plan-driver's fallback-to-claude path is in fact
silently active in production Minerva usage (per the reachability finding above), since if so the
"runner-agnostic" claim in Minerva's current north_star may need revision; and (2) whether PR
#341, if it lands upstream, would actually let Minerva delete any of its own protocol-translation
code, or only let it stop hand-rolling a parallel envelope format — the PR author's own claim that
it "mirrors" Minerva's `submitAnswers` shape suggests the latter is more likely than a full
replacement.
