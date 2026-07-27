// Output Emitter (REQ-04) — detects when plugin-hive's own kickoff+plan skill has written its
// epic+stories artifact into the run's workspace, and serves it via getOutput.
//
// Design note: Minerva does NOT construct a separate epic+stories representation. plugin-hive's
// /plan skill writes its epic+stories artifact directly into the workspace as part of its own
// normal operation (confirmed empirically -- a headless driven session with --permission-mode
// bypassPermissions genuinely uses its Write tool against the real filesystem). So "the run
// reaches its final gate" is detected as a filesystem fact -- epic artifacts appearing under the
// workspace's .pHive/epics/ -- not a self-reported "I'm done" signal from the model, which would
// be one more thing that could be unreliable or unparseable.
//
// Two on-disk epic layouts are detected (2026-07-27, both observed empirically from real runs):
//
//   NESTED  -- .pHive/epics/<epic-id>/epic.yaml  +  .pHive/epics/<epic-id>/stories/*.yaml
//   FLAT    -- .pHive/epics/NN-name.yaml         (one file per epic, with `stories:` embedded)
//
// plugin-hive's /plan documents the NESTED form, but real headless runs (e.g. the Votum seed that
// produced a 7-epic / 34-story plan under ~/.minerva/runs/8f88cba8.../workspace) wrote the FLAT
// form: seven `.pHive/epics/0N-*.yaml` files, each carrying its own `stories:` list inline. The
// old detector only understood NESTED, so those runs were never marked complete and their stories
// were never auto-filed to Multica. This module now understands BOTH, and -- because a single plan
// legitimately produces MANY epics (7 here) -- returns ALL of a run's own epics, not just the
// first, so every story from every epic gets filed.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { MinervaError } from "./errors.ts";
import { readRunRecord, updateRunRecord } from "./run-manager.ts";
import { recordCleanup } from "./cleanup-ledger.ts";

export interface CompletedEpic {
  epic_id: string;
  epic_yaml: string;
  stories: Array<{ id: string; content: string }>;
  // The literal directory entry under .pHive/epics/ this epic was read from -- the dir name
  // (nested) or the `NN-name.yaml` file name (flat). This is what run-manager's baseline snapshot
  // records (readdirSync entries), so it -- not the possibly-different internal `id:` -- is what
  // baseline exclusion and the .gitignore repair key off.
  entry_name: string;
  layout: "nested" | "flat";
}

// Parse one FLAT epic file (`.pHive/epics/NN-name.yaml` with an embedded `stories:` list) into a
// CompletedEpic. The epic id is the file's own `id:` field (its canonical id, e.g.
// `domain-model-store` for `01-domain-model-store.yaml`), falling back to the file name without
// its numeric prefix stripping / extension. Each embedded story is re-serialized to standalone
// YAML so downstream `storyToIssueFields` can parse its `title:` exactly as it does a nested
// story's own YAML file. Returns null if the file is unparseable or clearly not an epic (no
// `stories:` and no `id:`/`title:`), so a stray non-epic .yaml never trips false completion.
function parseFlatEpic(root: string, entryName: string, baselineIds: Set<string>): CompletedEpic | null {
  const filePath = join(root, ".pHive", "epics", entryName);
  const epicYaml = readFileSync(filePath, "utf8");
  let parsed: any;
  try {
    parsed = parseYaml(epicYaml);
  } catch {
    return null; // not valid YAML -- not an epic artifact
  }
  if (!parsed || typeof parsed !== "object") return null;
  const hasStories = Array.isArray(parsed.stories);
  if (!hasStories && typeof parsed.id !== "string" && typeof parsed.title !== "string") {
    return null; // doesn't look like an epic at all
  }

  const fileBase = entryName.replace(/\.ya?ml$/i, "");
  const epicId = typeof parsed.id === "string" && parsed.id.trim().length > 0 ? parsed.id.trim() : fileBase;

  const rawStories: any[] = hasStories ? parsed.stories : [];
  const stories = rawStories.map((s, i) => {
    const storyId =
      s && typeof s.id === "string" && s.id.trim().length > 0 ? s.id.trim() : `${epicId}-story-${i + 1}`;
    // Re-serialize the embedded story object to YAML so it is a first-class, parseable story
    // document (title, acceptance, points, ...) identical in shape to a nested stories/*.yaml.
    const content = s && typeof s === "object" ? stringifyYaml(s) : String(s ?? "");
    return { id: storyId, content };
  });

  return { epic_id: epicId, epic_yaml: epicYaml, stories, entry_name: entryName, layout: "flat" };
}

