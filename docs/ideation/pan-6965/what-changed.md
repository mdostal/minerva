# What Changed Based on Your Answers

## Updates Made

- **Multi-phase strategy:** Restructured as a **phased, multi-backend approach**. Phase 1 MVP = pre/post hooks wrapping Hive's existing file-based memory (extends Claude Code auto-memory + SQLite). Phase 2+ adds Qdrant, CodeGraph, and document-section indexing. Phases 3-5 add short-term/long-term split, role-scoped memory, and Sandman cleanup.

- **Memory injection strategy:** Changed to a **hybrid mix**: some memories injected directly into context, some available via tool lookup, with bubble-up to orchestrator layers when agents need more context mid-task. Agent has tools to request context, not just passive injection.

- **Document-section granularity (Phase 2):** Move from full-file loading (acknowledged as inefficient — "Claude's shit ass memory just feeds full files") to **line-range-scoped sections** (e.g., "lines 100-120 of CLAUDE.md"). Pre-hook injects only relevant sections; agent can request more via tool.

- **Short-term vs. long-term memory (Phase 3):** Added temporal memory separation. Short-term = in-progress work (visible as high-level summaries to other agents). Long-term = only promoted when PR is fully approved. Post-PR approval hook triggers promotion.

- **Role-scoped memory layers (Phase 4):** Orchestrator always loads all repo metadata + skills + orchestration options. Architect loads full repo graph + metadata (no individual docs). Dev loads only necessary repo subset + impacted API contracts from graph (not full external codebases).

- **CodeGraph integration (Phase 2):** Added requirement for **deep CBA and comparison** of CodeGraph systems (swarm-memory reference at https://github.com/mdostal/swarm-memory, FalkorDB at https://www.falkordb.com/blog/code-graph/, others) with detailed breakdown in Consus console for approval before implementation. Tree-sitter AST, call graphs, dependency graphs.

- **Qdrant reference architecture:** Added explicit reference to prior ruvflow + Qdrant + hooks system (https://mdostal.com/blog/35-agent-ai-coding-swarm) as superior baseline to Claude Code's large file-based memory.

- **Sandman cleanup agent (Phase 5):** Named specialized agent to run **nightly memory curation** — identifies duplicate/stale/low-value memories and archives/deletes them. Post-hook handles immediate writes; Sandman handles long-term cleanup.

- **Priority escalation:** Marked as **SUPER HIGH** priority — must follow end-to-end workflow completion to immediately fix context usage and enable agent continuity. Agents currently "go full amnesiac" between sessions, blocking effective work continuation.

## Open Questions

**Q: Do you have the LONG answer you mentioned about "mix of all of these" for the overall direction?**  
You mentioned it was submitted multiple times but went missing. If you still have that answer and there's additional nuance beyond what I've incorporated (5-phase strategy, hybrid injection, role-scoped memory, temporal split, CodeGraph CBA, Qdrant reference, Sandman cleanup), please share it so I can fold in the missing details.
