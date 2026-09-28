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
| `escalations` | number | `getQuestions` calls on the `human` channel that returned at least one question |
| `auto_resolutions` | number | Questions answered in-process from plan defaults |
| `driver` | string | Driver that ran the turns (e.g. `spawn`, `subagent`, or an agnostic-plan runtime) |
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

!!! note "Channel semantics"
    `getQuestions` and `submitAnswers` gate on the **enforced** `channel`, never on
    `suggested_channel`. The classifier emits `suggested_channel` + `confidence` + `reason`;
    an external policy layer owns the enforced value. In v1 (no policy layer wired), the
    enforced channel defaults to `suggested_channel`.

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
