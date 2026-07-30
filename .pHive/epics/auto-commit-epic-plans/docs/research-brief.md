# Research Brief: Auto-Commit Epic Plans

## Problem Statement

Minerva currently plans greenfield Consus seeds in a FRESH-INIT throwaway git repo (when `target_repo` is absent), so the planned `.pHive/epics/<id>/` artifacts never land in a real, committed repo. This blocks autonomous build execution because build agents expect committed epic plans on disk.

**Evidence:** The p1 epic (`agent-drivable-core`) only built because its plan was manually committed to `mdostal/auriga` with commit message "commit Minerva epic plan so build agents can execute."

## Root Cause Analysis

### Part 1: Target Repo Resolution Gap

**File:** `src/run-manager.ts:108-137` (`allocateRun`)

```typescript
export function allocateRun(idea: string, targetRepo: string | undefined): { run_id: string } {
  const runId = randomUUID();
  const workspacePath = join(runDir(runId), "workspace");
  let workspaceKind: WorkspaceKind;

  if (targetRepo) {
    allocateWorktreeWorkspace(targetRepo, runId, workspacePath);
    workspaceKind = "worktree";
  } else {
    allocateFreshInitWorkspace(runId, workspacePath);  // ← throwaway repo
    workspaceKind = "fresh_init";
  }
```

**Gap:** Consus seeds carry no `target_repo` field, so `allocateRun` falls through to `fresh_init` mode — a throwaway git repo under `~/.minerva/runs/<id>/workspace/` that is NEVER pushed anywhere.

**Current behavior:**
- God work (e.g., Minerva dogfood) → `target_repo` is explicit → worktree mode → plan lands in real repo ✓
- Greenfield seed (e.g., "build a Pomodoro timer") → no `target_repo` → fresh_init mode → plan lands in throwaway scratch repo ✗

### Part 2: Post-Plan Commit Gap

**File:** `src/output-emitter.ts:70-81` (`checkAndMarkComplete`)

```typescript
export function checkAndMarkComplete(runId: string): boolean {
  const record = readRunRecord(runId);
  if (record.status === "complete") return true;
  const found = findCompletedEpic(record.workspace_path);
  if (!found) return false;
  updateRunRecord(runId, { status: "complete", output: found });
  recordCleanup(runId, "complete");
  return true;
}
```

**Gap:** Minerva detects plan completion via filesystem scan (`.pHive/epics/<id>/epic.yaml` existence) but does NOT commit or push the generated plan. The plan remains as uncommitted files in the workspace, so downstream workers can't pull it.

**Current workaround:** Manual `git add .pHive/epics/<id>/ && git commit -m "..." && git push` after Minerva completes.

## Tech Stack Context

- **Language:** TypeScript
- **Runtime:** Node.js (ES modules)
- **Git automation:** `execFileSync("git", [...])` pattern (already used for worktree allocation)
- **State persistence:** JSON-serialized `RunRecord` at `~/.minerva/runs/<id>/run.yaml`

## Existing Patterns

### Git Worktree Allocation

**File:** `src/run-manager.ts:78-95`

```typescript
function allocateWorktreeWorkspace(targetRepo: string, runId: string, workspacePath: string): void {
  if (!existsSync(targetRepo)) {
    throw new MinervaError("VALIDATION_FAILED", `target_repo does not exist: ${targetRepo}`);
  }
  execFileSync(
    "git",
    ["-C", targetRepo, "worktree", "add", "-b", `run/${runId}`, workspacePath, "dev"],
    { stdio: "pipe" },
  );
}
```

**Pattern to reuse:** 
- `execFileSync("git", [...], { stdio: "pipe" })` for git automation
- Error handling with `MinervaError`
- Working directory parameter via `-C` flag

### Fresh Init Workspace

**File:** `src/run-manager.ts:97-104`

```typescript
function allocateFreshInitWorkspace(runId: string, workspacePath: string): void {
  mkdirSync(workspacePath, { recursive: true });
  execFileSync("git", ["init", "-q", workspacePath]);
  execFileSync(
    "git",
    ["-C", workspacePath, "commit", "-q", "--allow-empty", "-m", `minerva run ${runId} -- scratch workspace init`],
  );
}
```

**Pattern to reuse:** Git operations in fresh repos use `-C workspacePath` to set working directory.

## Constraints

1. **No state assumptions:** Every mutation must round-trip through disk (per `run-manager.ts:70-76` read-modify-write pattern)
2. **Error handling:** All git failures must throw `MinervaError` with descriptive messages
3. **Idempotency:** Re-running on an already-complete run must not double-commit or error
4. **Driver-agnostic:** Must work for both `SpawnDriver` (writes to `workspacePath`) and `SubagentDriver` (writes to `.claude/worktrees/`)

## Dependencies

- **Upstream:** `src/kickoff-engine.ts` drives the kickoff+plan flow
- **Detection:** `src/output-emitter.ts` detects completion
- **Workspace:** `src/run-manager.ts` allocates workspace and manages run state

## Open Questions

1. **Target repo resolution heuristic for greenfield seeds:** Should Minerva:
   - Create a new repo per seed (e.g., `mdostal/pomodoro-timer`)?
   - Use a designated "seed incubator" repo (e.g., `mdostal/consus-seeds`)?
   - Prompt the human operator during planning?
   
2. **Push vs commit-only:** Should the auto-commit step:
   - Only `git commit` locally (requires manual push)?
   - Also `git push` to remote (requires auth, may fail)?
   
3. **Branch naming:** For worktree mode, plans land on `run/<runId>` branches. Should fresh_init mode:
   - Follow the same pattern?
   - Use a different pattern (e.g., `seed/<epic-id>`)?

4. **Commit message convention:** What should the auto-commit message say?
   - Template: `"feat(<epic-id>): add Minerva-generated plan for <epic-title>"`?
   - Should it include story count, methodology, or other metadata?
