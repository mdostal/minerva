# plugin-hive kickoff — headless drivability findings (Risk-A PoC spike)

Mandated by `docs/decisions/kickoff-review.md` § "Risk A — PoC SPIKE FIRST." Gates
`/hive:plan`. Executed against real `claude -p` subprocesses (real API calls, kept to
`claude-haiku-4-5` and short prompts to stay cheap — total spike cost **$0.088**) in
throwaway scratch git repos under `os.tmpdir()`. No scratch repos or state were left behind.

Executable record: `docs/spike-plugin-hive-drivability-spike.test.ts` (`node:test`, run via
`npx tsx --test docs/spike-plugin-hive-drivability-spike.test.ts`). Full pass output pasted at
the bottom of this doc. That file covers the two fast, deterministic-enough mechanism checks
(tool availability, stop/resume-with-context); the real kickoff skill run (§ 3-4 below, the
expensive/slow/non-deterministic part) was executed manually and is documented here with real
output rather than encoded as a brittle automated assertion — same tradeoff Auriga's
`multica-lock-api-spike.test.ts` made between automated route-probes and manually-documented
findings.

## Headline finding

**plugin-hive's kickoff IS headlessly drivable end-to-end — but not via the mechanism
`docs/architecture.md` implicitly assumed.** `AskUserQuestion` (the tool kickoff uses for every
human-gate question — the same tool used throughout this project's own `/plugin-hive:kickoff`
session) **does not exist as an available tool in a headless (`claude -p`) session at all.**
The model doesn't hang, error, or fail waiting for it — it searches for the tool, doesn't find
it, and **the kickoff skill degrades gracefully on its own**: it asks the exact same gating
question as plain Markdown prose at the end of its turn, then stops (`stop_reason: end_turn`,
process exits `0`). This is a real, moderate divergence from the assumed mechanism — smaller
than Auriga's Multica finding (an entire assumed API surface not existing), but the same shape:
the *interface* Minerva's architecture assumed (structured `AskUserQuestion` tool-call data)
isn't what's actually there; what's actually there (a clean prose question + turn-end) is
functionally sufficient, just not structured the way `getQuestions` currently assumes it can be.

## 1. Headless invocation — confirmed

`claude -p --session-id <uuid> --model claude-haiku-4-5-20251001 --output-format json
--permission-mode bypassPermissions "<prompt>"` runs a real Claude Code session
non-interactively, to completion, and exits. No TTY, no interactive picker rendered, no hang.
Every invocation in this spike returned `is_error: false` and a real `total_cost_usd`.

## 2. AskUserQuestion is unavailable headlessly — confirmed

Prompted to explicitly call `AskUserQuestion` with a trivial question, the model (real output,
`claude-haiku-4-5-20251001`, `bypassPermissions`):

```
i don't see an `askuserquestion` tool available in this environment. i've searched through
both the standard tools and deferred tools, but this tool isn't listed or accessible.

the available tools i have are:
- agent, bash, edit, read, reportfindings, schedulewakeup, skill, toolsearch, workflow, write
- deferred tools like taskcreate, tasklist, sendmessage, webfetch, websearch, and various mcp tools

is it possible the tool has a different name, or would you like me to help with something else?
```

`stop_reason: end_turn`, `is_error: false`. It did not retry the tool call in a loop, did not
crash, and — critically — did not guess an answer on the human's behalf. It just reported the
tool wasn't there and stopped. Session transcript persisted to disk at
`~/.claude/projects/<escaped-cwd>/<session_id>.jsonl` (confirmed: 19 lines for this probe).

## 3. Stopped cleanly at a generated question — confirmed (synthetic, then real)

**Synthetic probe** (told explicitly "no AskUserQuestion, ask in prose"): asked to obtain one
fact from the human, the model's entire final output was:

```
What is your favorite fruit?
```

`stop_reason: end_turn`, `num_turns: 1` — one turn, no guess, no filler after the question.

**Real kickoff skill** (no special instruction — just `/plugin-hive:kickoff a tiny CLI
todo-list app called scratchtodo`, in a fresh `git init` scratch repo, greenfield path): 4
internal turns, `$0.036`, `stop_reason: end_turn`, `is_error: false`. Final output (verbatim,
truncated):

```
This is a **greenfield kickoff** for scratchtodo. Let me guide you through the initialization
process.

## 1. Metrics Tracking

**Enable metrics tracking?**

Metrics tracking allows Hive to measure progress and support data-driven meta-optimization in
the future. When disabled, metrics remain off and future meta-work will use qualitative/
backlog-based modes instead.

- **Consequence of opting out:** Metrics stay off. Meta work will use qualitative/backlog mode,
  and future metric-driven optimization features won't be available.
- **Opting in** unlocks metric-driven behavior for future skills.

*Default: off — you must actively choose yes to enable.*

Would you like to enable metrics tracking? (yes/no)
```

