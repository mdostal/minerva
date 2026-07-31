# Design Discussion: Fully Active Memory System

## Problem Statement

The current Pantheon/Minerva system lacks the persistent, multi-layered memory infrastructure that previous dostal orchestrators relied on. Without "fully active" memory—memory that is consistently loaded, consulted, and updated throughout agent lifecycles—the system loses context between sessions, produces inconsistent behavior, and requires repeated re-discovery of project state, user preferences, and architectural decisions.

The brief references historical systems that used:
- `ruvflow` for Claude flow orchestration
- Hooks triggering before/after agent invocations
- Automatic memory lookups and stores to ensure continuity
- Brand/persona-specific memory routing (e.g., Firefly Events vs dostal tech)

While this approach added latency, it provided crucial continuity, especially for fresh sessions or multi-day work.

## Interpretations of "Fully Active"

### Interpretation A: Always-Loaded Memory Cache
Memory records are eagerly loaded into every agent context at startup, creating a warm cache. Agents always "see" relevant memories without explicit lookup.

**Pros:** Zero lookup latency during execution; consistent worldview  
**Cons:** Higher token usage per request; potential for memory bloat; need smart filtering  
**Scope:** Modify agent bootstrap to auto-load memory index + relevant records

### Interpretation B: Hook-Driven Memory Lifecycle
Before/after hooks automatically trigger memory reads (on agent start) and writes (on agent stop, task completion, or explicit save points). Memory becomes a managed lifecycle concern, not a manual tool.

**Pros:** Enforced discipline; works with existing Claude Code hooks; compatible with current file-based memory  
**Cons:** Adds latency to every agent spawn; requires hook configuration; could mask performance issues  
**Scope:** Implement hooks in `.claude/settings.json` + memory plugin logic

### Interpretation C: Multi-Layer Memory with Smart Routing
Build a tiered memory system (session → project → user → global) with brand/persona metadata that routes queries to the right layer. Each layer has its own UI, indexing strategy, and lifecycle.

**Pros:** Scalable; supports multi-brand/multi-persona use cases; clear separation of concerns  
**Cons:** High complexity; need to define layer semantics; routing logic is non-trivial  
**Scope:** New memory plugin architecture + directory structure + routing engine

### Interpretation D: Code Graph + Memory Fusion
Extend memory beyond text records to include code graphs (dependency maps, call graphs, architecture diagrams) that persist as queryable artifacts. Memory becomes multimodal.

**Pros:** Richer context; supports architectural queries; aligns with "code graphs" mention  
**Cons:** Unclear integration with text memory; graph storage/query is a major lift; potential duplication with IDE tools  
**Scope:** New graph storage layer + query interface + UI for graph exploration

## Recommended Direction

**Hybrid of B + C:** Implement hook-driven memory lifecycle (Interpretation B) on top of a multi-layer memory structure (Interpretation C), starting with three layers: session (ephemeral), project (in `.pHive/memory/`), and user (in `~/.claude/memory/`). Defer code graphs (Interpretation D) to a later phase; focus first on ensuring text-based memory is reliably loaded and saved.

**Phase 1 (this epic):**
1. Define memory layer schema (session/project/user) with brand/persona metadata
2. Implement before-hook: load memory index + filter by brand/persona/scope
3. Implement after-hook: auto-save new memories to appropriate layer
4. Build simple web UI for browsing each layer (directory listing + markdown viewer)
5. Migrate existing auto-memory to new structure

**Phase 2 (future):**
- Code graph integration
- Advanced querying (semantic search, cross-layer joins)
- Memory analytics/insights dashboard

## Scope Boundaries

**In Scope:**
- File-based memory storage (markdown + JSON index)
- Hook-based auto-load/auto-save
- Three-layer hierarchy (session/project/user)
- Brand/persona metadata for routing
- Basic web UI for memory inspection
- Migration path from current `.claude/projects/.../memory/` structure

**Out of Scope:**
- Database-backed memory storage
- Real-time memory sync across sessions
- AI-powered memory summarization/deduplication (manual for now)
- Code graph generation (separate epic)
- Memory versioning/history (use git for now)

## Open Questions (see questions.json)

Key ambiguities requiring human decision:
- What exactly does "before/after memory lookup" mean in the hook context?
- What are the specific layers? Is session/project/user the right model?
- How does brand/persona routing work? Is it tag-based, directory-based, or something else?
- What's the relationship between this and Claude Code's existing auto-memory?
- Should we build on the existing system or replace it?
- What does "code graphs" concretely mean here?
