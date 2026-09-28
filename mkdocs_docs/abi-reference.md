# ABI Reference

Minerva exposes a **JSON-over-stdio subprocess ABI**: one `{method, params}` request on stdin,
one `{result}` or `{error}` response on stdout, exit `0` on success, exit `1` on error. Every
call is a fresh process; run state persists on the filesystem.

The wire format is compatible with plugin-hive's task-tracking adapter ABI (v1.0.0).

## Envelope format

**Request:**
```json
{"method": "methodName", "params": {"key": "value"}}
```

**Success response:**
```json
{"result": {"key": "value"}}
```

**Error response:**
```json
{"error": {"code": "ERROR_CODE", "message": "Human-readable message", "retry_after_ms": null}}
```

---

## `capabilities`

Declare the ABI version. Call this once from any long-lived caller to check which ABI it is
talking to. It does **not** list methods; the method set is the one documented on this page.

**Params:** none

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `abi_version` | string | Semver — the Minerva ABI version (currently `1.0.0`) |

**Example:**
```bash
echo '{"method":"capabilities"}' | npx tsx bin/minerva.ts
```
```json
{"result":{"abi_version":"1.0.0"}}
```

---

## `startRun`

Allocate a new run: reserve a run id, create an isolated workspace, and begin the kickoff+plan
loop.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `idea` | string | yes | The idea or feature brief to plan |
| `target_repo` | string | no | Absolute path to an existing local repo. Minerva cuts a git worktree off that repo's `dev` branch. If absent, see *Workspace allocation* below. |
| `defaults` | object | no | Per-run plan-defaults override (see [Configuration](configuration.md)) |

Any other params are ignored.

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string | UUID — use this in all subsequent calls |

**Example:**
```bash
echo '{"method":"startRun","params":{"idea":"add SSO to the billing app"}}' \
  | npx tsx bin/minerva.ts
```
```json
{"result":{"run_id":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}}
```

