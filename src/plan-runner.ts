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
// All Multica interaction shells out to the installed `multica` CLI — Minerva never embeds a
// Multica client of its own.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { startRun } from "./kickoff-engine.ts";
import { getRunStatus, readRunRecord, type Question } from "./run-manager.ts";
import { getOutput } from "./output-emitter.ts";
import type { CompletedEpic } from "./output-emitter.ts";
import type { PlanDefaultsMode } from "./plan-defaults.ts";

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

// --- Multica integration (shell-out to the `multica` CLI) ------------------------------------

function multicaJson(args: string[]): any {
  const out = execFileSync("multica", args, { encoding: "utf8" });
  return JSON.parse(out);
}

// Resolve an idea brief from a Multica ticket: `title` + `description`, joined into the prose the
// kickoff skill expects. Throws if the ticket can't be read/parsed -- a router must not silently
// plan an empty idea.
export function resolveIdeaFromTicket(ticketId: string): { idea: string; title: string } {
  const issue = multicaJson(["issue", "get", ticketId, "--output", "json"]);
  const title = typeof issue.title === "string" ? issue.title : "";
  const description = typeof issue.description === "string" ? issue.description : "";
  const idea = [title, description].filter((s) => s.trim().length > 0).join("\n\n");
  if (idea.trim().length === 0) {
    throw new Error(`Multica ticket ${ticketId} has no title/description to plan from`);
  }
  return { idea, title };
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

export interface FiledStory {
  story_id: string;
  issue_id: string;
}

// File each decomposed story back to Multica as a sub-issue of the origin ticket (linkage via
// --parent), leaving them UNASSIGNED per the standing operator policy (Mathew assigns manually;
// mirrors consus-dev/heimdall-dev instructions). Only the planned stories become dev-agent work
// items -- exactly the "only PLANNED stories go to dev agents" flow. Returns the created issue
// ids. Best-effort per story: a single failed create is reported but does not abort the rest.
export function fileStoriesToMultica(
  ticketId: string,
  epic: CompletedEpic,
  opts: { project?: string } = {},
): { filed: FiledStory[]; errors: Array<{ story_id: string; error: string }> } {
  const filed: FiledStory[] = [];
  const errors: Array<{ story_id: string; error: string }> = [];
  const tmp = mkdtempSync(join(tmpdir(), "minerva-story-"));
  try {
    for (const story of epic.stories) {
      const { title, description } = storyToIssueFields(story);
      const descFile = join(tmp, `${story.id}.txt`);
      writeFileSync(descFile, description);
      const args = [
        "issue",
        "create",
        "--parent",
        ticketId,
        "--title",
        title,
        "--description-file",
        descFile,
        "--output",
        "json",
      ];
      if (opts.project) args.push("--project", opts.project);
      try {
        const created = multicaJson(args);
        const issueId = typeof created.id === "string" ? created.id : String(created.id ?? "");
        filed.push({ story_id: story.id, issue_id: issueId });
      } catch (e) {
        errors.push({ story_id: story.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { filed, errors };
}

// File the decomposed stories of EVERY epic a plan produced back to Multica as sub-issues of the
// origin ticket. A single headless /plan run routinely produces many epics (the real Votum seed
// produced 7 epics / 34 stories) -- the one-epic-per-run assumption that filed only the first epic
// silently dropped the rest. Each story carries an `epic_id` field so the aggregate result stays
// traceable to its source epic. Best-effort per story (a single failed create never aborts the
// rest); errors from every epic are aggregated into one report.
export function fileAllStoriesToMultica(
  ticketId: string,
  epics: CompletedEpic[],
  opts: { project?: string } = {},
): { filed: Array<FiledStory & { epic_id: string }>; errors: Array<{ story_id: string; epic_id: string; error: string }> } {
  const filed: Array<FiledStory & { epic_id: string }> = [];
  const errors: Array<{ story_id: string; epic_id: string; error: string }> = [];
  for (const epic of epics) {
    const r = fileStoriesToMultica(ticketId, epic, opts);
    for (const f of r.filed) filed.push({ ...f, epic_id: epic.epic_id });
    for (const e of r.errors) errors.push({ ...e, epic_id: epic.epic_id });
  }
  return { filed, errors };
}
