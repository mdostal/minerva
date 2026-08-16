# 002 — ForkedHiveDriver's Production Path Depends on an Unmerged PR

**Status:** open dependency, tracked, operator-accepted interim stance in place · **recheck_by: 2026-09-13**

---

## Interim operating stance (2026-08-16)

Operator decision: Minerva ships now with the explicit expectation that operators set
`MINERVA_HIVE_PLUGIN_DIR` at a `plugin-hive-fork` checkout (or, once merged, a `hive-workshop`
checkout) to run `MINERVA_DRIVER=forked` — this is the accepted production posture for the
`ForkedHiveDriver` path until the upstream gap below closes, not a blocker on releasing.
"We'll clean that as we go" — this doc's **Recheck** section stays the mechanism for updating that
stance once the dependency actually clears; no other change to release process.

Progress on closing the gap: `firefly-events/plugin-hive#341` targets the `plugin-hive`
release-mirror repo, which carries none of the maintainer's real CI/review automation (that lives
in `firefly-events/hive-workshop`, the actual dev repo `plugin-hive` publishes a curated subset
from — see `scripts/publish-release.sh`). Filed **`firefly-events/hive-workshop#127`**
(2026-08-16) — the same implementation, reconciled against `hive-workshop`'s `develop` tip (164
commits of drift from PR #341's original plugin-hive-`develop` base at filing time), all 50 tests
(19 pytest, 19 vitest, 12 shell) re-verified passing in that repo's own environment before
opening. CodeRabbit review auto-picked it up on open (`SUCCESS`). Once #127 merges into
`hive-workshop`'s `develop` and is promoted through the existing publish flow to `plugin-hive`,
this doc's gap closes for real and the recheck below should confirm that rather than PR #341's
own (now-superseded-as-the-landing-path) status.

---

## The gap

`ForkedHiveDriver` (`src/driver.ts`) is the driver implementation that fixes the orphaning risk
the swappable-driver epic exists to address, by driving plugin-hive's real structured
headless-question protocol instead of prose-scraping a driven turn's output. That protocol is
shipped in **`firefly-events/plugin-hive#341`** (branch `feat/headless-question-protocol`) — and
as of this writing, PR #341 is **unmerged**.

The class header comment in `src/driver.ts` (lines ~699-737) states this directly. Quoted
verbatim:

> ```
> // ForkedHiveDriver (forked-driver-integration epic) -- drives the real headless-question-
> // protocol shipped in firefly-events/plugin-hive#341 (branch feat/headless-question-protocol).
> // Unlike SpawnDriver/SubagentDriver, this driver does NOT keep a live session across the
> // question-wait boundary at all -- there is no process running while a question sits
> // unanswered, because the protocol hands off via a FILE (.pHive/questions/*.yaml), not a
> // tracked background job or a resumed conversation. This is the actual fix for the orphaning
> // risk the whole swappable-driver epic exists to address.
> ...
> // TESTING: point MINERVA_HIVE_PLUGIN_DIR at a local plugin-hive-fork checkout to test/drive
> // against the fork directly (via `claude --plugin-dir`) before PR #341 ships in a real release
> // -- unset in production once the protocol is installed via the normal marketplace mechanism.
> ```

And `src/envelope-detection.ts`'s module header comment (lines 1-10), quoted verbatim:

> ```
> // Envelope detection + parsing (forked-driver-integration epic) — read-only detection and
> // parsing of `.pHive/questions/<skill>-<invocation-id>.yaml` envelope files, mirroring
> // output-emitter.ts's findCompletedEpic directory-scan pattern. Full schema:
> // hive/references/question-envelope-schema.md in plugin-hive-fork.
> //
> // LOAD-BEARING (confirmed via the epic's own spike + PR #341's review): envelopes are DELETED
> // by the gateway the instant it consumes a status: answered one -- absence is a legitimate,
> // common state, never an error. Every function here is strictly read-only: no write, delete, or
> // mutation path exists in this module. Consuming (writing an answer + triggering deletion) is
> // the real driver implementation's own job, not this module's.
> ```

