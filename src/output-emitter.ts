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
import { finalizeRunMetrics, readRunRecord, updateRunRecord, type RunRecord } from "./run-manager.ts";
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

// Result of the post-planning auto-commit+push (PAN-6745). Persisted opaquely on the RunRecord
// (`plan_push`) and returned so callers/tests can assert the plan actually landed in the repo.
export interface PlanPushResult {
  committed: boolean;
  pushed: boolean;
  branch: string | null;
  reason: string;
}

// Run a git command in `cwd`, capturing exit code + streams instead of throwing. Used by the
// commit+push path so a git failure can be reported (never blocks completion detection).
function gitCapture(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: unknown; stderr?: unknown; message?: string };
    return {
      code: typeof err?.status === "number" ? err.status : 1,
      stdout: String(err?.stdout ?? ""),
      stderr: String(err?.stderr ?? err?.message ?? ""),
    };
  }
}

function currentBranch(cwd: string): string | null {
  const r = gitCapture(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const name = r.stdout.trim();
  return r.code === 0 && name.length > 0 ? name : null;
}

// Auto-commit + push the finished plan into the run's target repo (PAN-6745 autonomy unlock).
// This is the automation of the previously-MANUAL step ("commit the plan to a real repo by hand")
// that was the single thing standing between a produced plan and a build agent being able to check
// it out. Called exactly once per run, from checkAndMarkComplete, at the moment the run is marked
// complete.
//
// Behavior + guardrails:
//   - ONLY for worktree workspaces. A fresh_init scratch workspace is a throwaway local git-init
//     with no `origin` remote -- there is nothing to push to, so this no-ops cleanly. (Post-PAN-6745
//     resolution, greenfield seeds resolve to a real incubator repo and take the worktree path, so
//     they DO get pushed; only fully-unconfigured deployments still hit fresh_init.)
//   - Stages each completed epic's on-disk entry (a dir subtree for nested, a single file for flat)
//     plus any .gitignore repair ensureEpicNotGitIgnored just wrote.
//   - Idempotent: if nothing is staged (e.g. plugin-hive's own /plan already committed the plan, or
//     this ran before), it no-ops without an empty commit.
//   - Commits with a fixed inline identity so it never depends on the run host's global git config.
//   - Pushes the run-scoped branch (run/<run_id>, the branch the worktree path already cut off
//     `dev`) to `origin`. NEVER force-pushes.
//   - Never throws: any git failure is captured and reported in the result, so a push problem can
//     never wedge completion detection or the run's terminal transition.
export function commitAndPushPlan(
  record: Pick<RunRecord, "run_id" | "workspace_path" | "workspace_kind">,
  epics: CompletedEpic[],
): PlanPushResult {
  if (record.workspace_kind !== "worktree") {
    return { committed: false, pushed: false, branch: null, reason: "fresh_init workspace has no remote to push to -- skipped" };
  }
  const cwd = record.workspace_path;

  for (const epic of epics) {
    gitCapture(cwd, ["add", "--", join(".pHive", "epics", epic.entry_name)]);
  }
  gitCapture(cwd, ["add", "--", ".gitignore"]); // best-effort; harmless if unchanged/absent

  // `git diff --cached --quiet` exits 0 when nothing is staged -> idempotent no-op (no empty commit).
  if (gitCapture(cwd, ["diff", "--cached", "--quiet"]).code === 0) {
    return { committed: false, pushed: false, branch: currentBranch(cwd), reason: "nothing to commit -- plan already committed" };
  }

  const msg = `plan(${record.run_id}): commit planned work so build agents can execute`;
  const committed = gitCapture(cwd, [
    "-c", "user.email=minerva@dostal.dev",
    "-c", "user.name=minerva",
    "commit", "-q", "-m", msg,
  ]);
  if (committed.code !== 0) {
    return { committed: false, pushed: false, branch: currentBranch(cwd), reason: `commit failed: ${committed.stderr.trim()}` };
  }

  const branch = currentBranch(cwd);
  if (!branch) {
    return { committed: true, pushed: false, branch: null, reason: "committed, but could not resolve a branch to push" };
  }
  // Explicit refspec (HEAD:refs/heads/<branch>), plain push -- no --force, ever.
  const pushed = gitCapture(cwd, ["push", "origin", `HEAD:refs/heads/${branch}`]);
  if (pushed.code !== 0) {
    return { committed: true, pushed: false, branch, reason: `committed, push failed: ${pushed.stderr.trim()}` };
  }
  // Gate-2: also land the plan bundle on the target repo's `dev` branch, which is where the build
  // lane checks out to find a committed .pHive/epics/<epic> plan. The run branch was cut from dev,
  // so HEAD is dev + this one plan commit and fast-forwards cleanly. Best-effort + NEVER force: if
  // dev moved on origin since the worktree was cut this is skipped and reported, and the plan is
  // still durably pushed on the run branch above.
  const devPush =
    branch === "dev"
      ? { code: 0, stdout: "", stderr: "" }
      : gitCapture(cwd, ["push", "origin", "HEAD:refs/heads/dev"]);
  const devNote =
    devPush.code === 0 ? "; plan landed on dev for the build lane" : `; dev fast-forward skipped: ${devPush.stderr.trim()}`;
  return { committed: true, pushed: true, branch, reason: `plan committed + pushed to origin/${branch}${devNote}` };
}


function epicRelPath(epicId: string): string {
  return join(".pHive", "epics", epicId);
}

// A target repo may carry its own blanket ignore (e.g. `.pHive/epics/*`) predating Minerva's
// auto-commit behavior. Appending a per-epic negation pattern re-includes just this epic's
// directory without touching the target repo's other ignore rules.
function ensureGitignoreAllowlist(root: string, epicId: string): void {
  const gitignorePath = join(root, ".gitignore");
  const allowLine = `!${epicRelPath(epicId)}/`;

  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  if (existing.split("\n").some((line) => line.trim() === allowLine)) return; // already allowlisted

  const needsNewline = existing.length > 0 && !existing.endsWith("\n");
  writeFileSync(gitignorePath, existing + (needsNewline ? "\n" : "") + allowLine + "\n");
}

// Auto-commits a newly-detected epic plan into the workspace's own git history, so downstream
// build agents (Auriga, Vulcan, etc.) can read the plan without a manual commit step (PAN-6745).
// Idempotent: if the epic dir is already tracked and clean, this is a no-op -- safe to call on
// every checkAndMarkComplete poll without producing duplicate commits.
export function commitPlan(root: string, epicId: string): void {
  const relPath = epicRelPath(epicId);
  const status = execFileSync("git", ["-C", root, "status", "--porcelain", "--ignored", "--", relPath], {
    encoding: "utf8",
  });
  if (status.trim().length === 0) return; // already committed; idempotent no-op

  const isIgnored = status.split("\n").some((line) => line.startsWith("!!"));
  if (isIgnored) {
    ensureGitignoreAllowlist(root, epicId);
    execFileSync("git", ["-C", root, "add", "--", ".gitignore"], { stdio: "pipe" });
  }

  execFileSync("git", ["-C", root, "add", "-f", "--", relPath], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", `chore(plan): commit epic plan for ${epicId}`], {
    stdio: "pipe",
  });
}

