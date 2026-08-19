# Security Policy

Minerva runs local subprocesses (git, the configured driver CLI) and drives them with data that
can originate from an upstream ticket or an LLM-authored idea — treat any input path from a
caller-supplied `target_repo`, run ID, or idea text as untrusted.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via [GitHub's private vulnerability reporting](https://github.com/mdostal/minerva/security/advisories/new)
rather than a public issue. Include the affected file/function, a reproduction if you have one,
and the impact you'd expect. Expect an initial response within a few days.

## Scope

In scope: the `dispatch()` ABI (`src/dispatch.ts`), the MCP server (`src/mcp-server.ts`), the
run/worktree lifecycle (`src/run-manager.ts`, `src/target-repo-signal.ts`), and anything reachable
from caller-supplied input (stdin-JSON, MCP tool calls, CLI flags). Out of scope: the driver CLIs
Minerva shells out to (`claude`, `codex`, etc.) — report those upstream.