## Which path is production, which is testing — today

`pluginDirArgs()` in `src/driver.ts` reads the `MINERVA_HIVE_PLUGIN_DIR` environment variable to
decide whether to pass a `--plugin-dir` flag to `claude`:

- **`MINERVA_HIVE_PLUGIN_DIR` set** (points at a local `plugin-hive-fork` checkout) — this is the
  **only path that actually carries the headless-question protocol today**. It is explicitly a
  *testing* stopgap: it drives `claude` directly against the unmerged fork branch via
  `--plugin-dir`, ahead of PR #341 landing in a real release.
- **`MINERVA_HIVE_PLUGIN_DIR` unset** — this is the *intended* production path: `claude` relies on
  whatever `plugin-hive` is installed via the normal marketplace mechanism. **This path does not
  yet carry the protocol**, because the marketplace-distributed `plugin-hive` does not yet include
  PR #341's changes. Running `ForkedHiveDriver` in this configuration today will not behave as
  designed.

In short: the code is written as if the production path exists, but it doesn't yet — the only
configuration that has ever been exercised end-to-end is the local-fork-checkout testing path.
This is confirmed by `docs/architecture.md`'s own as-built note that `ForkedHiveDriver` was
"tested exclusively against a local fork checkout via `--plugin-dir`
(`MINERVA_HIVE_PLUGIN_DIR`), not the marketplace-installed plugin-hive, ahead of PR #341 merging
upstream."

## Why this matters

This is the single most load-bearing external dependency for `ForkedHiveDriver`: until PR #341
merges (or an equivalent protocol lands via the normal marketplace mechanism), there is no
production-viable way to run `MINERVA_DRIVER=forked` against a real marketplace install of
plugin-hive. Any planning or rollout work that assumes `ForkedHiveDriver` is production-ready
needs to account for this — either by keeping `MINERVA_DRIVER=forked` gated to environments that
set `MINERVA_HIVE_PLUGIN_DIR`, or by blocking on PR #341.

## Recheck

**recheck_by: 2026-09-13**

Per this project's existing convention (see `docs/decisions/kickoff-review.md`'s and the triage
queue schema's operator-driven-recheck posture — time-based auto-advance is deliberately
operator-driven, not automated), re-checking this dependency is a manual, dated action, not new
tooling. To recheck:

1. Run (check the real landing path first — `hive-workshop#127` is what actually promotes to a
   plugin-hive release; `plugin-hive#341` is the original PR against the release-mirror repo,
   which never gets its own auto-pickup/CI since that lives in `hive-workshop`, superseded as the
   landing path but left open as reference):
   ```
   gh pr view 127 --repo firefly-events/hive-workshop --json state,reviewDecision,updatedAt,mergedAt
   gh pr view 341 --repo firefly-events/plugin-hive --json state,reviewDecision,updatedAt,mergedAt
   ```
2. Update this doc's status line based on the result:
   - `hive-workshop#127` still open → bump `recheck_by` another 30 days and note the check in this
     file.
   - `hive-workshop#127` merged, but no newer `plugin-hive` release/tag published since → the
     protocol exists in `hive-workshop`'s `develop` but hasn't reached a `plugin-hive` release yet
     via `scripts/publish-release.sh`'s promotion flow. Note the merge, keep the interim stance
     above in place, and recheck again in ~2 weeks for a publish.
   - A `plugin-hive` release/tag published *after* #127's merge date → update this doc's
     **Status** to reflect that the production path now exists, and flag `src/driver.ts`'s
     `pluginDirArgs()` comment and `docs/architecture.md`'s as-built note for a follow-up story to
     drop the "ahead of PR #341 merging upstream" caveat and validate `MINERVA_DRIVER=forked`
     against the real marketplace-installed plugin-hive.

---

## Open Question 1 (resolved): does `plan-agnostic.mjs` substitute for Minerva's full plan-flow loop?

