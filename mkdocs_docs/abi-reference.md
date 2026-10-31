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
| `defaults` | object | no | Per-run plan-defaults override. `defaults.file` names a YAML/JSON defaults file (e.g. `config/operator-defaults.yaml`) loaded under the inline fields (see [Configuration](configuration.md#operator-defaults-file)) |

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
| `park` | ParkRecord \| null | The open park, shaped as `pantheon:park-record/v1`; `null` when the run is not parked or is finished |

**`ParkRecord` shape** (pantheon-v2 `contracts/l1/interaction-lifecycle.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `schema` | `"pantheon:park-record/v1"` | |
| `integration` | `"minerva"` | |
| `run_id` | string | |
| `park_epoch` | number | Increments on every park. A resume names the epoch it is resuming. |
| `reason` | object | `{kind:"awaiting-answer", question_id, open_qids}`, `{kind:"awaiting-time", not_before, renewals}` or `{kind:"awaiting-signal", signal_key, not_after?}` |
| `parked_at` | string | ISO 8601 |
| `open_qids` | string[] | Pending question ids |
| `state_ref` | object | `{kind:"file", path}`: the run's worktree on the parking host. It is file-local, so a resume on another device is out of scope. |
| `resume` | object | `{method:"session", session_id}` when the drive session can be resumed, `{method:"state"}` when the next turn must rebuild from `state_ref` |
| `workspace` | object | `{host, path}` |

**`RunMetrics` shape:**

| Field | Type | Description |
|-------|------|-------------|
| `turns` | number | Driver turns taken so far |
| `escalations` | number | `human`-channel questions parked for a human, each counted once when parked (reading via `getQuestions` never counts) |
| `auto_resolutions` | number | Questions answered in-process from plan defaults |
| `driver` | string | Driver that ran the turns (e.g. `spawn`, `subagent`, or an agnostic-plan runtime) |
| `lane` | string? | Route lane of the run's first driver turn that reported one: core-api's `chosen_lane` (e.g. `claude@ffevents`) when the route came with a decision, otherwise `"<cli>:<model>"` |
| `started_at` | string | ISO 8601 timestamp |
| `elapsed_ms` | number? | Set once the run finishes or is aborted |
| `finalized_at` | string? | ISO 8601 timestamp, set with `elapsed_ms` |
| `decision_id` | string? | core-api `/api/route/select` decision behind the latest routed turn |
| `chosen_lane` | string \| null? | Lane that decision picked (e.g. `claude@ffevents`) |
| `experiment_arm` | string \| null? | Routing experiment arm, when core-api reports one |

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
| `status` | `"pending"` \| `"answered"` \| `"superseded"` | `superseded`: an optional envelope question left unanswered when its set closed (never returned by `getQuestions`) |
| `kind` | string? | Optional: `"single-select"`, `"multi-select"`, `"free-text"` |
| `options` | string[] \| null? | Available options (present for `single-select`/`multi-select` kinds) |
| `qid` | string? | Envelope question id — used for `answers` matching in plan defaults |
| `set_id` | string? | Open question set this question belongs to. Forked-driver envelope questions share the envelope id; a prose driver's question is a set of 1 (`set_id` = its own `id`). Absent on records written before this field |
| `required` | boolean? | Envelope questions only: whether the envelope needs an answer to this question before it closes |
| `escalated_at` | string? | ISO 8601 — when this question was first parked on the `human` queue (see [`getMetrics`](#getmetrics)) |

!!! note "Open question sets"
    When a run parks, it records every question Minerva can know without driving another turn.
    A forked-driver envelope with several questions parks all of them at once, sharing one
    `set_id`. Answering one of them (via `submitAnswers`) does not drive a new turn until every
    `required` question of the set is answered. Prose drivers (spawn/subagent/agnostic) still
    park one question at a time, because each later gate depends on the earlier answer.

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

Each call answers exactly **one** question: `answers` must contain exactly one entry. A request
with more than one entry is refused whole with `VALIDATION_FAILED`: no answer in it is applied and
the run is left unchanged. (Staged multi-answer sets are PANT-925.)

**Idempotent.** The question stays pending until the resumed turn has been recorded, and a
claim on the run keeps a concurrent caller out while the turn runs. Re-submitting a question
that was already answered returns `outcome: "already_resumed"` and drives no turn; a call
landing while another caller's turn is still running returns `already_resumed` too (same
question) or `claimed` (a different one). A claim left by a crashed process (dead pid on the
same host, or older than `MINERVA_RESUME_CLAIM_STALE_MS`, default 6 h) is released on the next
read, so the question is answerable again.

**Fallback when the session is gone.** If the recorded drive session no longer resolves, or
the run never recorded one, the turn is rebuilt from `state_ref` (the run's worktree): a fresh
session gets the run's original drive prompt plus the answer. The reply says
`resumed_via: "state"`. If the worktree is gone too, the call fails with `VALIDATION_FAILED`
and the question stays pending.

If the resumed turn fails (timeout after retries, auth, routing), the error is returned and the
question goes back to `pending` with the run back in `waiting_on_human`. The same question can be
answered again with another `submitAnswers` call.

**Params:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string (UUID) | The run to advance |
| `channel` | `"agent"` \| `"human"` | Must match the enforced `channel` of every answered question |
| `answers` | Answer[] | Exactly one answer |
| `park_epoch` | number? | The epoch you read from `getRunStatus`. A stale epoch returns `stale_handle` and records the answer under `stale_answers` without driving a turn. |

**`Answer` shape:**

| Field | Type | Description |
|-------|------|-------------|
| `question_id` | string | The question `id` from `getQuestions` |
| `answer` | string \| string[] | The answer text; a string array for `multi-select` questions |

**Returns:** a ResumeResult. The legacy empty `result` object is kept for older callers.

| Field | Type | Description |
|-------|------|-------------|
| `result` | `{}` | Legacy field |
| `outcome` | string | `resumed`, `already_resumed`, `stale_handle` or `claimed` |
| `run_id` | string | |
| `park_epoch` | number | The epoch this call resolved against |
| `resumed_via` | `"session"` \| `"state"`? | Present when `outcome` is `resumed` |

**Errors:**

| Code | Meaning |
|------|---------|
| `WRONG_CHANNEL` | `channel` in the request doesn't match the question's enforced `channel` |
| `NOT_FOUND` | `run_id` doesn't exist, or `question_id` is not a pending question on it |
| `VALIDATION_FAILED` | Malformed payload (e.g. `answers` empty or with more than one entry, or an entry missing `question_id`), or the session is gone and the worktree cannot be rebuilt |

**Example:**
```bash
echo '{"method":"submitAnswers","params":{
  "run_id":"<run_id>",
  "channel":"human",
  "answers":[{"question_id":"q-001","answer":"Required for all users — no opt-out"}]
}}' | npx tsx bin/minerva.ts
```
```json
{"result":{"result":{},"outcome":"resumed","run_id":"<run_id>","park_epoch":1,"resumed_via":"session"}}
```

---

## `resumeRun`

Resume a run that is parked on **time** or a **signal**, with no answer. One turn is driven
and the run advances: it completes, parks on a new question, or fails.

`cause` must fit the open park (`getRunStatus`'s `park.reason`). Use `"time"` for an
`awaiting-time` park, once `evidence.observed_at` is at or after `not_before`. Use `"signal"`
for an `awaiting-signal` park, with `evidence.signal_key` equal to the park's `signal_key`.
Anything else, including a run parked on a question, returns `outcome: "refused"` with
`problems` and drives nothing. Answers go through `submitAnswers`.

The same claim, idempotency and session-gone fallback as `submitAnswers` apply. A repeat of a
resume that already ran (same `park_epoch`) returns `already_resumed` without a second turn,
even after the run has moved on to a new park.

**Params:**

| Field | Type | Description |
|-------|------|-------------|
| `run_id` | string (UUID) | The run to resume |
| `cause` | `"time"` \| `"signal"` | Why the run is being resumed |
| `evidence` | object | `{observed_at, signal_key?, detail?}`: when the time passed or the signal arrived |
| `park_epoch` | number | **Required.** The epoch you read from `getRunStatus` (`park.park_epoch`). It is the idempotency key: a repeat with the same epoch returns `already_resumed`, and an epoch the run has not reached, or has left without being resumed, returns `stale_handle`. |

**Returns:** a ResumeResult: `{outcome, run_id, park_epoch}` plus `resumed_via` when `outcome`
is `resumed`, `problems` when it is `refused`, and `claimed_by` when it is `claimed`.

**Errors:**

| Code | Meaning |
|------|---------|
| `NOT_FOUND` | `run_id` doesn't exist |
| `VALIDATION_FAILED` | Malformed `cause` or `evidence`, missing `park_epoch`, or the session is gone and the worktree cannot be rebuilt |

**Example:**
```bash
echo '{"method":"resumeRun","params":{
  "run_id":"<run_id>",
  "cause":"time",
  "evidence":{"observed_at":"2026-10-31T18:00:00.000Z"},
  "park_epoch":2
}}' | npx tsx bin/minerva.ts
```
```json
{"result":{"outcome":"resumed","run_id":"<run_id>","park_epoch":2,"resumed_via":"session"}}
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
| `by_lane` | `{[lane]: MetricsGroup}` | Keyed by `metrics.lane`: the lane the run's first driver turn ran on (core-api's `chosen_lane`, or `"<cli>:<model>"` when there was no routing decision) |

Runs recorded before a field existed are grouped under `"unknown"`. A legacy run with no captured
lane falls back to `metrics.chosen_lane`, then to its frozen `plan_runtime:plan_model`, when present.

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
    "by_lane": {"claude@ffevents": {"runs": 3, "...": "same MetricsGroup shape"}}
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
