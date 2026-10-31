// Tool descriptor (p2-01-minerva-tool-descriptor, PANT-1248). Everything Minerva assumes about
// the planning tool it drives -- how to invoke it, where it keeps state, how a finished plan is
// detected on disk, where it surfaces questions, and which branch a run is cut from -- lives in
// one descriptor that startRun accepts. plugin-hive is the DEFAULT VALUE of that parameter, not a
// constant in the code path: a run with no descriptor behaves byte-identically to before.
//
// The resolved descriptor is frozen onto the run record (`tool` + `tool_id`, alongside
// `base_branch`), the same way plan_runtime/plan_model are, so every continuation turn resolves
// the same tool. Nothing here reaches any external service.

import { isAbsolute, normalize } from "node:path";
import { MinervaError } from "./errors.ts";
import type { RunRecord } from "./run-manager.ts";

// A run is complete once a NEW epic (not in the run's baseline) with at least one story exists
// under `epics_dir`, in plugin-hive's nested (<id>/epic.yaml + stories/) or flat (NN-name.yaml
// with an embedded `stories:` list) layout. `worktree_roots` are scanned one level deep for
// nested worktrees that carry their own `epics_dir` (plugin-hive writes into
// .claude/worktrees/<name>/ when it isolates itself). All paths are workspace-relative.
export interface EpicsDirCompletionDetector {
  kind: "epics-dir";
  epics_dir: string;
  worktree_roots: string[];
}
export type CompletionDetector = EpicsDirCompletionDetector;

// Where the tool's questions come from: an on-disk envelope dir (read by the forked driver), or
// the schema-forced turn response itself (every driver's built-in path).
export type QuestionSource = { kind: "envelope-dir"; path: string } | { kind: "response" };

export interface ToolDescriptor {
  id: string;
  // The first-turn prompt; every `{idea}` is replaced with the idea, literally.
  invoke: string;
  // Workspace-relative dir the tool keeps its state in; created at allocation.
  state_path: string;
  completion_detector: CompletionDetector;
  question_source: QuestionSource;
  // Branch the run worktree is cut from and the finished plan is pushed to. Falls back to
  // MINERVA_BASE_BRANCH, then "dev".
  base_branch?: string;
}

export const PLUGIN_HIVE_TOOL_ID = "plugin-hive";

// Headless-safe flags: `--skip-sign-off` drops the user-facing sign-off gates; `--lite` drops the
// collaborative review gate + structured outline. See buildDrivePrompt in kickoff-engine.ts.
export const PLUGIN_HIVE_TOOL: ToolDescriptor = Object.freeze({
  id: PLUGIN_HIVE_TOOL_ID,
  invoke: "/plugin-hive:plan {idea} --skip-sign-off --lite",
  state_path: ".pHive",
  completion_detector: Object.freeze({
    kind: "epics-dir" as const,
    epics_dir: ".pHive/epics",
    worktree_roots: Object.freeze([".claude/worktrees"]) as string[],
  }),
  question_source: Object.freeze({ kind: "envelope-dir" as const, path: ".pHive/questions" }),
});

const BUILTIN_TOOLS: Record<string, ToolDescriptor> = { [PLUGIN_HIVE_TOOL_ID]: PLUGIN_HIVE_TOOL };

export const DEFAULT_BASE_BRANCH = "dev";

function fail(message: string): never {
  throw new MinervaError("VALIDATION_FAILED", message);
}

// The default descriptor: plugin-hive, with its invoke string overridable by config.
// MINERVA_DRIVE_PROMPT is the real config name; MINERVA_TEST_DRIVE_PROMPT (its original name, a
// test seam) keeps working. The real name wins when both are set.
export function defaultTool(): ToolDescriptor {
  const invoke = process.env.MINERVA_DRIVE_PROMPT || process.env.MINERVA_TEST_DRIVE_PROMPT;
  return invoke ? { ...PLUGIN_HIVE_TOOL, invoke } : PLUGIN_HIVE_TOOL;
}

// True when the drive prompt has been overridden by config (either name). The agnostic planning
// route only serves the stock plugin-hive invocation, so an override keeps the built-in driver.
export function drivePromptOverridden(): boolean {
  return Boolean(process.env.MINERVA_DRIVE_PROMPT || process.env.MINERVA_TEST_DRIVE_PROMPT);
}

function relPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`tool descriptor ${field} must be a non-empty string`);
  if (isAbsolute(value)) fail(`tool descriptor ${field} must be workspace-relative, got absolute path "${value}"`);
  const n = normalize(value);
  if (n === ".." || n.startsWith("../") || n === ".") fail(`tool descriptor ${field} must stay inside the workspace, got "${value}"`);
  return value;
}

