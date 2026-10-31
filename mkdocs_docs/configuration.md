# Configuration

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MINERVA_DRIVER` | Driver selection: `spawn`, `subagent`, or `forked` | `spawn` |
| `MINERVA_DRIVE_MODEL` | Model used to drive a planning turn | `claude-haiku-4-5-20251001` |
| `MINERVA_TURN_TIMEOUT_MS` | Per-turn ceiling in milliseconds | `600000` (10 min) |
| `MINERVA_HOME` | Run-state root directory | `~/.minerva` |
| `PANTHEON_API_URL` | Pantheon core-api base URL, used for route selection (`/api/route/select`) and backlog reads/writes (`/api/backlog/issues`). The Pantheon runtime exports it. | unset |
| `PANTHEON_CORE_API_URL` | Overrides `PANTHEON_API_URL` | unset |
| `MINERVA_PANTHEON_CORE_API_URL` | Minerva-only override; wins over both of the above | unset |
| `MINERVA_PANTHEON_ROUTE_SELECT_URL` | Exact route-select URL; bypasses the core-api base URL for route selection only | unset |
| `MINERVA_PLAN_DEFAULTS` | Path to a plan-defaults YAML/JSON config file | unset |
| `MINERVA_PLAN_DEFAULTS_MODE` | Quick mode switch: `off`, `agent`, or `auto` | `off` |
| `MINERVA_HIVE_PLUGIN_DIR` | Path to a local `plugin-hive-fork` checkout — required for `MINERVA_DRIVER=forked` until plugin-hive#341 merges | unset |
| `MINERVA_ALLOWED_TARGET_REPOS` | Comma-separated list of allowed `target_repo` values (slugs and/or absolute paths). Unset = no restriction. | unset |
| `MINERVA_GIT_CLONE_PROTOCOL` | How a bare `owner/repo` `target_repo` slug is cloned: `https` (`https://github.com/<slug>.git`) or `ssh` (`git@github.com:<slug>.git`). Explicit URLs are always used as given. | `https` |
| `MINERVA_FALLBACK_CLI` | Fallback CLI command if Heimdall routing fails | unset |
| `MINERVA_FALLBACK_MODEL` | Fallback model if Heimdall routing fails (requires `MINERVA_FALLBACK_CLI`) | unset |

### Driver selection

```bash
# Default: spawn each turn as a claude -p / --resume subprocess
MINERVA_DRIVER=spawn

# Orphan-resistant: dispatch via claude --bg, poll until complete
MINERVA_DRIVER=subagent

# Experimental: drive plugin-hive's headless-question protocol
# Requires MINERVA_HIVE_PLUGIN_DIR until plugin-hive#341 merges
MINERVA_DRIVER=forked
MINERVA_HIVE_PLUGIN_DIR=/path/to/plugin-hive-fork
```

### Heimdall routing fallback

If Heimdall routing is unavailable, set a fallback pair:

```bash
MINERVA_FALLBACK_CLI=claude
MINERVA_FALLBACK_MODEL=claude-haiku-4-5-20251001
```

Both must be set or neither — partial config fails loudly.

---

## Pre-baked plan defaults

By default (`MINERVA_PLAN_DEFAULTS_MODE=off`), every question parks and waits for an explicit
`submitAnswers` call. Pre-baked defaults let a run auto-answer predictable questions so it can
drive itself to completion unattended.

### Modes

| Mode | Behavior |
|------|---------|
| `off` | All questions park — classic behavior (default) |
| `agent` | Auto-answer `agent`-channel questions; still park `human`-channel questions |
| `auto` | Auto-answer every question a default resolves; only truly unresolvable questions park |

Quick switch via environment:
```bash
MINERVA_PLAN_DEFAULTS_MODE=agent   # recommended headless posture
MINERVA_PLAN_DEFAULTS_MODE=auto    # fully unattended
```

### Config file

For richer control, point `MINERVA_PLAN_DEFAULTS` at a YAML or JSON file:

```bash
MINERVA_PLAN_DEFAULTS=/path/to/plan-defaults.yaml
```

Example config (`docs/plan-defaults.example.yaml` in the repo):

```yaml
# off / agent / auto
mode: agent

# Answer sign-off / "ready to proceed?" gates affirmatively
skip_sign_off: true

# Answer tech-stack questions with this string
tech_stack: TypeScript / Node.js

# How to pick from a select option list: "recommended", "first", or "park" (never pick)
select_strategy: recommended

# Default for free-text questions. {idea} is interpolated with the run's idea brief.
free_text_default: >-
  Use your best judgment consistent with the idea brief and proceed with sensible,
  conventional defaults.

# Hard ceiling on auto-answers per drive sequence (loop guardrail)
max_auto_answers: 40

# Operator-pre-decided answers: matched by qid (exact) or question text (case-insensitive
# substring, or a list of substrings); first match wins, overrides all generic rules above.
answers:
  - match: ["metrics", "telemetry"]
    answer: "Yes, enable metrics."
  - match: "database"
    answer: "Postgres"

# Optional suffix appended to the initial kickoff drive prompt
drive_prompt_suffix: null
```