**Question, as tracked in `.pHive/epics/minerva-value-audit/docs/design-discussion.md` §6:** does
`hive/agnostic/plan-agnostic.mjs` (fork PR #12, `mdostal/plugin-hive-fork`'s `dev` branch)
actually substitute for Minerva's own kickoff/plan question-and-answer loop end-to-end, or does it
only handle the single-shot DECOMPOSE write?

**Answer: partial — no, `plan-agnostic.mjs` does not implement a full multi-turn Q&A loop itself.
It is a single-shot-per-invocation CLI that Minerva's own `AgnosticPlanDriver`
(`src/agnostic-plan-driver.ts`) wraps as one more `Driver.runTurn()` implementation, called
repeatedly by Minerva's *own* pre-existing loop. All of the actual "loop" behavior — parking on a
pending question, extracting one atomic question via a constrained schema, classifying it to a
channel, applying pre-baked defaults, and resuming — lives entirely in Minerva's
`kickoff-engine.ts` / `question-extraction.ts` / `escalation-classification.ts`, unchanged by this
fork. `plan-agnostic.mjs` supplies none of it.**

Source read directly from GitHub (`gh api
repos/mdostal/plugin-hive-fork/contents/hive/agnostic/{plan-agnostic,adapters}.mjs?ref=dev`,
base64-decoded), confirmed against fork commit sha `53fad6c` (`plan-agnostic.mjs`) / `5be59f2`
(`adapters.mjs`) on the `dev` branch. Local candidate checkout paths for the fork did not exist on
this machine, so the GitHub API was the only source used — no local `git show` fallback was
needed.

### 1. `plan-agnostic.mjs` makes exactly one spawn call per process invocation, then exits

`main()` (lines 87–127) does the following, once, per invocation: resolve a single turn prompt
(lines 91–102), spawn the target runtime as a child process (lines 118–123 → `spawnRuntime()`,
lines 66–85), parse that one process's stdout (line 125), print one JSON line, and return (line
126). There is no loop, no polling, and no wait for a subsequent human input from *within* this
file — the process runs one turn and exits:

```js
// lines 118–127
const stdout = await spawnRuntime({
  cmd,
  args,
  cwd: opts.cwd || process.cwd(),
  timeoutMs: Number(opts["timeout-ms"] || DEFAULT_TIMEOUT_MS),
});

const { session_id, result } = parseRunOutput({ runtime, stdout });
process.stdout.write(JSON.stringify({ session_id, result }) + "\n");
```

The module docstring (lines 10–20) says this explicitly: it distinguishes a "first turn" (`--idea`
or `--prompt`, no `--session`) from a "continuation turn" (`--session <id> --prompt "<raw
answer>"`), and states the CLI "Prints one JSON line to stdout" per call (line 20). Continuation
support exists (lines 89–95, and `--resume <sessionId>` passed to `claude -p` in
`adapters.mjs` lines 52–64), so the CLI *can* be invoked again with a session id to continue a
conversation — but doing so is entirely the caller's responsibility. Nothing in this file waits
across invocations, decides when to invoke itself again, or has any concept of "pending question
awaiting an answer."

### 2. `adapters.mjs` does no question extraction or escalation classification at all

`adapters.mjs`'s two exports are a pure arg-builder (`buildRunArgs`, lines 44–81) and a pure
output-normalizer (`parseRunOutput`, lines 88–124). `parseRunOutput` only ever produces
`{session_id, result}` — for the `claude` kind it's `obj.result` verbatim from the single JSON
object `claude -p --output-format json` emits (lines 93–97); for the `opencode` kind (gemini/codex/
etc.) it's the concatenated assistant `text` parts from the NDJSON event stream (lines 98–124).
Neither path parses out a single atomic question, classifies it to a channel (agent vs. human), or
applies any schema constraint. The file's own comment says as much — it surfaces raw text
"so a caller can log it and so completion/question extraction has something to read" (lines
102–103, emphasis on *has something to read*, i.e. the extraction itself happens elsewhere):

```js
// lines 99–103
// opencode: NDJSON stream of events. session_id = last sessionID seen; result =
// concatenation of the assistant `text` parts (the model's final prose). Tool-use and
// step events are ignored for the result string (the load-bearing output is the files
// written to disk, not this text — but we surface the text so a caller can log it and so
// completion/question extraction has something to read).
```

