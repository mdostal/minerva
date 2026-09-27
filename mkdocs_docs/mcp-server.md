# MCP Server

Minerva exposes all 8 ABI methods as **MCP (Model Context Protocol) tools** via a built-in MCP
server. Any MCP-aware caller — Claude Code, Codex CLI — can call `startRun`, `submitAnswers`,
etc. as native tools rather than hand-rolling subprocess invocations.

The MCP server is a thin adapter over the same `dispatch()` call as the subprocess ABI. Identical
result/error contract; identical semantics. No new business logic.

## Quick start: one-command onboarding

```bash
# Install Minerva AND wire the MCP server into your agent CLIs in one step
curl -fsSL https://mdostal.github.io/minerva/install.sh | bash
```

This chains an install with `minerva agent init`, which:

- Detects installed harnesses (Claude Code, Codex CLI)
- Registers the MCP server with each detected harness
- Installs the `minerva-plan` usage skill to `~/.claude/skills/`

`--harness claude` or `--harness codex` narrows to just one harness.

## `minerva agent init`

Wire the MCP server into your installed agent CLIs:

```bash
minerva agent init
# Narrow to a single harness:
minerva agent init --harness claude
minerva agent init --harness codex
```

Idempotent and safe to re-run at any time (e.g. after installing a new harness).

## `minerva agent status`

Check what's currently wired without making changes:

```bash
minerva agent status
# Narrow to a single harness:
minerva agent status --harness claude
```

## `minerva mcp`

Start the MCP server directly (stdio transport):

```bash
npx tsx bin/minerva.ts mcp
# or, if installed globally:
minerva mcp
```

This is what `minerva agent init` registers with your harness. You can also run it manually
to test the MCP interface.

## Available MCP tools

Once wired, the following tools are available to your agent:

| Tool | ABI method |
|------|-----------|
| `minerva_capabilities` | `capabilities` |
| `minerva_start_run` | `startRun` |
| `minerva_get_run_status` | `getRunStatus` |
| `minerva_list_runs` | `listRuns` |
| `minerva_get_questions` | `getQuestions` |
| `minerva_submit_answers` | `submitAnswers` |
| `minerva_get_output` | `getOutput` |
| `minerva_abort_run` | `abortRun` |

Tool descriptions carry the no-autonomous-progress contract and agent/human channel semantics
so your calling agent understands the interaction pattern from the tool descriptions alone.

## The `minerva-plan` skill

`minerva agent init` installs a `minerva-plan` usage skill into `~/.claude/skills/`. This skill
tells Claude Code the full `startRun → poll → answer → repeat` interaction pattern — so the
agent gets the workflow right immediately, not just the raw tool list.

## How it runs (AD-1)

The MCP server is an **ephemeral stdio-piped child process per connection**, not a persistent
service. It respects the same "no daemon" invariant as the subprocess ABI. Nothing persists in
memory between tool calls; all run state lives on disk under `MINERVA_HOME`.

## See also

- [ABI Reference](abi-reference.md) — full parameter and response shapes
- [Quickstart](quickstart.md) — the same 8 methods as direct subprocess calls
