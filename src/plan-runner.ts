// Headless plan runner (prebaked-plan-defaults epic, Auriga-integration slice) — the router-
// facing "plan this ticket/idea" orchestration Auriga invokes non-interactively. It wraps
// Minerva's own ABI methods (startRun -> [pre-baked-defaults auto-answer loop drives kickoff+plan
// to completion] -> getOutput) into a single one-shot call that turns an idea brief (or a Multica
// ticket) into a dependency-tracked epic + stories, and optionally files the decomposed stories
// back to Multica as sub-issues of the origin ticket.
//
// This is deliberately SEPARATE from src/dispatch.ts's core ABI: the core plugin stays
// provider-agnostic (no Multica coupling), while this module + bin/minerva-plan.ts are the thin
// Multica-aware integration entrypoint a router (Auriga) or the `minerva-dev` Multica agent runs.
// All Multica interaction goes through Pantheon's core-api (POST /api/backlog/issues for ticket
// filing, GET /api/backlog/issues/:id for reads) — Minerva never calls Multica directly.

import { parse as parseYaml } from "yaml";
import { startRun } from "./kickoff-engine.ts";
import { getRunStatus, readRunRecord, type Question } from "./run-manager.ts";
import { getOutput } from "./output-emitter.ts";
import type { CompletedEpic } from "./output-emitter.ts";
import type { PlanDefaultsMode } from "./plan-defaults.ts";
import { parseTargetRepoLine, stampTargetRepo, deriveRepoSlugFromWorkspace } from "./target-repo-signal.ts";
import { resolvePantheonCoreApiUrl, PANTHEON_CORE_API_URL_MISSING } from "./pantheon-core-api.ts";
import { withOperatorToken } from "./operator-token.ts";

export interface PlanRequest {
  idea: string;
  targetRepo?: string;
  mode?: PlanDefaultsMode; // default "auto" (fully unattended) unless defaultsFile sets its own
  defaults?: Record<string, unknown>; // extra per-run plan-defaults overrides (merged over mode)
  defaultsFile?: string; // plan-defaults YAML/JSON file of known operator answers (PANT-996)
  ticketId?: string; // origin Multica ticket, for linkage when filing stories back
}

export interface PlanResult {
  run_id: string;
  status: string; // "complete" | "waiting_on_human" | ...
  epic: CompletedEpic | null; // first epic (backward compat); present iff status === "complete"
  epics: CompletedEpic[]; // ALL of the run's own epics -- a single /plan run routinely produces many
  pending_questions: Question[]; // present (non-empty) iff the plan parked on a genuine gate
  workspace_path: string;
}

// Drive a full headless kickoff+plan for one idea and return the resulting epic+stories (or the
// gate it parked on). Because startRun runs the pre-baked-defaults auto-answer loop synchronously
// before it returns, by the time it resolves the run is already either complete or parked on a
// question with no resolvable default -- there is no polling/waiting needed here. mode defaults to
// "auto" so a routed ticket plans fully unattended -- except when a defaultsFile is given and no
// explicit mode is, in which case the file's own mode stands (an inline mode would override it).
export async function runHeadlessPlan(req: PlanRequest): Promise<PlanResult> {
  const mode = req.mode ?? (req.defaultsFile ? undefined : "auto");
  const defaults = {
    ...(mode ? { mode } : {}),
    ...(req.defaultsFile ? { file: req.defaultsFile } : {}),
    ...(req.defaults ?? {}),
  };
  const { run_id } = (await startRun({
    idea: req.idea,
    ...(req.targetRepo ? { target_repo: req.targetRepo } : {}),
    defaults,
  })) as { run_id: string };

  const status = (getRunStatus({ run_id }) as { status: string }).status;
  const record = readRunRecord(run_id);

  let epic: CompletedEpic | null = null;
  let epics: CompletedEpic[] = [];
  if (status === "complete") {
    const out = getOutput({ run_id }) as { epic: CompletedEpic | null; epics: CompletedEpic[] };
    epic = out.epic;
    epics = out.epics ?? (out.epic ? [out.epic] : []);
  }
  const pending = record.questions.filter((q) => q.status === "pending");

  return { run_id, status, epic, epics, pending_questions: pending, workspace_path: record.workspace_path };
}