There is no `--json-schema`-equivalent constraint anywhere in either file (`grep -i
"question|classif|escalat|schema"` across both files matches only that one comment line above),
which contrasts directly with Minerva's own `src/question-extraction.ts` (lines 18–38), whose
`QUESTION_SCHEMA_PROPERTY` + `extractionSchemaArgs()` constrain the driven turn's own final output
to `{"question": "<verbatim, single, atomic question>"}` via `--json-schema` — a mechanism
`plan-agnostic.mjs`/`adapters.mjs` have no equivalent of.

### 3. Minerva's own driver wraps `plan-agnostic.mjs` as a single-turn `Driver`, exactly like `SpawnDriver`

`src/agnostic-plan-driver.ts`'s `AgnosticPlanDriver` class (lines 145–207) implements Minerva's
`Driver` interface (`src/driver.ts`) with a `runTurn()` method that spawns
`plan-agnostic.mjs` **once per call** (lines 152–200: `--idea` on the first turn with no
`sessionId`, `--session <id> --prompt <raw>` on a continuation turn) and returns
`{session_id, raw_result}` (lines 202–205) — the identical shape `SpawnDriver`/`SubagentDriver`/
`ForkedHiveDriver` all return from their own `runTurn()`. Nothing about `AgnosticPlanDriver` or
`plan-agnostic.mjs` changes how `src/kickoff-engine.ts` drives a run: `startRun()` (lines 278–336),
`recordTurn()` (lines 150–191, which calls `extractClassifiedQuestion` from
`escalation-classification.ts` and the `extractQuestionShape` helper on lines 197–214),
`autoAnswerLoop()` (lines 227–276), and `submitAnswers()` (lines 375–435) are all unchanged and all
still execute in Minerva's own process — `driverForRecord()` (lines 111–117) just picks
`AgnosticPlanDriver` instead of the built-in `driver` when a run's `plan_runtime` is a non-Claude
runtime, and every one of those functions calls `runTurn()` on whichever driver it gets exactly
once per turn, exactly as before.

### Conclusion

`plan-agnostic.mjs` is a **per-runtime single-turn adapter** — it ports the *first-turn DECOMPOSE
invocation and turn-resumption mechanics* of `/plugin-hive:plan` to non-Claude runtimes via
opencode, nothing more. It does not implement, and does not need to implement, a multi-turn
question/answer loop, because Minerva never delegated that loop to it in the first place: the loop
(parking, question extraction, classification, channel routing, pre-baked-default auto-answering,
resumption) is — and, per this reading of the fork source, remains entirely — Minerva's own
`kickoff-engine.ts` + `question-extraction.ts` + `escalation-classification.ts` machinery, calling
`AgnosticPlanDriver.runTurn()` (and thus `plan-agnostic.mjs`) the same way it calls every other
`Driver` implementation: once per turn, from the outside. This resolves Open Question 1: the fork
does **not** materially change how much of Minerva's plan-flow logic could ever be delegated away,
because it was never architected to take over that logic in the first place — only the
runtime-specific spawn/resume mechanics were ported. No further tracking item is needed for this
question.

**Sources:**
- `https://github.com/mdostal/plugin-hive-fork/blob/dev/hive/agnostic/plan-agnostic.mjs` (sha
  `53fad6c`, fetched via `gh api
  repos/mdostal/plugin-hive-fork/contents/hive/agnostic/plan-agnostic.mjs?ref=dev`)
- `https://github.com/mdostal/plugin-hive-fork/blob/dev/hive/agnostic/adapters.mjs` (sha
  `5be59f2`, fetched via `gh api
  repos/mdostal/plugin-hive-fork/contents/hive/agnostic/adapters.mjs?ref=dev`)
- `src/agnostic-plan-driver.ts` (this repo, lines 145–207)
- `src/kickoff-engine.ts` (this repo, lines 111–117, 150–191, 227–276, 278–336, 375–435)
- `src/question-extraction.ts` (this repo, lines 18–38)