// Parse one NESTED epic dir (`.pHive/epics/<id>/epic.yaml` + `stories/*.yaml`) into a CompletedEpic.
function parseNestedEpic(root: string, entryName: string): CompletedEpic | null {
  const epicDir = join(root, ".pHive", "epics", entryName);
  const epicYamlPath = join(epicDir, "epic.yaml");
  if (!existsSync(epicYamlPath)) return null;

  const storiesDir = join(epicDir, "stories");
  const storyFiles = existsSync(storiesDir) ? readdirSync(storiesDir).filter((f) => f.endsWith(".yaml")) : [];

  return {
    epic_id: entryName,
    epic_yaml: readFileSync(epicYamlPath, "utf8"),
    entry_name: entryName,
    layout: "nested",
    stories: storyFiles.map((f) => ({
      id: f.replace(/\.yaml$/, ""),
      content: readFileSync(join(storiesDir, f), "utf8"),
    })),
  };
}

// Bug fix (2026-07-26, real regression): `baselineIds` is the set of directory-entry names under
// .pHive/epics/ that already existed in the workspace at allocation time (run-manager.ts's
// `baseline_epic_ids`, snapshotted from the target repo's base branch before any turn runs). Any
// entry in that set is a pre-existing, already-shipped epic inherited from the base branch -- never
// this run's own output -- and must be skipped even though it has a completely real epic artifact
// on disk. Matching is on the readdirSync entry name (dir name for nested, `NN-name.yaml` for
// flat), exactly what snapshotEpicIds records.
//
// Returns ALL of this run's own epics found directly under `root`, in readdirSync order (stable,
// numeric-prefixed for flat plans). A single /plan run legitimately produces multiple epics.
function findCompletedEpicsUnder(root: string, baselineIds: Set<string>): CompletedEpic[] {
  const epicsDir = join(root, ".pHive", "epics");
  if (!existsSync(epicsDir)) return [];

  const found: CompletedEpic[] = [];
  for (const entry of readdirSync(epicsDir).sort()) {
    if (baselineIds.has(entry)) continue;
    const entryPath = join(epicsDir, entry);
    let st: import("node:fs").Stats;
    try {
      st = statSync(entryPath);
    } catch {
      continue;
    }
    let epic: CompletedEpic | null = null;
    if (st.isFile() && /\.ya?ml$/i.test(entry)) {
      epic = parseFlatEpic(root, entry, baselineIds); // FLAT: NN-name.yaml with embedded stories
    } else if (st.isDirectory()) {
      epic = parseNestedEpic(root, entry); // NESTED: <id>/epic.yaml + stories/*.yaml
    }
    if (epic) found.push(epic);
  }
  return found;
}

// Real finding (wire-driver-selection story): `claude --bg` auto-creates its own git worktree
// under <workspacePath>/.claude/worktrees/<random-name>/ whenever workspacePath is inside a git
// repo -- which every Minerva workspace always is (AD-3). SubagentDriver-driven turns therefore
// write their epic artifacts there, not directly under workspacePath, unlike SpawnDriver's `-p`
// calls. Search both locations so completion detection is driver-agnostic: try workspacePath
// directly first (SpawnDriver's case, and the common case), then any auto-created worktrees.
//
// Returns ALL of the run's own epics across both locations, de-duplicated by epic_id (an epic can
// legitimately appear only once; dedup guards against the same worktree being scanned twice).
// `baselineIds` defaults to an empty set (backward compatible for fresh_init workspaces).
export function findCompletedEpics(workspacePath: string, baselineIds: Set<string> = new Set()): CompletedEpic[] {
  const collected: CompletedEpic[] = [...findCompletedEpicsUnder(workspacePath, baselineIds)];

  const worktreesDir = join(workspacePath, ".claude", "worktrees");
  if (existsSync(worktreesDir)) {
    for (const worktreeName of readdirSync(worktreesDir).sort()) {
      collected.push(...findCompletedEpicsUnder(join(worktreesDir, worktreeName), baselineIds));
    }
  }

  const seen = new Set<string>();
  const deduped: CompletedEpic[] = [];
  for (const e of collected) {
    if (seen.has(e.epic_id)) continue;
    seen.add(e.epic_id);
    deduped.push(e);
  }
  return deduped;
}

