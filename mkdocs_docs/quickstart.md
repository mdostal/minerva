# Quickstart

Minerva is a subprocess: one JSON request in on stdin, one JSON response out on stdout, exit `0`
on `result`, exit `1` on `error`. No server to start.

## Install

```bash
npm install
```

No build step — `bin/minerva.ts` runs directly via `tsx`.

## The flow

A Minerva run follows a simple, call-by-call loop:

```
startRun   →   getQuestions   →   submitAnswers   →   ... (repeat until complete)
                                                   →   getOutput
```

Each step is a separate process invocation. Run state lives on disk between calls.

## Step-by-step

### 1. Check the ABI version

```bash
echo '{"method":"capabilities"}' | npx tsx bin/minerva.ts
```

```json
{"result":{"abi_version":"1.0.0","methods":["capabilities","startRun",...]}}
```

### 2. Start a run

Give Minerva an idea. It allocates a run id and begins the kickoff+plan loop.

```bash
echo '{"method":"startRun","params":{"idea":"add SSO to the billing app"}}' \
  | npx tsx bin/minerva.ts
```

```json
{"result":{"run_id":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}}
```

To target an existing repo (creates an isolated git worktree off `dev`):

```bash
echo '{"method":"startRun","params":{
  "idea":"add SSO to the billing app",
  "target_repo":"/path/to/billing-app"
}}' | npx tsx bin/minerva.ts
```

### 3. Check for questions

Minerva pauses when it needs a decision. Pull pending questions:

```bash
echo '{"method":"getQuestions","params":{"run_id":"<run_id>","channel":"human"}}' \
  | npx tsx bin/minerva.ts
```

```json
{
  "result": {
    "questions": [
      {
        "id": "q-001",
        "text": "Should SSO be required for all users or opt-in?",
        "suggested_channel": "human",
        "channel": "human",
        "confidence": 0.9,
        "reason": "Strategic, irreversible scope decision — human should decide",
        "status": "pending"
      }
    ]
  }
}
```

Check the `agent` channel for routine questions Minerva auto-classifies as mechanical:

```bash
echo '{"method":"getQuestions","params":{"run_id":"<run_id>","channel":"agent"}}' \
  | npx tsx bin/minerva.ts
```

### 4. Submit answers

Answer pending questions to advance the run:

```bash
echo '{"method":"submitAnswers","params":{
  "run_id":"<run_id>",
  "channel":"human",
  "answers":[{"id":"q-001","answer":"Required for all users"}]
}}' | npx tsx bin/minerva.ts
```

```json
{"result":{}}
```

`submitAnswers` is the **only** method that advances a run. Repeat steps 3–4 until the run
reaches `complete`.

### 5. Check run status

```bash
echo '{"method":"getRunStatus","params":{"run_id":"<run_id>"}}' \
  | npx tsx bin/minerva.ts
```

```json
{"result":{"status":"complete"}}
```

Possible statuses: `in_progress`, `waiting_on_human`, `complete`, `aborted`.

!!! note "`in_progress` means paused, not running"
    Between `submitAnswers` calls, `in_progress` means the run is paused waiting for the next
    drive call. Nothing is running in the background.

### 6. Get the output

Once `status` is `complete`, retrieve the approved epic + stories:

```bash
echo '{"method":"getOutput","params":{"run_id":"<run_id>"}}' \
  | npx tsx bin/minerva.ts
```

```json
{
  "result": {
    "epic": {
      "title": "Add SSO to the billing app",
      "stories": [...]
    }
  }
}
```

## Other useful methods

```bash
# List all runs
echo '{"method":"listRuns","params":{}}' | npx tsx bin/minerva.ts

# Abort a run (records cleanup event; does not delete workspace)
echo '{"method":"abortRun","params":{"run_id":"<run_id>"}}' | npx tsx bin/minerva.ts
```

## Headless mode (pre-baked defaults)

To run fully unattended, set `MINERVA_PLAN_DEFAULTS_MODE`:

```bash
# Auto-answer all questions (no human in the loop)
MINERVA_PLAN_DEFAULTS_MODE=auto \
  echo '{"method":"startRun","params":{"idea":"scaffold a new TypeScript library"}}' \
  | npx tsx bin/minerva.ts

# Agent mode: auto-answer only routine (agent-channel) questions; park human-gate ones
MINERVA_PLAN_DEFAULTS_MODE=agent \
  echo '{"method":"startRun","params":{"idea":"add metrics to the API"}}' \
  | npx tsx bin/minerva.ts
```

See [Configuration](configuration.md) for full details on pre-baked defaults.

## Next steps

- [ABI Reference](abi-reference.md) — full parameter and response shapes for all 8 methods
- [MCP Server](mcp-server.md) — use Minerva as a native tool in Claude Code or Codex CLI
- [Configuration](configuration.md) — env vars, plan defaults, and driver selection
