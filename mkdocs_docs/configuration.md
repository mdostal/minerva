# Configuration

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MINERVA_DRIVER` | Driver selection: `spawn`, `subagent`, or `forked` | `spawn` |
| `MINERVA_DRIVE_MODEL` | Model used to drive a planning turn | `claude-haiku-4-5-20251001` |
| `MINERVA_TURN_TIMEOUT_MS` | Per-turn ceiling in milliseconds | `600000` (10 min) |
| `MINERVA_HOME` | Run-state root directory | `~/.minerva` |
| `MINERVA_PLAN_DEFAULTS` | Path to a plan-defaults YAML/JSON config file | unset |
| `MINERVA_PLAN_DEFAULTS_MODE` | Quick mode switch: `off`, `agent`, or `auto` | `off` |
| `MINERVA_HIVE_PLUGIN_DIR` | Path to a local `plugin-hive-fork` checkout — required for `MINERVA_DRIVER=forked` until plugin-hive#341 merges | unset |
| `MINERVA_ALLOWED_TARGET_REPOS` | Comma-separated list of allowed `target_repo` values (slugs and/or absolute paths). Unset = no restriction. | unset |
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

# How to pick from a select option list: "recommended" or "first"
select_strategy: recommended

# Default for free-text questions. {idea} is interpolated with the run's idea brief.
free_text_default: >-
  Use your best judgment consistent with the idea brief and proceed with sensible,
  conventional defaults.

# Hard ceiling on auto-answers per drive sequence (loop guardrail)
max_auto_answers: 40

# Operator-pre-decided answers: matched by qid (exact) or question text (case-insensitive
# substring); first match wins, overrides all generic rules above.
answers:
  - match: "metrics"
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

Per-run overrides win over the file config, which wins over environment variables, which win
over built-in defaults.

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
