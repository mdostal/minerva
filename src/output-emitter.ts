// Output Emitter (REQ-04) — detects when plugin-hive's own kickoff+plan skill has written its
// epic+stories artifact into the run's workspace, and serves it via getOutput.
//
// Design note: Minerva does NOT construct a separate epic+stories representation. plugin-hive's
// /plan skill already writes `.pHive/epics/{epic-id}/epic.yaml` + `stories/*.yaml` directly into
// the workspace as part of its own normal operation (confirmed empirically -- a headless driven
// session with --permission-mode bypassPermissions genuinely uses its Write tool against the
// real filesystem). So "the run reaches its final gate" is detected as a filesystem fact --
// an epic.yaml appearing under the workspace's .pHive/epics/ -- not a self-reported "I'm done"
// signal from the model, which would be one more thing that could be unreliable or unparseable.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { MinervaError } from "./errors.ts";
import { readRunRecord, updateRunRecord } from "./run-manager.ts";
import { recordCleanup } from "./cleanup-ledger.ts";

export interface CompletedEpic {
  epic_id: string;
  epic_yaml: string;
  stories: Array<{ id: string; content: string }>;
}

// Bug fix (2026-07-26, real regression -- see findCompletedEpic's own doc comment below for
// the full story): `baselineIds` is the set of epic ids that already existed in the workspace
// at allocation time (run-manager.ts's `baseline_epic_ids`, snapshotted from the target repo's
// base branch before any turn runs). Any epic id in that set is a pre-existing, already-shipped
// epic inherited from the base branch -- never this run's own output -- and must be skipped
// even though it has a completely real, well-formed epic.yaml + stories on disk.
function findCompletedEpicUnder(root: string, baselineIds: Set<string>): CompletedEpic | null {
  const epicsDir = join(root, ".pHive", "epics");
  if (!existsSync(epicsDir)) return null;

  for (const epicId of readdirSync(epicsDir)) {
    if (baselineIds.has(epicId)) continue;
    const epicYamlPath = join(epicsDir, epicId, "epic.yaml");
    if (!existsSync(epicYamlPath)) continue;

    const storiesDir = join(epicsDir, epicId, "stories");
    const storyFiles = existsSync(storiesDir) ? readdirSync(storiesDir).filter((f) => f.endsWith(".yaml")) : [];

    return {
      epic_id: epicId,
      epic_yaml: readFileSync(epicYamlPath, "utf8"),
      stories: storyFiles.map((f) => ({
        id: f.replace(/\.yaml$/, ""),
        content: readFileSync(join(storiesDir, f), "utf8"),
      })),
    };
  }
  return null;
}

// Real finding (wire-driver-selection story): `claude --bg` auto-creates its own git worktree
// under <workspacePath>/.claude/worktrees/<random-name>/ whenever workspacePath is inside a git
// repo -- which every Minerva workspace always is (AD-3). SubagentDriver-driven turns therefore
// write their epic.yaml there, not directly under workspacePath, unlike SpawnDriver's `-p`
// calls. Search both locations so completion detection is driver-agnostic: try workspacePath
// directly first (SpawnDriver's case, and the common case), then any auto-created worktrees.
//
// `baselineIds` defaults to an empty set (backward compatible for fresh_init workspaces, which
// never have pre-existing epics, and for any caller that genuinely has no baseline to exclude).
// Real production callers (checkAndMarkComplete, below) always pass the run's real
// baseline_epic_ids -- see that snapshot's own doc comment in run-manager.ts for why it exists.
export function findCompletedEpic(workspacePath: string, baselineIds: Set<string> = new Set()): CompletedEpic | null {
  const direct = findCompletedEpicUnder(workspacePath, baselineIds);
  if (direct) return direct;

  const worktreesDir = join(workspacePath, ".claude", "worktrees");
  if (!existsSync(worktreesDir)) return null;

  for (const worktreeName of readdirSync(worktreesDir)) {
    const found = findCompletedEpicUnder(join(worktreesDir, worktreeName), baselineIds);
    if (found) return found;
  }
  return null;
}

// Bug fix (2026-07-26, real regression): a live Minerva run against a real target_repo
// (Heimdall) genuinely produced a new, well-targeted epic, but the workspace's own .gitignore
// blanket-ignores `.pHive/epics/*` with a per-epic allowlist that plugin-hive's own /plan skill
// is supposed to add as part of its own step 0b -- that step apparently did not run in this
// headless/ForkedHiveDriver path, so the new epic sat completely untracked and git-ignored,
// invisible to `git status`, at real risk of being lost if the run's worktree were ever cleaned
// up. This is belt-and-suspenders: whichever skill SHOULD have allowlisted the epic, Minerva
// itself also guarantees it before ever reporting a run complete, since Minerva is the one
// vouching for the artifact's existence via getOutput. Never throws -- a failure here (e.g. no
// git repo, unexpected git error) must not block real completion detection from proceeding; it
// silently skips the repair rather than risk regressing existing behavior.
export function ensureEpicNotGitIgnored(workspacePath: string, epicId: string): void {
  const relPath = join(".pHive", "epics", epicId);
  let ignored: boolean;
  try {
    execFileSync("git", ["-C", workspacePath, "check-ignore", "-q", relPath], { stdio: "pipe" });
    ignored = true; // exit 0 == ignored
  } catch (e: unknown) {
    if (typeof e === "object" && e !== null && "status" in e && (e as { status: unknown }).status === 1) {
      ignored = false; // exit 1 == the expected, non-error "not ignored" outcome
    } else {
      return; // anything else (no git repo, no .gitignore at all, etc.) -- don't risk it
    }
  }
  if (!ignored) return;

  const gitignorePath = join(workspacePath, ".gitignore");
  const allowlistHeader = `!.pHive/epics/${epicId}/`;
  const allowlistLines = [allowlistHeader, `!.pHive/epics/${epicId}/**`];
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (existing.includes(allowlistHeader)) return; // already allowlisted somehow -- nothing to do
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, existing + separator + allowlistLines.join("\n") + "\n");
}

// Called by kickoff-engine.ts after every drive/resume call, before appending a new pending
// question. Returns true (and marks the run complete) if plugin-hive's own skill has written
// an epic.yaml into the workspace since the run started.
export function checkAndMarkComplete(runId: string): boolean {
  const record = readRunRecord(runId);
  if (record.status === "complete") return true; // already marked; idempotent
  const baselineIds = new Set(record.baseline_epic_ids ?? []);
  const found = findCompletedEpic(record.workspace_path, baselineIds);
  if (!found) return false;
  ensureEpicNotGitIgnored(record.workspace_path, found.epic_id);
  updateRunRecord(runId, { status: "complete", output: found });
  // AD-4: exactly one ledger record + one cleanup_needed event per run, at the moment it
  // transitions to a terminal state. This branch only runs once per run (guarded by the
  // status === "complete" early return above), so this call is not repeated on re-checks.
  recordCleanup(runId, "complete");
  return true;
}

export function getOutput(params: Record<string, unknown>): Record<string, unknown> {
  const runId = params.run_id;
  if (typeof runId !== "string") {
    throw new MinervaError("VALIDATION_FAILED", "getOutput requires a string run_id");
  }
  const record = readRunRecord(runId);
  if (record.status !== "complete" || !record.output) {
    throw new MinervaError("NOT_READY", `Run ${runId} has not reached completion yet (status: ${record.status})`);
  }
  return { epic: record.output };
}