// Backward-compatible singular accessor: the FIRST of this run's own epics, or null. Retained for
// callers/tests that only need "did a plan complete" / a representative epic. Completion detection
// and story filing use findCompletedEpics (plural) so multi-epic plans file every story.
export function findCompletedEpic(workspacePath: string, baselineIds: Set<string> = new Set()): CompletedEpic | null {
  return findCompletedEpics(workspacePath, baselineIds)[0] ?? null;
}

// Bug fix (2026-07-26, real regression): a live Minerva run against a real target_repo genuinely
// produced a new, well-targeted epic, but the workspace's own .gitignore blanket-ignores
// `.pHive/epics/*` with a per-epic allowlist that plugin-hive's own /plan skill is supposed to add
// as part of its own step 0b -- that step apparently did not run in this headless path, so the new
// epic sat completely untracked and git-ignored, invisible to `git status`, at real risk of being
// lost if the run's worktree were ever cleaned up. This is belt-and-suspenders: whichever skill
// SHOULD have allowlisted the epic, Minerva itself also guarantees it before ever reporting a run
// complete, since Minerva is the one vouching for the artifact's existence via getOutput. Never
// throws -- a failure here (e.g. no git repo, unexpected git error) must not block real completion
// detection; it silently skips the repair rather than risk regressing existing behavior.
//
// `entryName` is the on-disk entry: a dir name (nested) or a `NN-name.yaml` file name (flat). The
// allowlist shape differs per layout -- a directory subtree for nested, a single file for flat.
export function ensureEpicNotGitIgnored(
  workspacePath: string,
  entryName: string,
  layout: "nested" | "flat" = "nested",
): void {
  const relPath = join(".pHive", "epics", entryName);
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
  const allowlistHeader =
    layout === "flat" ? `!.pHive/epics/${entryName}` : `!.pHive/epics/${entryName}/`;
  const allowlistLines =
    layout === "flat" ? [allowlistHeader] : [allowlistHeader, `!.pHive/epics/${entryName}/**`];
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (existing.includes(allowlistHeader)) return; // already allowlisted somehow -- nothing to do
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(gitignorePath, existing + separator + allowlistLines.join("\n") + "\n");
}

// The stored completion output: the full set of the run's own epics, plus the first as a
// backward-compatible representative. Persisted opaquely on the RunRecord (`output`).
interface CompletionOutput {
  epic: CompletedEpic;
  epics: CompletedEpic[];
}

// Called by kickoff-engine.ts after every drive/resume call, before appending a new pending
// question. Returns true (and marks the run complete) if plugin-hive's own skill has written epic
// artifact(s) into the workspace since the run started. Files ALL of the run's own epics into the
// completion output (multi-epic plans are the norm, not the exception).
export function checkAndMarkComplete(runId: string): boolean {
  const record = readRunRecord(runId);
  if (record.status === "complete") return true; // already marked; idempotent
  const baselineIds = new Set(record.baseline_epic_ids ?? []);
  const epics = findCompletedEpics(record.workspace_path, baselineIds);
  if (epics.length === 0) return false;
  for (const epic of epics) {
    ensureEpicNotGitIgnored(record.workspace_path, epic.entry_name, epic.layout);
  }
  const output: CompletionOutput = { epic: epics[0]!, epics }; // length checked non-empty above
  updateRunRecord(runId, { status: "complete", output });
  // AD-4: exactly one ledger record + one cleanup_needed event per run, at the moment it
  // transitions to a terminal state. This branch only runs once per run (guarded by the
  // status === "complete" early return above), so this call is not repeated on re-checks.
  recordCleanup(runId, "complete");
  return true;
}

// Normalize whatever shape is persisted in record.output into { epic, epics }. Handles the current
// CompletionOutput shape as well as two legacy shapes for forward/backward safety: a bare
// CompletedEpic (older single-epic records) and a { epic } wrapper without `epics`.
function normalizeOutput(raw: unknown): { epic: CompletedEpic | null; epics: CompletedEpic[] } {
  if (!raw || typeof raw !== "object") return { epic: null, epics: [] };
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.epics)) {
    const epics = o.epics as CompletedEpic[];
    const first = (o.epic as CompletedEpic | undefined) ?? epics[0];
    return { epic: first ?? null, epics };
  }
  if (o.epic && typeof o.epic === "object") {
    return { epic: o.epic as CompletedEpic, epics: [o.epic as CompletedEpic] };
  }
  if (typeof o.epic_id === "string") {
    return { epic: raw as CompletedEpic, epics: [raw as CompletedEpic] }; // legacy bare CompletedEpic
  }
  return { epic: null, epics: [] };
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
  const { epic, epics } = normalizeOutput(record.output);
  return { epic, epics };
}