// Pushes the run's `run/<runId>` branch to origin right after commitPlan finishes, so the
// committed plan is immediately fetchable by downstream build agents (Auriga, Vulcan, etc.)
// without a manual push step (PAN-6747). Deliberately non-blocking: the plan is already safely
// committed locally by commitPlan, so a missing remote or a push failure (auth/network) is only
// ever logged, never thrown -- it must not prevent the run from completing.
export function pushPlan(root: string, runId: string): void {
  try {
    execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { stdio: "pipe" });
  } catch {
    console.warn(`pushPlan: no 'origin' remote configured for ${root}; skipping push`);
    return;
  }

  try {
    execFileSync("git", ["-C", root, "push", "--set-upstream", "origin", `run/${runId}`], { stdio: "pipe" });
  } catch (e) {
    const stderr = e instanceof Error && "stderr" in e ? String((e as any).stderr) : String(e);
    console.warn(`pushPlan: failed to push run/${runId} to origin: ${stderr.trim()}`);
  }
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
  // Auto-commit + push the plan into the target repo so downstream build agents can check it out
  // (PAN-6745). Never throws -- a git failure is captured on the result and must not block the
  // run's transition to complete.
  let planPush: PlanPushResult;
  try {
    planPush = commitAndPushPlan(record, epics);
  } catch (e) {
    planPush = { committed: false, pushed: false, branch: null, reason: `commit/push errored: ${e instanceof Error ? e.message : String(e)}` };
  }
  const output: CompletionOutput = { epic: epics[0]!, epics }; // length checked non-empty above
  updateRunRecord(runId, { status: "complete", output, plan_push: planPush });
  finalizeRunMetrics(runId);

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
  return { epic, epics, metrics: record.metrics ?? null };
}
