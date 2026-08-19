---
name: minerva-plan
description: Drive Minerva's headless idea-to-spec engine end to end -- start a run, answer its questions on the right channel, and fetch the finished epic+stories. Use whenever you need to turn a raw idea/requirement into a dependency-tracked, planned spec, or when you're resuming a run that's already parked waiting for an answer.
---

# Minerva Plan

Minerva turns a raw idea into an **approved, planned spec** — an epic with dependency-tracked
stories — autonomously and headlessly. It never guesses or fabricates an answer to advance itself
(**No Autonomous Progress**): a run only moves forward when you call `submitAnswers` with a real
answer. Polling its status never advances it on its own.

Call it via the `minerva` MCP tools (`startRun`, `getRunStatus`, `listRuns`, `getQuestions`,
`submitAnswers`, `getOutput`, `abortRun`, `capabilities`) — registered by `minerva agent init`.
If those tools aren't available, Minerva also speaks the identical contract as a JSON-over-stdio
subprocess ABI (`echo '{"method":"startRun","params":{...}}' | npx tsx bin/minerva.ts`) — same
methods, same shapes, either way.

## The loop

1. **Start:** `startRun({idea: "<the requirement, as free text>"})` → `{run_id}`.
2. **Poll both channels:** `getQuestions({run_id, channel: "agent"})` and
   `getQuestions({run_id, channel: "human"})`.
   - **`agent`-channel questions** are routine, low-stakes gates (tech-stack confirmations, sign-off
     prompts, etc.) — you're expected to answer these yourself, using your own judgment and
     whatever context you already have about the task.
   - **`human`-channel questions** are genuine strategic decisions. **Do not answer these
     yourself, and never guess on the human's behalf.** Surface the question's text to your own
     user/operator, wait for their real answer, then submit exactly that.
3. **Answer:** `submitAnswers({run_id, channel, answers: [{question_id, answer}]})` — `answer` is
   a string for single-select/free-text questions, an array of strings for multi-select.
4. **Repeat** steps 2–3 until `getRunStatus({run_id})` reports `status: "complete"` (or
   `"aborted"`).
5. **Fetch the result:** `getOutput({run_id})` → the approved `epic` (+ `stories`). Fails with
   `NOT_READY` if the run hasn't reached `"complete"` yet — never returns a partial artifact, so
   don't retry-and-hope; check `getRunStatus` first.

## When to use

- Turning an idea/ticket/requirement into a real, dependency-tracked epic + stories.
- Resuming a run you (or another session) started earlier and left parked — `listRuns` to find
  it, then pick back up at step 2 above. Runs persist on disk; nothing times out into a guess.

## When NOT to use

- You already have a real human's answer to a pending `human`-channel question in hand and just
  need to submit it — skip straight to `submitAnswers` (step 3), no need to re-read this skill.
- You're tempted to answer a `human`-channel question yourself because the human seems slow to
  respond, or the answer seems "obvious" — don't. That's exactly the guess this skill exists to
  prevent. Wait for a real answer, or `abortRun` if the run genuinely needs to be abandoned.
- You need Minerva to *build/execute* the planned stories — it only plans. A completed run's
  output hands off to whatever executes stories in your setup (in the Pantheon, that's `Auriga`
  routing to the execution swarm); Minerva's job ends at `getOutput`.

## Example

```
startRun({idea: "add SSO to the billing app"}) -> {run_id: "abc123"}
getQuestions({run_id: "abc123", channel: "agent"}) -> {questions: [{id: "q-1", text: "Use the existing OAuth provider or add a new one?", ...}]}
# routine, technical -- answer it yourself
submitAnswers({run_id: "abc123", channel: "agent", answers: [{question_id: "q-1", answer: "existing provider"}]})
getQuestions({run_id: "abc123", channel: "human"}) -> {questions: [{id: "q-2", text: "Should SSO be mandatory or optional for existing users?", ...}]}
# strategic -- ask your user, do not guess
# ... user replies "optional, for now" ...
submitAnswers({run_id: "abc123", channel: "human", answers: [{question_id: "q-2", answer: "optional, for now"}]})
getRunStatus({run_id: "abc123"}) -> {status: "complete"}
getOutput({run_id: "abc123"}) -> {epic: {...}, stories: [...]}
```