// A conservative subset of git-check-ref-format: no leading "-" (would read as a git option), no
// "..", "//", "@{", whitespace or control chars, no trailing "/", "." or ".lock".
const BRANCH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
export function validateBranch(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !BRANCH_RE.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    fail(`${field} must be a valid git branch name, got ${JSON.stringify(value)}`);
  }
  return value;
}

function validateDescriptor(raw: Record<string, unknown>): ToolDescriptor {
  const { id, invoke, state_path, completion_detector, question_source, base_branch } = raw;
  if (typeof id !== "string" || id.trim().length === 0) fail("tool descriptor id must be a non-empty string");
  if (typeof invoke !== "string" || invoke.trim().length === 0) fail("tool descriptor invoke must be a non-empty string");
  const statePath = relPath(state_path, "state_path");

  const cd = completion_detector as Record<string, unknown> | null;
  if (!cd || typeof cd !== "object" || cd.kind !== "epics-dir") {
    fail('tool descriptor completion_detector.kind must be "epics-dir"');
  }
  const epicsDir = relPath(cd.epics_dir, "completion_detector.epics_dir");
  if (!Array.isArray(cd.worktree_roots)) fail("tool descriptor completion_detector.worktree_roots must be an array");
  const worktreeRoots = cd.worktree_roots.map((r, i) => relPath(r, `completion_detector.worktree_roots[${i}]`));

  const qs = question_source as Record<string, unknown> | null;
  let questionSource: QuestionSource;
  if (qs && typeof qs === "object" && qs.kind === "envelope-dir") {
    questionSource = { kind: "envelope-dir", path: relPath(qs.path, "question_source.path") };
  } else if (qs && typeof qs === "object" && qs.kind === "response") {
    questionSource = { kind: "response" };
  } else {
    fail('tool descriptor question_source.kind must be "envelope-dir" or "response"');
  }

  const tool: ToolDescriptor = {
    id,
    invoke,
    state_path: statePath,
    completion_detector: { kind: "epics-dir", epics_dir: epicsDir, worktree_roots: worktreeRoots },
    question_source: questionSource,
  };
  if (base_branch !== undefined) tool.base_branch = validateBranch(base_branch, "tool descriptor base_branch");
  return tool;
}

// startRun's `tool` parameter: omitted -> the default (plugin-hive); a string -> a built-in
// descriptor by id; an object -> a full descriptor, strictly validated. Fails loudly, never guesses.
export function resolveTool(param: unknown): ToolDescriptor {
  if (param === undefined || param === null) return defaultTool();
  if (typeof param === "string") {
    if (param === PLUGIN_HIVE_TOOL_ID) return defaultTool();
    const builtin = BUILTIN_TOOLS[param];
    if (!builtin) fail(`Unknown tool "${param}" -- built-in tools: ${Object.keys(BUILTIN_TOOLS).join(", ")}`);
    return builtin;
  }
  if (typeof param !== "object" || Array.isArray(param)) {
    fail("startRun `tool` must be a built-in tool id or a tool descriptor object");
  }
  return validateDescriptor(param as Record<string, unknown>);
}

// The descriptor a continuation turn uses: the one frozen on the record, else its id through the
// registry, else the default -- so records written before descriptors existed keep working.
export function toolForRecord(record: Pick<RunRecord, "tool" | "tool_id">): ToolDescriptor {
  if (record.tool) return record.tool;
  if (record.tool_id && BUILTIN_TOOLS[record.tool_id]) return BUILTIN_TOOLS[record.tool_id]!;
  return PLUGIN_HIVE_TOOL;
}

// Descriptor first, then MINERVA_BASE_BRANCH, then "dev".
export function resolveBaseBranch(tool: Pick<ToolDescriptor, "base_branch">): string {
  if (tool.base_branch) return tool.base_branch;
  const env = process.env.MINERVA_BASE_BRANCH;
  if (env) return validateBranch(env, "MINERVA_BASE_BRANCH");
  return DEFAULT_BASE_BRANCH;
}

export function baseBranchForRecord(record: Pick<RunRecord, "base_branch">): string {
  return record.base_branch ?? DEFAULT_BASE_BRANCH;
}

// Expand `{idea}` with a replacer function so `$&`/`$1` in an idea stay literal.
export function expandInvoke(invoke: string, idea: string): string {
  return invoke.replace(/\{idea\}/g, () => idea);
}

export function questionsDirOf(tool: ToolDescriptor): string | undefined {
  return tool.question_source.kind === "envelope-dir" ? tool.question_source.path : undefined;
}
