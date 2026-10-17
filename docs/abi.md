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
| `startRun` | `idea` (required), `target_repo?`, `defaults?` | `{run_id}`. Returns after the first drive turn and any in-process auto-answers | `VALIDATION_FAILED`, `UPSTREAM_ERROR` |
| `getRunStatus` | `run_id` | `{status, metrics}`. `status` is `in_progress`, `waiting_on_human`, `complete` or `aborted` | `NOT_FOUND` |
| `listRuns` | none | `{runs: [{run_id, status, created_at}]}` | |
| `getQuestions` | `run_id`, `channel` (`agent` or `human`) | `{questions: Question[]}`, pending questions on that enforced channel. Read-only | `NOT_FOUND`, `VALIDATION_FAILED` |
| `submitAnswers` | `run_id`, `channel`, `answers: [{question_id, answer}]` (exactly one) | `{result: {}}`. The only method that moves a run past a question | `WRONG_CHANNEL`, `NOT_FOUND`, `VALIDATION_FAILED`, `UPSTREAM_ERROR` |
| `getOutput` | `run_id` | `{epic, epics, metrics}`: the plan as plugin-hive epic + story YAML | `NOT_READY`, `NOT_FOUND` |
| `abortRun` | `run_id` | `{result: {}}`. Records cleanup; never deletes the workspace. Idempotent | `NOT_FOUND` |
| `getMetrics` | none | `{generated_at, skipped_records, overall, by_driver, by_lane}`, cross-run planning KPIs | |

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