### Per-run override

Pass a `defaults` object directly to `startRun` to override for a single run:

```bash
echo '{"method":"startRun","params":{
  "idea":"scaffold a new TypeScript library",
  "defaults":{"mode":"auto","tech_stack":"TypeScript / Node.js"}
}}' | npx tsx bin/minerva.ts
```

Precedence, highest first: inline per-run `defaults` fields, then the per-run `defaults.file`,
then `MINERVA_PLAN_DEFAULTS_MODE`, then the `MINERVA_PLAN_DEFAULTS` file, then the built-in
defaults. `answers` accumulate across layers, with the higher layer's rules checked first.

### Operator defaults file

An operator defaults file records answers the operator has already given (git flow,
verification policy, CI, cross-god boundaries). A planning run that gets this file answers those
questions itself, and still parks on every question the file does not cover. The repo ships one at
`config/operator-defaults.yaml`.

Hand it to a run in any of three ways:

```bash
# Headless plan entry
npx tsx bin/minerva-plan.ts --idea "..." --defaults-file config/operator-defaults.yaml

# startRun ABI: a per-run file, plus optional inline overrides on top
echo '{"method":"startRun","params":{
  "idea":"scaffold a new TypeScript library",
  "defaults":{"file":"config/operator-defaults.yaml"}
}}' | npx tsx bin/minerva.ts

# Per deployment
MINERVA_PLAN_DEFAULTS=/abs/path/to/operator-defaults.yaml
```

A relative `file` path resolves against the Minerva process's working directory. A per-run file
that is missing or invalid fails the `startRun` call with `VALIDATION_FAILED`, because it was
asked for explicitly. The `MINERVA_PLAN_DEFAULTS` file is the exception: if it is broken, Minerva
logs a warning and ignores it. If `--defaults-file` is given without `--mode`, `minerva-plan`
uses the file's `mode` and doesn't force `auto`.

**Format.** It's the same plan-defaults schema as above, in YAML or JSON. Every field is optional. To get
"answer what's known, park the rest", the file switches off every generic fallback so that only
its `answers` rules can fire:

| Field | Value | Why |
|-------|-------|-----|
| `mode` | `auto` | Explicit answers apply to `human`-channel questions too (`agent` mode ignores them there) |
| `skip_sign_off` | `false` | Sign-off gates aren't rubber-stamped |
| `select_strategy` | `park` | No option is picked on the operator's behalf |
| `free_text_default` | `null` | No generic free-text answer |
| `tech_stack` | `null` | Decided per idea |

Each `answers` rule has:

- `qid` (string, optional): exact match on the question envelope's `qid`.
- `match` (string or non-empty list of strings, optional): case-insensitive substrings of the
  question text. Any one of them matching counts as a match.
- `answer` (string or list of strings, required): the text sent back through the same path as
  `submitAnswers`.

A rule needs `qid`, `match`, or both. The first matching rule wins. Keep `match` phrases
specific, because they're plain substrings: `"ci"` would also match "de**ci**sion", so the shipped
file uses phrases like `"ci pipeline"` and `"continuous integration"`.

```yaml
mode: auto
skip_sign_off: false
select_strategy: park
free_text_default: null
answers:
  - match: ["git flow", "base branch", "rebase", "pull request"]
    answer: >-
      Branch off `dev`; `main` is release-only. Merge `origin/dev` to update, never rebase.
      Open the PR against `dev`.
  - match: ["ci pipeline", "continuous integration", "wait for ci"]
    answer: CI is never a gate. Local tests plus the live check are the evidence.
```

Every auto-answer counts toward the run's `metrics.auto_resolutions`. Questions that no rule
answers park as `waiting_on_human` and show up in `getQuestions` like any other gate.

---

## `hive.config.yaml`

The repo root `hive.config.yaml` configures plugin-hive's own settings (used when Minerva drives
kickoff+plan):

```yaml
metrics:
  enabled: true          # Emit per-run planning metrics

git_flow:
  default_pr_base: dev   # Minerva cuts worktrees off dev, not main
  branch_strategy: per-epic

execution:
  default_methodology: tdd   # TDD discipline across all planning runs
```

---

## Security: `MINERVA_ALLOWED_TARGET_REPOS`

In environments where `startRun`'s `target_repo` could come from untrusted input (e.g. a
Multica ticket description), restrict which repos Minerva may target:

```bash
# Allow only specific repos (comma-separated slugs or absolute paths)
MINERVA_ALLOWED_TARGET_REPOS=mdostal/billing-app,/home/ci/repos/api

# Unset (default) = no restriction
```

This prevents git-clone-injection attacks where a crafted `target_repo` value reaches `git`
with `ext::` or similar transport-helper injections. See `src/target-repo-signal.ts` for the
implementation.
