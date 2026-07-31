# Open questions — PAN-6965

This design proposes a hook-driven, multi-layer memory system (session/project/user) with brand/persona routing to ensure Pantheon agents maintain context across sessions. The primary ambiguity centers on what 'fully active' concretely means (always-loaded vs hook-driven vs multi-modal code graphs), how layers are defined, and how brand/persona routing integrates with existing Claude Code auto-memory.

## Q1. What exactly does 'before/after memory lookup' mean in the context of hooks? Should the before-hook inject all memories into the agent's system prompt, or just make them available via a tool?

_Why it matters:_ Determines implementation approach (context injection vs tool-based retrieval) and impacts token usage per request. Affects whether we modify agent bootstrap or just provide a memory tool.

## Q2. Are session/project/user the right three layers, or should we model this differently (e.g., ephemeral/persistent, local/global, agent-scoped/project-scoped)?

_Why it matters:_ The layer model is foundational to the directory structure, hook logic, and UI. Getting this wrong means a painful refactor later. Need clarity on what each layer's lifecycle and scope should be.

## Q3. How does brand/persona routing actually work? Is it tag-based filtering (metadata.brand='firefly-events'), directory-based (separate /firefly/ and /dostal/ subdirs), or something else?

_Why it matters:_ Determines file organization, indexing strategy, and filtering logic. Tag-based is simpler to implement but harder to visualize; directory-based is easier to browse but more rigid.

## Q4. What's the relationship between this new system and Claude Code's existing auto-memory (the file-based memory at .claude/projects/.../memory/)? Should we extend it, replace it, or build in parallel?

_Why it matters:_ Clarifies migration path and whether we need to maintain backward compatibility. If replacing, we need a migration script. If extending, we need to understand current limitations.

## Q5. What does 'code graphs' concretely mean here? Is it dependency graphs, call graphs, architecture diagrams, or something else? Should this be in scope for Phase 1 or deferred?

_Why it matters:_ Code graphs are mentioned in the brief but are architecturally orthogonal to text-based memory. Need to know if this is a must-have for 'fully active' or a nice-to-have for later.

## Q6. Should memory auto-save happen on every agent stop, only on explicit task completion, or at other trigger points (e.g., after N minutes, when memory count exceeds threshold)?

_Why it matters:_ Affects how often we write to disk and whether we risk losing memory on crashes. Too aggressive saves could cause performance issues; too conservative risks data loss.

## Q7. Who owns memory curation and cleanup? Is it the agent's responsibility to delete stale memories, or should we build a separate cleanup tool/UI for humans to audit and prune?

_Why it matters:_ Memory bloat is a real risk. Without a clear ownership model, we'll accumulate stale/duplicate memories that pollute agent context and slow down loading.

## Q8. What's the priority order for this epic relative to other Pantheon infrastructure work (e.g., workflow orchestration, test swarm, ship automation)? Is this a blocker for those, or can they proceed in parallel?

_Why it matters:_ Determines whether we need to fast-track this or can take a more measured approach. If other epics depend on 'fully active' memory, this becomes critical path.
