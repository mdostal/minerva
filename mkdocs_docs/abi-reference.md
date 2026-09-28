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

Declare the ABI version. Call this once from any long-lived caller to discover which methods are
available.

**Params:** none

**Returns:**

| Field | Type | Description |
|-------|------|-------------|
| `abi_version` | string | Semver — the Minerva ABI version (currently `1.0.0`) |
| `methods` | string[] | List of all registered method names |

**Example:**
```bash
echo '{"method":"capabilities"}' | npx tsx bin/minerva.ts
```
```json
{"result":{"abi_version":"1.0.0","methods":["capabilities","startRun","getRunStatus","listRuns","getQuestions","submitAnswers","getOutput","abortRun","getMetrics"]}}
```

---

## `startRun`

Allocate a new run: reserve a run id, create an isolated workspace, and begin the kickoff+plan
loop.

**Params:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `idea` | string | yes | The idea or feature brief to plan |
| `target_repo` | string | no | Absolute path to an existing local repo. If present, Minerva cuts a git worktree off that repo's `dev` branch. If absent, Minerva creates a fresh `git init` scratch repo (greenfield). |
| `constraints` | object | no | Optional planning constraints passed to the kickoff engine |
| `defaults` | object | no | Per-run plan-defaults override (see [Configuration](configuration.md)) |

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

!!! note "Workspace allocation"
    - `target_repo` present → worktree cut from that repo's `dev` branch
    - `target_repo` absent → fresh `git init` scratch repo in `~/.minerva/runs/<run_id>/`

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
{"result":{"status":"waiting_on_human"}}
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
| `idea` | string | The idea brief that started this run |

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
| `kind` | string? | Optional: `"select"`, `"multiselect"`, `"freetext"` |
| `options` | string[]? | Available options (present for `select`/`multiselect` kinds) |
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

Submit answers to pending questions, advancing the run.

**This is the only method that advances a run.** Between calls, nothing moves.

**Params:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string (UUID) | The run to advance |
| `channel` | `"agent"` \| `"human"` | Must match the enforced `channel` of every answered question |
| `answers` | Answer[] | Answers to submit |

**`Answer` shape:**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | The question id from `getQuestions` |
| `answer` | string | The answer text |

**Returns:** `{}` on success.

**Errors:**

| Code | Meaning |
|------|---------|
| `WRONG_CHANNEL` | `channel` in the request doesn't match a question's enforced `channel` |
| `NOT_FOUND` | `run_id` doesn't exist |
| `VALIDATION_FAILED` | Malformed payload |

**Example:**
```bash
echo '{"method":"submitAnswers","params":{
  "run_id":"<run_id>",
  "channel":"human",
  "answers":[{"id":"q-001","answer":"Required for all users — no opt-out"}]
}}' | npx tsx bin/minerva.ts
```
```json
{"result":{}}
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
| `epic` | object | The approved epic + stories in plugin-hive's native `.pHive/epics/` schema |

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

**Returns:** `{}` on success.

**Example:**
```bash
echo '{"method":"abortRun","params":{"run_id":"<run_id>"}}' \
  | npx tsx bin/minerva.ts
```
```json
{"result":{}}
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
