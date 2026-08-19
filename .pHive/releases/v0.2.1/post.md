# Minerva v0.2.1

Minerva v0.2.1 ships 7 story-derived improvements.

## Highlights

- kickoff-engine.ts's startRun() uses the resolved target_repo directly as a `git -C <path> worktree add` target, then a commit+push destination -- intentional, since Minerva is meant to plan against any local repo the operator names. (harden-run-id-and-target-repo-boundaries/target-repo-allowlist)
- run_id is validated only as `typeof === "string"` (or not at all) everywhere it enters the system, then joined directly into a filesystem path in src/run-manager.ts's runDir()/ runRecordPath() (join(runsRoot(), runId)). (harden-run-id-and-target-repo-boundaries/validate-run-id-uuid-shape)
- src/agent-setup.ts mirrors Portunus's src/portunus/agent_setup.py structure closely, adapted to TypeScript/Node. (agent-interactivity/agent-init-status)
- Icon direction decided by the operator via the parallel-blind-design-agents technique (memory: feedback_parallel-blind-design-agents.md) -- three independent candidates were designed, independently re-verified (not just trusted on self-report), published as a comparison Artifact, and the operator's synthesis was clear and immediate: Candidate A (the owl -- Minerva's own iconic animal, flat-geometric shield-shaped face on an indigo badge) is the pick, as-is, no further design iteration requested. (agent-interactivity/icon-pages-branding)
- npm's existing "minerva" is an unrelated, unmaintained data-visualization package (infovizconsulting.com) -- same shape of collision the sibling Pantheon project Portunus hit on PyPI, same fix: package.json's distribution name changed to `pantheon-minerva` (confirmed unclaimed via `npm view`); the installed command stays plain `minerva` via the existing `bin` field, independent of the package name. (agent-interactivity/install-sh-and-readme)
- src/mcp-server.ts wraps dispatch.ts (Minerva's single existing entrypoint) as 8 MCP tools via @modelcontextprotocol/sdk's low-level Server + StdioServerTransport. (agent-interactivity/mcp-server)
- src/agent-skills/minerva-plan/SKILL.md -- one skill (not four like Portunus's ask/drop/ vault-setup/vault-audit, since Minerva has one cohesive workflow, not several distinct ones) teaching an agent the correct startRun -> poll both channels -> submitAnswers -> repeat -> getOutput loop, the AD-5 no-autonomous-progress contract (never fabricate an answer on the human channel), and agent/human channel semantics. (agent-interactivity/usage-skills)

## Shipped Stories

- harden-run-id-and-target-repo-boundaries/target-repo-allowlist: Optional MINERVA_ALLOWED_TARGET_REPOS allowlist - .pHive/epics/harden-run-id-and-target-repo-boundaries/stories/target-repo-allowlist.yaml
- harden-run-id-and-target-repo-boundaries/validate-run-id-uuid-shape: Reject non-UUID run_id at the ABI boundary - .pHive/epics/harden-run-id-and-target-repo-boundaries/stories/validate-run-id-uuid-shape.yaml
- agent-interactivity/agent-init-status: minerva agent init / minerva agent status — harness detection + MCP registration - .pHive/epics/agent-interactivity/stories/agent-init-status.yaml
- agent-interactivity/icon-pages-branding: Icon + gh-pages landing site + branding - .pHive/epics/agent-interactivity/stories/icon-pages-branding.yaml
- agent-interactivity/install-sh-and-readme: install.sh + README one-command install + npm distribution-name fix - .pHive/epics/agent-interactivity/stories/install-sh-and-readme.yaml
- agent-interactivity/mcp-server: minerva mcp — MCP server exposing the existing 8-method ABI - .pHive/epics/agent-interactivity/stories/mcp-server.yaml
- agent-interactivity/usage-skills: Usage skill(s) teaching the correct Minerva interaction loop - .pHive/epics/agent-interactivity/stories/usage-skills.yaml

## Links

- Repository: https://github.com/mdostal/minerva

_Generated for Minerva release v0.2.1 on 2026-08-19T23:50:44.204Z._
