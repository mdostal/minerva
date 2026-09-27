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

export interface PlanRequest {
  idea: string;
  targetRepo?: string;
  mode?: PlanDefaultsMode; // default "auto" -- fully unattended; the whole point of this entry
  defaults?: Record<string, unknown>; // extra per-run plan-defaults overrides (merged over mode)
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
// "auto" so a routed ticket plans fully unattended.
export async function runHeadlessPlan(req: PlanRequest): Promise<PlanResult> {
  const defaults = { mode: req.mode ?? "auto", ...(req.defaults ?? {}) };
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

function getPantheonCoreApiUrl(): string | null {
  return process.env.MINERVA_PANTHEON_CORE_API_URL ?? process.env.PANTHEON_CORE_API_URL ?? null;
}

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
  const baseUrl = getPantheonCoreApiUrl();
  if (!baseUrl) {
    throw new Error(
      "Pantheon core-api URL not configured: set PANTHEON_CORE_API_URL or MINERVA_PANTHEON_CORE_API_URL",
    );
  }
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  const init: { method: string; headers?: Record<string, string>; body?: string } =
    body !== undefined
      ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : { method };
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

export interface FiledStory {
  story_id: string;
  issue_id: string;
}

// File each decomposed story back to Multica as a sub-issue of the origin ticket via Pantheon's
// core-api (POST /api/backlog/issues), leaving them UNASSIGNED per the standing operator policy
// (Mathew assigns manually; mirrors consus-dev/heimdall-dev instructions). Only the planned
// stories become dev-agent work items -- exactly the "only PLANNED stories go to dev agents" flow.
// Returns the created issue ids. Best-effort per story: a single failed create is reported but
// does not abort the rest.
export async function fileStoriesToMultica(
  ticketId: string,
  epic: CompletedEpic,
  opts: { project?: string; targetRepo?: string; workspacePath?: string } = {},
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
  const dependsByStory = new Map<string, string[]>();

  for (const story of epic.stories) {
    const { title, description } = storyToIssueFields(story);
    dependsByStory.set(story.id, parseStoryDependsOn(story));
    // Stamp the seed's target repo onto every child story description (Gate-2), so the build
    // lane resolves the SAME repo for the decomposed work it resolved for the seed. Without this
    // a child story carries no target_repo and the build lane cannot resolve where to build it.
    const stampedDescription = stampTargetRepo(description, effectiveTargetRepo);
    const createBody: Record<string, unknown> = {
      title,
      description: stampedDescription,
      status: "todo",
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
  opts: { project?: string; targetRepo?: string; workspacePath?: string } = {},
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
