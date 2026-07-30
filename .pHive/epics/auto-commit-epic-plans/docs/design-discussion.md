# Design Discussion: Auto-Commit Epic Plans

## Goal

Enable autonomous build execution by ensuring every Minerva-planned epic lands in a committed, pushable git repo — eliminating the manual commit step that currently blocks the build-half of the autonomous swarm.

## Scope

**In scope:**
1. Target repo resolution for greenfield seeds (when `target_repo` is absent)
2. Auto-commit of `.pHive/epics/<id>/` after planning completes
3. Auto-push to remote (when repo has a configured remote)

**Out of scope:**
- Modifying plugin-hive's planning output format
- Changing Minerva's workspace allocation strategy (worktree vs fresh_init)
- Retroactive migration of already-planned epics

## Proposed Approach

### Part 1: Target Repo Resolution

**Decision:** Use a **designated seed repo** pattern.

**Rationale:**
- Creating a new repo per seed requires GitHub API integration + OAuth (future work)
- Prompting during planning breaks the autonomous flow (Minerva's north star is async, multi-instance)
- A designated repo keeps all greenfield experiments in one place for triage

**Implementation:**
1. Add `MINERVA_SEED_REPO` environment variable (defaults to `mdostal/consus-seeds`)
2. Modify `allocateRun` to use the seed repo when `target_repo` is absent:
   ```typescript
   const seedRepo = process.env.MINERVA_SEED_REPO ?? join(homedir(), "repos/consus-seeds");
   const resolvedRepo = targetRepo ?? seedRepo;
   ```
3. Create the seed repo if it doesn't exist (one-time setup)

**Alternative considered:** Prompt during planning. **Rejected:** breaks async execution.

### Part 2: Auto-Commit After Planning

**Decision:** Add a `commitPlan` function called from `checkAndMarkComplete`.

**Rationale:**
- `checkAndMarkComplete` is the single choke point where Minerva detects planning completion
- Driver-agnostic (works for both SpawnDriver and SubagentDriver output locations)
- Idempotent (can check if `.pHive/epics/<id>/` is already committed)

**Implementation:**
1. After `findCompletedEpic` succeeds, check if epic dir is uncommitted:
   ```typescript
   const epicDir = join(workspacePath, ".pHive/epics", found.epic_id);
   const status = execFileSync("git", ["-C", workspacePath, "status", "--porcelain", epicDir], { encoding: "utf8" });
   if (status.trim().length > 0) {
     // Epic dir has uncommitted changes → commit it
   }
   ```

2. Stage and commit the epic directory:
   ```typescript
   execFileSync("git", ["-C", workspacePath, "add", epicDir]);
   execFileSync("git", ["-C", workspacePath, "commit", "-m", buildCommitMessage(found)]);
   ```

3. Commit message template:
   ```
   feat(<epic-id>): add Minerva-generated plan

   Generated {story-count} stories for {epic-title}.
   Methodology: {methodology}
   ```

**Alternative considered:** Separate `/commit-plan` endpoint. **Rejected:** adds operator friction.

### Part 3: Auto-Push to Remote

**Decision:** Push if remote exists; skip (with warning) if no remote.

**Rationale:**
- Worktree mode always has a remote (parent repo)
- Fresh_init seed repos should be configured with a remote during setup
- Push failures (auth, network) should not block run completion

**Implementation:**
1. Check for remote:
   ```typescript
   try {
     execFileSync("git", ["-C", workspacePath, "remote", "get-url", "origin"], { stdio: "pipe" });
     // Remote exists → push
   } catch {
     // No remote → skip push, log warning
   }
   ```

2. Push with error handling:
   ```typescript
   try {
     execFileSync("git", ["-C", workspacePath, "push", "origin", `run/${runId}`]);
   } catch (e) {
     // Log push failure but don't throw — run is still complete
     console.warn(`Failed to push run/${runId}: ${e}`);
   }
   ```

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Push auth failures block completion | **High** | Make push non-blocking; log failures but mark run complete |
| Seed repo doesn't exist on first run | **Medium** | Auto-create on first use OR fail-fast with setup instructions |
| Multiple concurrent runs push to same branch | **Low** | Each run uses `run/<runId>` branch (already unique) |
| Commit of planning artifacts bloats repo | **Low** | `.pHive/epics/` is already gitignored by default; plan adds allowlist |
| SubagentDriver writes to nested worktree | **Medium** | Use `findCompletedEpic` result (already driver-agnostic) |

## Dependencies

**Code:**
- `src/run-manager.ts` — modify `allocateRun` for seed repo resolution
- `src/output-emitter.ts` — add `commitPlan` call in `checkAndMarkComplete`

**External:**
- `MINERVA_SEED_REPO` env var (defaults to `mdostal/consus-seeds`)
- Seed repo must be cloned locally and have a remote configured

**Downstream impact:**
- Auriga (orchestrator) — can now pull plans without manual intervention ✓
- Vulcan (builder) — can read committed epic.yaml from seed repo ✓

## Open Questions

1. **Should seed repo be auto-created?**
   - **Option A:** Fail-fast with "run `git clone <seed-repo>` first" message
   - **Option B:** Auto-create via `git init` + `git remote add` (requires GH token)
   - **Recommendation:** Option A (simpler, one-time setup)

2. **Should `.gitignore` be updated automatically?**
   - Currently `.pHive/epics/*` is blanket-ignored; plan adds per-epic allowlist
   - **Recommendation:** Yes, update `.gitignore` in `commitPlan` to allowlist the epic dir

3. **Should push use `--force`?**
   - **Recommendation:** No — if `run/<runId>` already exists remotely, something is wrong

## Scale Assessment

**Recommendation:** **Small**

**Rationale:**
- 2 files modified (`run-manager.ts`, `output-emitter.ts`)
- 1 new function (`commitPlan`)
- 1 new env var (`MINERVA_SEED_REPO`)
- No new dependencies
- Builds on existing `execFileSync` git automation pattern
- ~150-200 lines of new code

**Estimated time:** 5-15 minutes per story (3 stories total).