// --- Pantheon core-api client (replaces the direct multica CLI shell-out) -------------------
//
// Pantheon's core-api is the ONLY sanctioned path for board-write and board-read operations --
// no god calls Multica directly. POST /api/backlog/issues creates tickets; GET reads them;
// PUT /api/backlog/issues/:id/metadata updates ticket metadata.

type PantheonFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// The Pantheon fetch impl is indirected through a module-level slot so tests can substitute a
// fake (no real HTTP calls). The production path uses globalThis.fetch unchanged.
let _pantheonFetch: PantheonFetch = globalThis.fetch as unknown as PantheonFetch;

// Test-only: swap the Pantheon fetch impl. Returns the previous impl so a test can restore it.
export function __setPantheonFetchForTest(fn: PantheonFetch): PantheonFetch {
  const prev = _pantheonFetch;
  _pantheonFetch = fn;
  return prev;
}

async function pantheonRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const baseUrl = resolvePantheonCoreApiUrl();
  if (!baseUrl) throw new Error(PANTHEON_CORE_API_URL_MISSING);
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  // Writes carry the operator token (PANT-1093); reads don't need it.
  const headers: Record<string, string> = body !== undefined ? { "content-type": "application/json" } : {};
  const init: { method: string; headers?: Record<string, string>; body?: string } =
    method === "GET" ? { method } : { method, headers: await withOperatorToken(headers) };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await _pantheonFetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Pantheon core-api ${method} ${path} failed with HTTP ${res.status}: ${text}`);
  }
  return text.length > 0 ? JSON.parse(text) : null;
}

// Resolve an idea brief from a Multica ticket: `title` + `description`, joined into the prose the
// kickoff skill expects. Throws if the ticket can't be read/parsed -- a router must not silently
// plan an empty idea.
export async function resolveIdeaFromTicket(ticketId: string): Promise<{ idea: string; title: string; targetRepo: string | null }> {
  const issue = (await pantheonRequest("GET", `/api/backlog/issues/${encodeURIComponent(ticketId)}`)) as Record<string, unknown>;
  const title = typeof issue.title === "string" ? issue.title : "";
  const description = typeof issue.description === "string" ? issue.description : "";
  const idea = [title, description].filter((s) => s.trim().length > 0).join("\n\n");
  if (idea.trim().length === 0) {
    throw new Error(`Multica ticket ${ticketId} has no title/description to plan from`);
  }
  // The seed's declared build target (Gate-2): the ticket's metadata.target_repo (set
  // programmatically) OR a `target_repo: <owner/repo>` line in its description/title — the SAME
  // signal the build lane reads. Null when the seed declares no target (greenfield). This is what
  // lets a RAW seed's build target flow down to its decomposed child stories and into the repo.
  const metaRepo =
    issue && issue.metadata && typeof (issue.metadata as Record<string, unknown>).target_repo === "string"
      ? ((issue.metadata as Record<string, unknown>).target_repo as string).trim()
      : "";
  const targetRepo =
    (metaRepo.length > 0 ? metaRepo : parseTargetRepoLine(description) ?? parseTargetRepoLine(title)) || null;
  return { idea, title, targetRepo };
}

// Derive a sub-issue title + description from a plugin-hive story YAML.
export function storyToIssueFields(story: { id: string; content: string }): { title: string; description: string } {
  let storyTitle = story.id;
  try {
    const parsed = parseYaml(story.content) as any;
    if (parsed && typeof parsed.title === "string" && parsed.title.trim().length > 0) {
      storyTitle = parsed.title.trim();
    }
  } catch {
    // non-YAML/unexpected shape -- fall back to the story id as the title
  }
  return { title: `[${story.id}] ${storyTitle}`, description: story.content };
}

// Extract a story's STORY-LEVEL depends_on — the list of sibling story ids this story must
// follow — from the plugin-hive story YAML. Returns [] when absent/unparseable. This is the
// TOP-LEVEL `depends_on`, distinct from any per-step depends_on nested inside the story's steps.
export function parseStoryDependsOn(story: { id: string; content: string }): string[] {
  try {
    const parsed = parseYaml(story.content) as any;
    const d = parsed && parsed.depends_on;
    if (Array.isArray(d)) return d.map((x) => String(x).trim()).filter((s) => s.length > 0);
  } catch {
    // non-YAML/unexpected shape -> no declared dependencies
  }
  return [];
}

// Sibling story ids a story names as a dependency only in PROSE (minerva#97): "Depends on
// content-wall-1", "builds on top of vt2-01 ...". The planner does not always mirror these into
// the YAML depends_on list, and a prose-only dependency is invisible to every gate. Only exact
// sibling story ids count (never fuzzy titles), and YAML `depends_on:` lines are skipped -- the
// story-level one is read by parseStoryDependsOn and the step-level ones name steps, not stories.
const PROSE_DEPENDENCY_CUE = /\b(?:depends?\s+on|blocked\s+by|builds?\s+on|requires|needs|waits?\s+(?:for|on))\b/i;

export function parseProseDependsOn(story: { id: string; content: string }, siblingIds: string[]): string[] {
  const out: string[] = [];
  for (const line of story.content.split(/\r?\n/)) {
    if (/^\s*-?\s*depends_on\s*:/i.test(line)) continue;
    const cue = line.search(PROSE_DEPENDENCY_CUE);
    if (cue < 0) continue;
    const tail = line.slice(cue);
    for (const id of siblingIds) {
      if (id === story.id || out.includes(id)) continue;
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(tail)) out.push(id);
    }
  }
  return out;
}

// Order stories so every story is filed AFTER the siblings it depends on: a dependent's
// `Depends on:` line can then carry the ticket identifiers the create calls already returned.
// core-api has no description-update route, so the line has to be right at creation. Stories in a
// dependency cycle (or naming one another in a loop) keep their original relative order at the end.
export function orderStoriesForFiling<T extends { id: string }>(stories: T[], depsByStory: Map<string, string[]>): T[] {
  const ids = new Set(stories.map((s) => s.id));
  const placed = new Set<string>();
  const ordered: T[] = [];
  let remaining = [...stories];
  while (remaining.length > 0) {
    const ready = remaining.filter((s) => (depsByStory.get(s.id) ?? []).every((d) => !ids.has(d) || d === s.id || placed.has(d)));
    if (ready.length === 0) {
      ordered.push(...remaining);
      break;
    }
    for (const s of ready) {
      ordered.push(s);
      placed.add(s.id);
    }
    remaining = remaining.filter((s) => !placed.has(s.id));
  }
  return ordered;
}

// The dependency block appended to a filed story's description (minerva#97). Auriga (auriga#260)
// gates dispatch on `Depends on:` lines holding uppercase ticket identifiers (FFE-86) and never
// resolves a story slug, so the line carries identifiers, each with its slug alongside for humans.
// A dependency with no identifier yet is listed on a comment line, never on the Depends on line.
// The comment lines keep the description valid YAML, and the gating note replaces the old "set
// this ticket to blocked and pick it up again" pattern: a blocked ticket with no blocked_reason
// is skipped by every pass, while `dependency:<ids>` is the reason Auriga re-queues on.
export function dependencyBlock(deps: Array<{ story_id: string; identifier: string | null }>): string {
  if (deps.length === 0) return "";
  const resolved = deps.filter((d) => d.identifier);
  const unresolved = deps.filter((d) => !d.identifier).map((d) => d.story_id);
  const lines: string[] = [];
  if (resolved.length > 0) {
    const ids = resolved.map((d) => d.identifier!).join(",");
    lines.push(`Depends on: ${resolved.map((d) => `${d.identifier} (${d.story_id})`).join(", ")}`);
    lines.push(
      `# Dependency gating: the router does not dispatch this story until every ticket on the Depends on line is done, ` +
        `so do not self-block on them. If one is still unmerged, set metadata blocked_reason to "dependency:${ids}" ` +
        `before setting this ticket to blocked; a blocked ticket with no blocked_reason is never re-queued.`,
    );
  }
  if (unresolved.length > 0) {
    lines.push(`# Unresolved dependencies (no ticket identifier at filing time): ${unresolved.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

function appendBlock(description: string, block: string): string {
  if (!block) return description;
  const sep = description.length > 0 && !description.endsWith("\n") ? "\n" : "";
  return `${description}${sep}${block}`;
}

export interface FiledStory {
  story_id: string;
  issue_id: string;
}

// File each decomposed story back to Multica as a sub-issue of the origin ticket via Pantheon's
// core-api (POST /api/backlog/issues), leaving them UNASSIGNED per the standing operator policy
// (Mathew assigns manually; mirrors consus-dev/heimdall-dev instructions). Only the planned
// stories become dev-agent work items -- exactly the "only PLANNED stories go to dev agents" flow.
// The create body never carries an assignee: Multica runs ANY agent-assigned issue regardless of
// status, so an assignee set at creation would start the story immediately (PANT-929: PANT-923 was
// filed in backlog already assigned, ran, and merged before the operator's decision gate opened).
// opts.park files the stories in `backlog` instead of `todo` so they wait behind a gate; Auriga
// never dispatches backlog, and promoteParkedStories moves them to `todo` (still unassigned) once
// the gate opens.
// Returns the created issue ids. Best-effort per story: a single failed create is reported but
// does not abort the rest.
export interface FileStoriesOptions {
  project?: string;
  targetRepo?: string;
  workspacePath?: string;
  // File the stories parked in `backlog` (waiting on a gate) instead of ready in `todo`.
  park?: boolean;
}

export async function fileStoriesToMultica(
  ticketId: string,
  epic: CompletedEpic,
  opts: FileStoriesOptions = {},
): Promise<{ filed: FiledStory[]; errors: Array<{ story_id: string; error: string }> }> {
  const filed: FiledStory[] = [];
  const errors: Array<{ story_id: string; error: string }> = [];

  // Resolve the PROJECT the filed stories must live in. A decomposed story is only ever picked
  // up by the Auriga router if it lands in a SCANNED project; when no --project is passed the
  // multica server drops these --parent'd sub-issues into a fallback project the router never
  // scans (the Mnemosyne-project orphan that stranded PAN-6939/40/41 — the whole plan invisible
  // to Auriga, todoUnassigned stuck at 0). Default to the SEED ticket's OWN project so a seed
  // dropped in Pantheon Core yields stories in Pantheon Core, where the router sees + dispatches
  // them. An explicit opts.project still overrides (caller knows best).
  let project = opts.project;
  if (!project) {
    try {
      const parent = (await pantheonRequest("GET", `/api/backlog/issues/${encodeURIComponent(ticketId)}`)) as Record<string, unknown>;
      if (parent && typeof parent.project_id === "string" && parent.project_id.length > 0) {
        project = parent.project_id;
      }
    } catch (e) {
      // Non-fatal: fall back to the API default project (legacy behavior) but record why, so a
      // stranded plan is diagnosable rather than silent.
      errors.push({ story_id: "(resolve-project)", error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Guarantee a build target for EVERY child story: the seed's explicitly-resolved target repo
  // (opts.targetRepo) when known, else derive it from the run WORKSPACE's own git origin remote —
  // the repo the plan actually ran against. This closes the gap where a seed that never declared an
  // explicit target_repo (greenfield/god-scoped resolution happened inside kickoff, not at the CLI)
  // left opts.targetRepo null, so stampTargetRepo no-op'd and children shipped with no target_repo.
  const effectiveTargetRepo =
    opts.targetRepo ?? (opts.workspacePath ? deriveRepoSlugFromWorkspace(opts.workspacePath) : null);

  // story_id -> created issue_id, and story_id -> its declared depends_on, tracked across the
  // whole epic so the dependency graph can be wired AFTER every sibling exists (a dependency may
  // be filed later in the loop than the story that depends on it).
  const idByStory = new Map<string, string>();
  const identifierByStory = new Map<string, string>();
  const dependsByStory = new Map<string, string[]>();
  const siblingIds = epic.stories.map((s) => s.id);
  for (const story of epic.stories) {
    const declared = parseStoryDependsOn(story);
    const prose = parseProseDependsOn(story, siblingIds).filter((d) => !declared.includes(d));
    dependsByStory.set(story.id, [...declared, ...prose].filter((d) => d !== story.id));
  }

  for (const story of orderStoriesForFiling(epic.stories, dependsByStory)) {
    const { title, description } = storyToIssueFields(story);
    // Stamp the seed's target repo onto every child story description (Gate-2), so the build
    // lane resolves the SAME repo for the decomposed work it resolved for the seed. Without this
    // a child story carries no target_repo and the build lane cannot resolve where to build it.
    // Then the Depends on line, built from the identifiers of the siblings already filed.
    const deps = (dependsByStory.get(story.id) ?? []).map((d) => ({ story_id: d, identifier: identifierByStory.get(d) ?? null }));
    const stampedDescription = appendBlock(stampTargetRepo(description, effectiveTargetRepo), dependencyBlock(deps));
    const createBody: Record<string, unknown> = {
      title,
      description: stampedDescription,
      status: opts.park ? "backlog" : "todo",
      parent: ticketId,
    };
    if (project) createBody.project = project;
    // Also carry the target repo as ticket metadata (the build lane's secondary signal), best-
    // effort — the description line above is the primary, CLI-readable signal.
    if (effectiveTargetRepo) createBody.metadata = { target_repo: effectiveTargetRepo };
    try {
      const created = (await pantheonRequest("POST", "/api/backlog/issues", createBody)) as Record<string, unknown>;
      const issueId = typeof created.id === "string" ? created.id : String(created.id ?? "");
      filed.push({ story_id: story.id, issue_id: issueId });
      if (issueId) idByStory.set(story.id, issueId);
      if (typeof created.identifier === "string" && created.identifier.length > 0) identifierByStory.set(story.id, created.identifier);
    } catch (e) {
      errors.push({ story_id: story.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Second pass: CARRY the depends_on DAG into Multica as per-issue metadata the Auriga router
  // reads to enforce ordering — it never dispatches a story whose dependency issues aren't done
  // (see depsSatisfied in the router's core). We store the resolved sibling ISSUE ids
  // (comma-separated string) under the `depends_on` metadata key. Best-effort per story: a
  // metadata failure is recorded but never aborts filing (the story itself is already filed).
  // The PUT replaces ALL metadata for the issue, so target_repo must be re-included here to
  // preserve the value set at creation time.
  for (const [storyId, deps] of dependsByStory) {
    const selfId = idByStory.get(storyId);
    if (!selfId) continue;
    const depIssueIds = deps
      .map((d) => idByStory.get(d))
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (depIssueIds.length === 0) continue;
    try {
      const metaBody: Record<string, unknown> = { depends_on: depIssueIds.join(",") };
      if (effectiveTargetRepo) metaBody.target_repo = effectiveTargetRepo;
      await pantheonRequest("PUT", `/api/backlog/issues/${encodeURIComponent(selfId)}/metadata`, metaBody);
    } catch (e) {
      errors.push({ story_id: storyId, error: `depends_on metadata: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  return { filed, errors };
}

// File the decomposed stories of EVERY epic a plan produced back to Multica as sub-issues of the
// origin ticket. A single headless /plan run routinely produces many epics (the real Votum seed
// produced 7 epics / 34 stories) -- the one-epic-per-run assumption that filed only the first epic
// silently dropped the rest. Each story carries an `epic_id` field so the aggregate result stays
// traceable to its source epic. Best-effort per story (a single failed create never aborts the
// rest); errors from every epic are aggregated into one report.
export async function fileAllStoriesToMultica(
  ticketId: string,
  epics: CompletedEpic[],
  opts: FileStoriesOptions = {},
): Promise<{ filed: Array<FiledStory & { epic_id: string }>; errors: Array<{ story_id: string; epic_id: string; error: string }> }> {
  const filed: Array<FiledStory & { epic_id: string }> = [];
  const errors: Array<{ story_id: string; epic_id: string; error: string }> = [];
  for (const epic of epics) {
    const r = await fileStoriesToMultica(ticketId, epic, opts);
    for (const f of r.filed) filed.push({ ...f, epic_id: epic.epic_id });
    for (const e of r.errors) errors.push({ ...e, epic_id: epic.epic_id });
  }
  return { filed, errors };
}

// Open the gate on stories filed with { park: true }: move each from `backlog` to `todo` via
// core-api's status route. Status only -- the stories stay unassigned, so Pantheon/Auriga assign
// and dispatch them. Best-effort per issue: one failed promote is reported, the rest still go.
export async function promoteParkedStories(
  issueIds: string[],
): Promise<{ promoted: string[]; errors: Array<{ issue_id: string; error: string }> }> {
  const promoted: string[] = [];
  const errors: Array<{ issue_id: string; error: string }> = [];
  for (const id of issueIds) {
    try {
      await pantheonRequest("POST", `/api/backlog/issues/${encodeURIComponent(id)}/status`, { status: "todo" });
      promoted.push(id);
    } catch (e) {
      errors.push({ issue_id: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { promoted, errors };
}