This is the **exact same gating question**, with the exact same required consequence-line
wording, that this project's own human-driven `/plugin-hive:kickoff` session asked (see this
repo's own kickoff transcript / `hive.config.yaml`'s `metrics.enabled` origin) — confirming the
skill's actual protocol logic runs identically headless; only the question-delivery mechanism
differs (prose vs. tool call).

## 4. Resumed from disk, continued past the question — confirmed (synthetic, then real)

**Synthetic probe resume:** `claude -p --resume <session_id> "My answer: mango. Now confirm..."`
returned `session_id` unchanged (not forked — no `--fork-session` was passed) and:

```
I asked "What is your favorite fruit?" and you answered "mango."
```

**Real kickoff skill resume:** `claude -p --resume <session_id> "no, keep metrics off"` — same
`session_id` (`a296edd9-03cc-4da1-bb63-dff0f107de92`), 2 turns, `$0.031`, and it **advanced to
the next gate in the actual kickoff protocol**, not just a generic acknowledgement:

```
## 2. Project Classification

**What type of project is this?**

Choose one:
- `framework` — a library/plugin/tool consumed by other projects (no end-user UI)
- `consumer-app` — a product with a user-facing interface
- `service` — a backend service / API with no direct UI

For scratchtodo (a CLI todo-list), is this a `consumer-app` or `service`?
```

This is real protocol-state continuity — the resumed session knew metrics had just been
declined and moved on to Phase 3's `project_type` question, exactly matching
`kickoff-protocol.md`'s sequencing — not just conversational memory of "we talked about fruit."
Session transcript for the real run: 41 lines on disk after two calls, confirmed present at
`~/.claude/projects/<escaped-cwd>/<session_id>.jsonl`.

## 5. AD-5 confirmation — pause/resume is free, no special code path

Nothing in `claude -p --resume` required Minerva-side bookkeeping beyond the `session_id` — no
manual state snapshot/restore was written for this spike. The Claude Code CLI's own session
persistence (on by default; only disabled via `--no-session-persistence`) *is* the durability
mechanism. This directly confirms AD-5's claim: a held run resuming after an arbitrary gap is
not a special code path, it's the same mechanism as any other resume.

## 6. Go/no-go call

**GO.** All four PoC legs hold, confirmed against the real kickoff skill, not just a synthetic
proxy:
1. Headless invocation — ✅ `claude -p`.
2. Stopped at a generated question — ✅, though via prose-at-turn-end, not a structured
   `AskUserQuestion` payload (see Headline finding).
3. Persisted to disk — ✅, automatic, no Minerva-side code needed.
4. Resumed from disk, continued past the question — ✅, with genuine protocol-state
   continuity, confirmed against the real skill's actual next gate.

**Required follow-on for `contracts-and-spine`-equivalent planning (not a blocker, but must be
scoped as a story, not assumed free):** Minerva's Kickoff+Plan Engine / `getQuestions` needs a
**question-extraction step** that parses the final prose turn's question out of Markdown text,
since there is no structured `AskUserQuestion` tool-call payload to read headlessly. The
Escalation Classifier (AD-2) still operates fine on the *extracted* question text — this
doesn't invalidate AD-2 — but "read the question" is now a real parsing problem, not a given.
`claude -p --json-schema <schema>` (structured-output validation, confirmed available via
`claude --help` on this box) is a promising way to make extraction reliable — worth its own
story rather than hand-rolled prose parsing, but out of scope for this spike to prototype.

## Follow-on actions for `/hive:plan`

- Add a story for prose-question extraction (or `--json-schema`-based structured extraction) as
  a required Kickoff+Plan Engine sub-component — not assumed away by AD-1/AD-2.
- `docs/architecture.md`'s Components → Kickoff+Plan Engine / Escalation Classifier bullets
  should note they operate on *extracted* question text, not a tool-call payload, when the
  underlying engine is driven headlessly. (Follow-on doc edit, not required before planning —
  the spike's finding is captured here and referenced from AD-5.)
- No change needed to AD-1 (JSON-over-stdio Minerva-level ABI), AD-3 (two-case workspace), or
  AD-4 (cleanup ledger) — none of their assumptions were tested or contradicted by this spike.

## Spike test — real run output

```
$ npx tsx --test docs/spike-plugin-hive-drivability-spike.test.ts

✔ AskUserQuestion is NOT available to a headless (-p) session (10742.478541ms)
✔ a headless run asked to get one fact stops cleanly at a single prose question (7798.061542ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 18658.026125
```
