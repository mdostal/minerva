# What is Minerva?

<img src="../assets/icon.svg" width="80" height="80" align="right" alt="Minerva">

> Turns an idea into a spec and a plan, headless. Free & open source.

**A headless engine for interactive tools.** Minerva drives an interactive tool one turn at a
time in an isolated git workspace. When the tool needs an answer, Minerva parks the run on disk and
exits. When the answer arrives, from a person or an agent, minutes or days later, it resumes the run
from disk. The result is an epic with dependency-tracked stories.

The tool is **semi-agnostic**. Out of the box Minerva drives [plugin-hive](https://firefly-events.github.io/plugin-hive/)'s
`kickoff` + `plan`: that is the batteries-included **default**, not a requirement. Any tool that fits
a small descriptor and turn contract can take its place, including a plain shell program. That
contract still assumes a run ends in a plan and parks only on questions. See
[Integrations](integrations.md) for the contract, a worked non-plugin-hive example, and what Minerva
deliberately does not do.

Minerva is named for the Roman goddess of wisdom and strategic planning. Inside the Pantheon it is
the planner: questions go to the decision surface, and the approved epic is handed to **Auriga**
(routing) and **Vulcan** (provisioning). None of them is needed to run it.

## Get your agent using it in one command

```bash
curl -fsSL https://mdostal.github.io/minerva/install.sh | bash
```

This installs the CLI, wires the MCP server into whatever AI coding agent CLIs are already on the
machine (Claude Code, Codex CLI today), and drops in the `minerva-plan` usage skill — so an agent
gets the full `startRun → poll → answer → repeat` interaction pattern immediately, not just a raw
tool list.

Already have Minerva installed? Just run `minerva agent init` — same thing, idempotent, safe to
re-run any time (e.g. after installing a new harness). `minerva agent status` shows what's
currently wired without changing anything.

No MCP-aware caller? Skip straight to the [Quickstart](quickstart.md); the identical 8 methods
are also a plain JSON-over-stdio subprocess ABI.

## How it works

Minerva's **public interface is a subprocess ABI**: a JSON-over-stdio, `{method, params}` →
`{result}` / `{error}` envelope. Every call is a fresh process; run state persists on the
filesystem under `~/.minerva/runs`.

There is **no daemon** — nothing advances a run on its own. A run only moves when a caller
invokes [`submitAnswers`](abi-reference.md#submitanswers).

```mermaid
flowchart TB
    idea["idea"] --> auriga

    subgraph pantheon["Pantheon"]
        auriga["Auriga\n(routing / hand-off)"]
        minerva["Minerva\n(planner)"]
        surface["Delphi / Consus\n(human decision surface)"]
        vulcan["Vulcan\n(repo provisioning)"]
        swarm["execution swarm\n(execute → review → test → ship)"]
    end

    auriga --> minerva
    minerva -->|questions| surface
    surface -->|answers| minerva
    minerva -->|approved epic + stories| vulcan
    minerva -->|hand to swarm| auriga --> swarm
```

## Where Minerva fits

| Component | Role |
|-----------|------|
| **Auriga** | Routes ideas, hands off to Minerva; dispatches to the execution swarm |
| **Minerva** | Runs the kickoff+plan loop, surfaces questions, emits approved specs |
| **Delphi / Consus** | Human decision surface — receives questions, sends answers |
| **Vulcan** | Provisions repos from the approved spec |

## Quick links

- [Quickstart](quickstart.md) — get running in 5 minutes
- [ABI Reference](abi-reference.md) — all 8 methods documented
- [MCP Server](mcp-server.md) — drive Minerva from Claude Code or Codex CLI
- [Architecture](architecture.md) — internals and design decisions
- [Configuration](configuration.md) — env vars and plan defaults
- [Vision & Roadmap](vision.md) — where Minerva is going
