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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MinervaError } from "./errors.ts";
import { readRunRecord, updateRunRecord } from "./run-manager.ts";
import { recordCleanup } from "./cleanup-ledger.ts";

export interface CompletedEpic {
  epic_id: string;
  epic_yaml: string;
  stories: Array<{ id: string; content: string }>;
}

function findCompletedEpicUnder(root: string): CompletedEpic | null {
  const epicsDir = join(root, ".pHive", "epics");
  if (!existsSync(epicsDir)) return null;

  for (const epicId of readdirSync(epicsDir)) {
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
export function findCompletedEpic(workspacePath: string): CompletedEpic | null {
  const direct = findCompletedEpicUnder(workspacePath);
  if (direct) return direct;

  const worktreesDir = join(workspacePath, ".claude", "worktrees");
  if (!existsSync(worktreesDir)) return null;

  for (const worktreeName of readdirSync(worktreesDir)) {
    const found = findCompletedEpicUnder(join(worktreesDir, worktreeName));
    if (found) return found;
  }
  return null;
}

// Called by kickoff-engine.ts after every drive/resume call, before appending a new pending
// question. Returns true (and marks the run complete) if plugin-hive's own skill has written
// an epic.yaml into the workspace since the run started.
export function checkAndMarkComplete(runId: string): boolean {
  const record = readRunRecord(runId);
  if (record.status === "complete") return true; // already marked; idempotent
  const found = findCompletedEpic(record.workspace_path);
  if (!found) return false;
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
