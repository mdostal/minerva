# Minerva v0.2.1 Video Script

## Hook

Today we are shipping Minerva v0.2.1: kickoff-engine.ts's startRun() uses the resolved target_repo directly as a `git -C <path> worktree add` target, then a commit+push destination -- intentional, since Minerva is meant to plan against any local repo the operator names.

## Highlights

1. kickoff-engine.ts's startRun() uses the resolved target_repo directly as a `git -C <path> worktree add` target, then a commit+push destination -- intentional, since Minerva is meant to plan against any local repo the operator names. (harden-run-id-and-target-repo-boundaries/target-repo-allowlist)
2. run_id is validated only as `typeof === "string"` (or not at all) everywhere it enters the system, then joined directly into a filesystem path in src/run-manager.ts's runDir()/ runRecordPath() (join(runsRoot(), runId)). (harden-run-id-and-target-repo-boundaries/validate-run-id-uuid-shape)
3. src/agent-setup.ts mirrors Portunus's src/portunus/agent_setup.py structure closely, adapted to TypeScript/Node. (agent-interactivity/agent-init-status)
4. Icon direction decided by the operator via the parallel-blind-design-agents technique (memory: feedback_parallel-blind-design-agents.md) -- three independent candidates were designed, independently re-verified (not just trusted on self-report), published as a comparison Artifact, and the operator's synthesis was clear and immediate: Candidate A (the owl -- Minerva's own iconic animal, flat-geometric shield-shaped face on an indigo badge) is the pick, as-is, no further design iteration requested. (agent-interactivity/icon-pages-branding)

## Call To Action

Read the release details and try it from https://github.com/mdostal/minerva.

## Source Stories

- harden-run-id-and-target-repo-boundaries/target-repo-allowlist: Optional MINERVA_ALLOWED_TARGET_REPOS allowlist - .pHive/epics/harden-run-id-and-target-repo-boundaries/stories/target-repo-allowlist.yaml
- harden-run-id-and-target-repo-boundaries/validate-run-id-uuid-shape: Reject non-UUID run_id at the ABI boundary - .pHive/epics/harden-run-id-and-target-repo-boundaries/stories/validate-run-id-uuid-shape.yaml
- agent-interactivity/agent-init-status: minerva agent init / minerva agent status — harness detection + MCP registration - .pHive/epics/agent-interactivity/stories/agent-init-status.yaml
- agent-interactivity/icon-pages-branding: Icon + gh-pages landing site + branding - .pHive/epics/agent-interactivity/stories/icon-pages-branding.yaml
- agent-interactivity/install-sh-and-readme: install.sh + README one-command install + npm distribution-name fix - .pHive/epics/agent-interactivity/stories/install-sh-and-readme.yaml
- agent-interactivity/mcp-server: minerva mcp — MCP server exposing the existing 8-method ABI - .pHive/epics/agent-interactivity/stories/mcp-server.yaml
- agent-interactivity/usage-skills: Usage skill(s) teaching the correct Minerva interaction loop - .pHive/epics/agent-interactivity/stories/usage-skills.yaml