`startRun` returns only after the first drive turn and any in-process auto-answering (see
[`submitAnswers`](#submitanswers)) have finished.

!!! note "Workspace allocation"
    The workspace is always a git worktree (branch `run/<run_id>`, cut from `dev`) at
    `MINERVA_HOME/runs/<run_id>/workspace`. The repo it is cut from is resolved in this order:

    1. `target_repo`, if given
    2. a god/component repo from `MINERVA_REPO_MAP` whose key matches the idea
    3. `MINERVA_INCUBATOR_REPO`, if set
    4. otherwise the seed repo: `MINERVA_SEED_REPO`, defaulting to `~/repos/consus-seeds`.
       If that path doesn't exist, `startRun` fails with `VALIDATION_FAILED`.

    If `MINERVA_ALLOWED_TARGET_REPOS` is set, a repo resolved by steps 1–3 must be on that
    allowlist or `startRun` fails with `VALIDATION_FAILED`.

---

## `getRunStatus`

Check the current status of a run.

**Params:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string (UUID) | The run to query |

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | One of: `in_progress`, `waiting_on_human`, `complete`, `aborted` |
| `metrics` | RunMetrics \| null | Per-run planning metrics (`null` for runs recorded before metrics existed) |

**`RunMetrics` shape:**

| Field | Type | Description |
|-------|------|-------------|
| `turns` | number | Driver turns taken so far |
| `escalations` | number | `human`-channel questions parked for a human, each counted once when parked (reading via `getQuestions` never counts) |
| `auto_resolutions` | number | Questions answered in-process from plan defaults |
| `driver` | string | Driver that ran the turns (e.g. `spawn`, `subagent`, or an agnostic-plan runtime) |
| `lane` | string? | Route lane `"<cli>:<model>"` of the run's first driver turn that reported one |
| `started_at` | string | ISO 8601 timestamp |
| `elapsed_ms` | number? | Set once the run finishes or is aborted |
| `finalized_at` | string? | ISO 8601 timestamp, set with `elapsed_ms` |

**Status meanings:**

| Status | Meaning |
|--------|---------|
| `in_progress` | Run is paused awaiting the next `submitAnswers` call. Nothing is running in the background. |
| `waiting_on_human` | A `human`-channel question is pending. The run will not advance until `submitAnswers` provides the answer. |
| `complete` | The run finished successfully. Call `getOutput` to retrieve the epic + stories. |
| `aborted` | The run was aborted. Call `abortRun` to record cleanup and emit the cleanup event if not already done. |

**Example:**
```bash
echo '{"method":"getRunStatus","params":{"run_id":"<run_id>"}}' \
  | npx tsx bin/minerva.ts
```
```json
{"result":{"status":"waiting_on_human","metrics":{"turns":3,"escalations":1,"auto_resolutions":2,"driver":"spawn","started_at":"2026-09-28T04:00:00.000Z"}}}
```

---

## `listRuns`

List all known runs with summary information.

**Params:** none (pass `{}`)

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `runs` | RunSummary[] | All runs tracked in `MINERVA_HOME` |

**`RunSummary` shape:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string | UUID |
| `status` | string | Current status |
| `created_at` | string | ISO 8601 timestamp |

**Example:**
```bash
echo '{"method":"listRuns","params":{}}' | npx tsx bin/minerva.ts
```

---

## `getQuestions`

Get pending questions for a run, filtered by channel.

**Params:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string (UUID) | The run to query |
| `channel` | `"agent"` \| `"human"` | Only return questions whose enforced `channel` matches |

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `questions` | Question[] | Pending questions on the requested channel |

**`Question` shape:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique question id within this run |
| `text` | string | The question text, verbatim and atomic (never batched) |
| `channel` | `"agent"` \| `"human"` | **Enforced** routing — what `submitAnswers` must use |
| `suggested_channel` | `"agent"` \| `"human"` | Escalation classifier's suggestion (not enforced) |
| `confidence` | number | 0.0–1.0 — classifier's confidence in `suggested_channel` |
| `reason` | string | Why the classifier suggested this channel |
| `status` | `"pending"` \| `"answered"` | Whether this question has been answered |
| `kind` | string? | Optional: `"single-select"`, `"multi-select"`, `"free-text"` |
| `options` | string[] \| null? | Available options (present for `single-select`/`multi-select` kinds) |
| `qid` | string? | Envelope question id — used for `answers` matching in plan defaults |
| `escalated_at` | string? | ISO 8601 — when this question was first parked on the `human` queue (see [`getMetrics`](#getmetrics)) |

!!! note "Channel semantics"
    `getQuestions` and `submitAnswers` gate on the **enforced** `channel`, never on
    `suggested_channel`. The classifier emits `suggested_channel` + `confidence` + `reason`;
    an external policy layer owns the enforced value. In v1 (no policy layer wired), the
    enforced channel defaults to `suggested_channel`.

!!! note "Reading never counts as an escalation"
    `getQuestions` is read-only. A run's `metrics.escalations` counts each `human`-channel
    question once, when it is parked on the human queue (classified `human` at creation, or
    escalated from the `agent` queue by the auto-answer loop). Polling the same parked question
    any number of times leaves the counter unchanged.

**Example:**
```bash
echo '{"method":"getQuestions","params":{"run_id":"<run_id>","channel":"human"}}' \
  | npx tsx bin/minerva.ts
```
```json
{
  "result": {
    "questions": [{
      "id": "q-001",
      "text": "Should SSO be required for all users or opt-in per user?",
      "channel": "human",
      "suggested_channel": "human",
      "confidence": 0.92,
      "reason": "Strategic, irreversible scope decision — requires human judgment",
      "status": "pending"
    }]
  }
}
```

---

## `submitAnswers`

Submit an answer to a pending question, advancing the run.

**This is the only ABI method that advances a run past a question it has surfaced.** Between
calls, nothing moves in the background. Within a `startRun` or `submitAnswers` call, though,
Minerva auto-answers routine gate questions in-process from the run's plan defaults (see
[Configuration](configuration.md)) until it hits a question with no default, the run
completes, or `max_auto_answers` (default `40`) answers have been given. With plan-defaults
mode `off`, nothing is auto-answered.

Only the **first** entry of `answers` is applied per call.

**Params:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string (UUID) | The run to advance |
| `channel` | `"agent"` \| `"human"` | Must match the enforced `channel` of every answered question |
| `answers` | Answer[] | Non-empty list of answers; only the first is applied |

**`Answer` shape:**

| Field | Type | Description |
|-------|------|-------------|
| `question_id` | string | The question `id` from `getQuestions` |
| `answer` | string \| string[] | The answer text; a string array for `multi-select` questions |

**Returns:** an empty object on success. Note that the handler currently wraps it, so the wire
response is `{"result":{"result":{}}}`.

**Errors:**

| Code | Meaning |
|------|---------|
| `WRONG_CHANNEL` | `channel` in the request doesn't match the question's enforced `channel` |
| `NOT_FOUND` | `run_id` doesn't exist, or `question_id` is not a pending question on it |
| `VALIDATION_FAILED` | Malformed payload (e.g. `answers` empty, or an entry missing `question_id`) |

**Example:**
```bash
echo '{"method":"submitAnswers","params":{
  "run_id":"<run_id>",
  "channel":"human",
  "answers":[{"question_id":"q-001","answer":"Required for all users — no opt-out"}]
}}' | npx tsx bin/minerva.ts
```
```json
{"result":{"result":{}}}
```

---

## `getOutput`

Retrieve the approved epic + stories for a completed run.

**Params:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string (UUID) | The run to retrieve output from |

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `epic` | CompletedEpic | The first of the run's epics (kept for backward compatibility) |
| `epics` | CompletedEpic[] | All epics the run produced — a single plan can produce several |
| `metrics` | RunMetrics \| null | Final run metrics (see [`getRunStatus`](#getrunstatus)) |

**`CompletedEpic` shape:**

| Field | Type | Description |
|-------|------|-------------|
| `epic_id` | string | The epic's id |
| `epic_yaml` | string | Raw epic YAML in plugin-hive's native `.pHive/epics/` schema |
| `stories` | `{id, content}[]` | The epic's stories, each as raw YAML |
| `entry_name` | string | The directory or file name under `.pHive/epics/` |
| `layout` | `"nested"` \| `"flat"` | `<id>/epic.yaml` + `stories/*.yaml`, or one `NN-name.yaml` file |

**Errors:**

| Code | Meaning |
|------|---------|
| `NOT_READY` | The run is not yet `complete`. Check `getRunStatus` first. |
| `NOT_FOUND` | `run_id` doesn't exist |

**Example:**
```bash
echo '{"method":"getOutput","params":{"run_id":"<run_id>"}}' \
  | npx tsx bin/minerva.ts
```

---

## `abortRun`

Explicitly abort a run. Records a `CleanupLedgerRecord` and emits a `cleanup_needed` event.
**Does not delete the workspace** — that is an external GC's responsibility.

Natural run completion (the final `submitAnswers` that closes a run) triggers the same ledger
write and event as a side effect.

**Params:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string (UUID) | The run to abort |

**Returns:** an empty object on success, wrapped the same way as `submitAnswers`. Idempotent:
aborting an already `complete` or `aborted` run records nothing new.

**Example:**
```bash
echo '{"method":"abortRun","params":{"run_id":"<run_id>"}}' \
  | npx tsx bin/minerva.ts
```
```json
{"result":{"result":{}}}
```

---

## `getMetrics`

Summarize planning KPIs across every run in `MINERVA_HOME`, grouped overall, by driver, and by
route lane. Read-only. It reads only the local run records (standalone-first), never the
network.

**Params:** none (pass `{}`)

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `generated_at` | string | ISO 8601 timestamp of this summary |
| `skipped_records` | number | Run records that could not be parsed and were left out |
| `overall` | MetricsGroup | Every run |
| `by_driver` | `{[driver]: MetricsGroup}` | Keyed by `metrics.driver` (`spawn`, `subagent`, `forked`, or an agnostic runtime such as `opencode`) |
| `by_lane` | `{[lane]: MetricsGroup}` | Keyed by route lane `"<cli>:<model>"`, the lane the run's first driver turn ran on |

Runs recorded before a field existed are grouped under `"unknown"`. A legacy run with no captured
lane falls back to its frozen `plan_runtime:plan_model` when present.

**`MetricsGroup` shape:**

| Field | Type | Description |
|-------|------|-------------|
| `runs` | number | Runs in the group |
| `by_status` | `{in_progress, waiting_on_human, complete, aborted}` | Run count by current status |
| `completion_rate` | number \| null | `complete / (complete + aborted)`. In-flight runs are excluded. `null` until a run in the group finishes |
| `turns` | Distribution | Driver turns per run |
| `escalations` | Distribution | Human-queue escalations per run (counted once per question) |
| `auto_resolutions` | Distribution | Questions answered from pre-baked defaults per run |
| `time_to_spec_ms` | Distribution | Start-to-finalization wall clock, over **complete** runs only |

**`Distribution` shape:** `{median, p90}`, nearest-rank percentiles, so each is an observed
value. Both are `null` when the group has no samples.

**Example:**
```bash
echo '{"method":"getMetrics","params":{}}' | npx tsx bin/minerva.ts
# or, pretty-printed:
npx tsx bin/minerva.ts metrics
```
```json
{
  "result": {
    "generated_at": "2026-09-28T12:00:00.000Z",
    "skipped_records": 0,
    "overall": {
      "runs": 3,
      "by_status": {"in_progress": 0, "waiting_on_human": 1, "complete": 2, "aborted": 0},
      "completion_rate": 1,
      "turns": {"median": 3, "p90": 5},
      "escalations": {"median": 1, "p90": 1},
      "auto_resolutions": {"median": 2, "p90": 4},
      "time_to_spec_ms": {"median": 184000, "p90": 412000}
    },
    "by_driver": {"spawn": {"runs": 3, "...": "same MetricsGroup shape"}},
    "by_lane": {"claude:claude-sonnet-5": {"runs": 3, "...": "same MetricsGroup shape"}}
  }
}
```

!!! note "Lifecycle telemetry"
    Separately from these per-run aggregates, every driver (`spawn`, `subagent`, `forked`)
    appends `driver_started` / `driver_succeeded` / `driver_failed` JSONL events to
    `<MINERVA_HOME>/events/`. Each event carries `driver`; `driver_succeeded` also carries
    `lane` when the turn resolved a route.

---

## Error codes

Closed enum — all possible codes:

| Code | When |
|------|------|
| `NOT_FOUND` | `run_id` doesn't exist in `MINERVA_HOME` |
| `VALIDATION_FAILED` | Malformed request — missing required fields, invalid `run_id` (must be UUID-shaped), etc. |
| `WRONG_CHANNEL` | `submitAnswers` `channel` doesn't match the question's enforced `channel` |
| `NOT_READY` | `getOutput` called before the run is `complete` |
| `UPSTREAM_ERROR` | An upstream dependency (e.g. Heimdall routing) failed |
| `UNKNOWN_METHOD` | Method name not recognized, or an unexpected internal error |
