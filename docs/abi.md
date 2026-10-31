# Minerva ABI

Minerva's public interface is a **JSON-over-stdio subprocess ABI** (`docs/architecture.md` AD-1).
This page is the quick reference: every method, its params, and its result. The full contract,
with field tables, status meanings and worked examples, is
[`mkdocs_docs/abi-reference.md`](../mkdocs_docs/abi-reference.md). `src/docs-contract.test.ts`
keeps both pages in step with the methods registered in `src/dispatch.ts`.

## Transport

- One request per process: `{"method": "<name>", "params": {...}}` on stdin.
- One response on stdout: `{"result": {...}}` with exit `0`, or
  `{"error": {"code", "message", "retry_after_ms": null}}` with exit `1`.
- No daemon. Run state lives on disk under `MINERVA_HOME` (default `~/.minerva`), so a run can
  span any number of calls, processes and hours.
- `run_id` must be UUID-shaped wherever it is a param, or the call fails `VALIDATION_FAILED`
  before any handler runs.

```bash
echo '{"method":"capabilities"}' | npx tsx bin/minerva.ts
# {"result":{"abi_version":"1.0.0"}}
```

## Methods

| Method | Params | Result | Errors |
|--------|--------|--------|--------|
| `capabilities` | none | `{abi_version}` (`1.0.0`) | |
| `startRun` | `idea` (required), `target_repo?`, `defaults?`, `tool?` (see [Tool descriptor](#tool-descriptor)) | `{run_id}`. Returns after the first drive turn and any in-process auto-answers | `VALIDATION_FAILED`, `UPSTREAM_ERROR` |
| `getRunStatus` | `run_id` | `{status, metrics, park}`. `park` is the open `pantheon:park-record/v1` or `null`. `status` is `in_progress`, `waiting_on_human`, `complete` or `aborted` | `NOT_FOUND` |
| `listRuns` | none | `{runs: [{run_id, status, created_at}]}` | |
| `getQuestions` | `run_id`, `channel` (`agent` or `human`) | `{questions: Question[]}`, pending questions on that enforced channel. Read-only | `NOT_FOUND`, `VALIDATION_FAILED` |
| `submitAnswers` | `run_id`, `channel`, `answers: [{question_id, answer}]` (exactly one) | `{result: {}, outcome, run_id, park_epoch, resumed_via?}`. The only method that moves a run past a question. A repeat returns `already_resumed`; more than one answer is refused whole | `WRONG_CHANNEL`, `NOT_FOUND`, `VALIDATION_FAILED`, `UPSTREAM_ERROR` |
| `resumeRun` | `run_id`, `cause` (`time` or `signal`), `evidence: {observed_at, signal_key?}`, `park_epoch?` | `{outcome, run_id, park_epoch, resumed_via?}`. Resumes a time- or signal-parked run with no answer, one turn | `NOT_FOUND`, `VALIDATION_FAILED`, `UPSTREAM_ERROR` |
| `getOutput` | `run_id` | `{epic, epics, metrics}`: the plan as plugin-hive epic + story YAML | `NOT_READY`, `NOT_FOUND` |
| `abortRun` | `run_id` | `{result: {}}`. Records cleanup; never deletes the workspace. Idempotent | `NOT_FOUND` |
| `getMetrics` | none | `{generated_at, skipped_records, overall, by_driver, by_lane}`, cross-run planning KPIs | |

### Tool descriptor

`startRun`'s `tool` names the planning tool the run drives. Omit it (or pass `"plugin-hive"`) for
the default, which behaves exactly as before. Otherwise pass a descriptor object; it is validated
strictly (`VALIDATION_FAILED` on any bad field), frozen onto the run record and reused by every
later turn of the run:

| Field | Meaning | plugin-hive default |
| --- | --- | --- |
| `tool.id` | Tool name, stored on the run record as `tool_id` | `plugin-hive` |
| `tool.invoke` | First-turn prompt; every `{idea}` is replaced with the idea | `/plugin-hive:plan {idea} --skip-sign-off --lite` |
| `tool.state_path` | Workspace-relative state dir, created at allocation | `.pHive` |
| `tool.completion_detector` | `{kind: "epics-dir", epics_dir, worktree_roots}`: the run completes once a new epic with stories appears under `epics_dir` (or under `<root>/<name>/<epics_dir>` for each worktree root) | `{kind: "epics-dir", epics_dir: ".pHive/epics", worktree_roots: [".claude/worktrees"]}` |
| `tool.question_source` | `{kind: "envelope-dir", path}` (question envelopes on disk, read by `MINERVA_DRIVER=forked`) or `{kind: "response"}` (questions come back in the turn response; not usable with the forked driver) | `{kind: "envelope-dir", path: ".pHive/questions"}` |
| `tool.base_branch?` | Branch the run worktree is cut from and the plan is pushed to | `MINERVA_BASE_BRANCH`, else `dev` |

All paths are workspace-relative and may not leave the workspace. `MINERVA_DRIVE_PROMPT` overrides
the default descriptor's `invoke` (its old name `MINERVA_TEST_DRIVE_PROMPT` still works); an
explicit descriptor's own `invoke` always wins.

Error codes are a closed enum: `NOT_FOUND`, `VALIDATION_FAILED`, `WRONG_CHANNEL`, `NOT_READY`,
`UPSTREAM_ERROR`, `UNKNOWN_METHOD` (unknown method, or an unexpected internal error).

## The planning loop

A caller such as Auriga drives a seed to a plan like this:

1. `startRun {idea}` and keep the `run_id`.
2. After `startRun` and after each `submitAnswers`, read `getRunStatus` once. While it is
   `waiting_on_human` (or `in_progress`), read `getQuestions` for each channel, get each answer
   from whoever owns that channel, and send it back with one `submitAnswers` call per question
   on the question's own `channel`.
3. Once the status is `complete`, `getOutput` returns the epics and stories. `abortRun` gives up
   on a run at any point.

Nothing advances in the background between calls, so there is nothing to poll for: the run only
moves when `startRun` or `submitAnswers` is called, and both return once the turn is done.

## Smoke test

`tests/e2e/abi-smoke.test.ts` runs this loop end to end through real `bin/minerva.ts`
subprocesses. A scripted stub planner (`tests/e2e/abi-smoke-planner.mjs`) serves the driver
turns, so the test is offline, free and deterministic. It covers every method above plus the
error envelopes a caller has to handle. Run it on its own with:

```bash
npx tsx --import ./tests/setup/no-live-consus.mjs --test --test-force-exit tests/e2e/abi-smoke.test.ts
```

It is also part of `npm test`.
