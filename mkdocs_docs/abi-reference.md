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
{"result":{"abi_version":"1.0.0","methods":["capabilities","startRun","getRunStatus","listRuns","getQuestions","submitAnswers","getOutput","abortRun"]}}
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
