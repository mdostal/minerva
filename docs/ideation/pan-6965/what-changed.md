# What Changed Based on Your Answers

## Changes Made

- **Priority:** Bumped to SUPER HIGH — immediately following end-to-end workflow completion. Added explicit note: critical for fixing context usage and enabling continuity (agents currently "go full amnesiac").

- **Memory Injection Strategy:** Clarified Phase 1 approach is a **mix** of direct context injection + on-demand tool lookup + bubble-up to orchestrator layers. Agent has tools to request context, not just passive injection. Memory status (in-progress/reviewed/full-send) is AWARE when bubbling upstream.

- **CodeGraph Integration:** Added reference architecture (https://github.com/mdostal/swarm-memory + https://www.falkordb.com/blog/code-graph/). **Requires CBA/comparison document with options presented in Consus console for approval before Phase 2 implementation.** New risk added to track this.

- **Qdrant Reference Architecture:** Added explicit reference to prior ruvflow + Qdrant + hooks system (mdostal.com/blog/35-agent-ai-coding-swarm) as superior to Claude's large file-based memory.

- **Migration Strategy:** Phase 1 now **extends** Claude Code auto-memory (not replaces). Hive wrappers + SQLite on top. Phase 2 improves/replaces with Qdrant. Acknowledged Claude's system is inferior to prior architecture.

- **Sandman Agent:** Clarified Sandman is a **separate specialized agent** (not just a post-hook extension) for nightly cleanup. Mixed responsibility model: post-hook handles immediate writes, Sandman handles long-term curation.

- **Role-Scoped Memory (Phase 4):** Clarified distinction — orchestrator sees all repo metadata + skills + orchestration toggles; architect sees full repo graph + metadata (not individual docs); dev sees only necessary subset + impacted API contracts (knows other codebases call their APIs, but not what those codebases are/do).

- **Auto-Save Triggers:** Added interval-based auto-save (not just on agent stop/completion). Short-term/long-term split: short-term visible as high-level summaries to other agents; long-term only promoted when PR fully approved.

## Open Questions

**You mentioned a LONG answer was submitted multiple times but went missing.** I don't have access to that content. If it's still relevant, please paste it or point me to where it's stored (memory file, discussion thread, etc.) so I can fold it in.

All other answers have been incorporated into the PRD, wireframe (added role filter + status tags), and flow diagram (added on-demand lookup, bubble-up, PR-approval promotion).
