// Consus resume integration — bridges an answered Consus decision back into a parked Minerva run.
//
// The core ABI remains provider-neutral (`submitAnswers`, `getOutput`). This module is the thin
// Multica/Consus-aware hook path: a watcher can hand us an answered Consus item, we resume the
// awaiting run with that answer, and if the run reaches completion we file the resulting stories.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { MinervaError } from "./errors.ts";
import { submitAnswers } from "./kickoff-engine.ts";
import { getRunStatus, type Channel } from "./run-manager.ts";
import { getOutput, type CompletedEpic } from "./output-emitter.ts";

export interface FiledStory {
  story_id: string;
  issue_id: string;
}

export interface ResumeFromConsusAnswerParams {
  run_id: string;
  question_id: string;
  channel: Channel;
  answer: string | string[];
  file_to_multica?: boolean;
  parent_issue_id?: string;
  project?: string;
  target_repo?: string;
}

export interface ResumeResult extends Record<string, unknown> {
  run_id: string;
  status: string;
  resumed: boolean;
  filed_stories: Array<FiledStory & { epic_id: string }>;
  file_errors: Array<{ story_id: string; epic_id: string; error: string }>;
  reason?: string;
}

interface ResumeDeps {
  submitAnswers: typeof submitAnswers;
  getRunStatus: typeof getRunStatus;
  getOutput: typeof getOutput;
  fileAllStoriesToMultica: typeof fileAllStoriesToMultica;
}

let _multicaRunner = (args: string[]): any => {
  const out = execFileSync("multica", args, { encoding: "utf8" });
  return out.trim() ? JSON.parse(out) : null;
};

function multicaJson(args: string[]): any {
  return _multicaRunner(args);
}

export function __setMulticaRunnerForTest(fn: (args: string[]) => any): (args: string[]) => any {
  const prev = _multicaRunner;
  _multicaRunner = fn;
  return prev;
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MinervaError("VALIDATION_FAILED", `${name} must be a non-empty string`);
  }
  return value;
}

function assertChannel(value: unknown): Channel {
  if (value !== "agent" && value !== "human") {
    throw new MinervaError("VALIDATION_FAILED", 'channel must be "agent" or "human"');
  }
  return value;
}

function assertAnswer(value: unknown): string | string[] {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) return value;
  throw new MinervaError("VALIDATION_FAILED", "answer must be a non-empty string or string[]");
}

function normalizeParams(params: Record<string, unknown>): ResumeFromConsusAnswerParams {
  return {
    run_id: assertString(params.run_id, "run_id"),
    question_id: assertString(params.question_id, "question_id"),
    channel: assertChannel(params.channel),
    answer: assertAnswer(params.answer),
    file_to_multica: params.file_to_multica === true,
    parent_issue_id: typeof params.parent_issue_id === "string" ? params.parent_issue_id : undefined,
    project: typeof params.project === "string" ? params.project : undefined,
    target_repo: typeof params.target_repo === "string" ? params.target_repo : undefined,
  };
}

function outputEpics(output: Record<string, unknown>): CompletedEpic[] {
  if (Array.isArray(output.epics)) return output.epics as CompletedEpic[];
  return output.epic ? [output.epic as CompletedEpic] : [];
}

const realDeps: ResumeDeps = {
  submitAnswers,
  getRunStatus,
  getOutput,
  fileAllStoriesToMultica,
};

export async function resumeFromConsusAnswer(
  rawParams: Record<string, unknown>,
  deps: ResumeDeps = realDeps,
): Promise<ResumeResult> {
  const params = normalizeParams(rawParams);
  if (params.file_to_multica && !params.parent_issue_id) {
    throw new MinervaError("VALIDATION_FAILED", "parent_issue_id is required when file_to_multica is true");
  }

  const before = deps.getRunStatus({ run_id: params.run_id }) as { status: string };
  if (before.status !== "waiting_on_human" && before.status !== "awaiting-consus") {
    return {
      run_id: params.run_id,
      status: before.status,
      resumed: false,
      filed_stories: [],
      file_errors: [],
      reason: `run is ${before.status}, not waiting_on_human or awaiting-consus`,
    };
  }

  await deps.submitAnswers({
    run_id: params.run_id,
    channel: params.channel,
    answers: [{ question_id: params.question_id, answer: params.answer }],
  });

  const after = deps.getRunStatus({ run_id: params.run_id }) as { status: string };
  const result: ResumeResult = {
    run_id: params.run_id,
    status: after.status,
    resumed: true,
    filed_stories: [],
    file_errors: [],
  };

  if (after.status === "complete" && params.file_to_multica) {
    const output = deps.getOutput({ run_id: params.run_id });
    const filed = deps.fileAllStoriesToMultica(params.parent_issue_id!, outputEpics(output), {
      project: params.project,
      targetRepo: params.target_repo,
    });
    result.filed_stories = filed.filed;
    result.file_errors = filed.errors;
  }

  return result;
}

export function storyToIssueFields(story: { id: string; content: string }): { title: string; description: string } {
  let storyTitle = story.id;
  try {
    const parsed = parseYaml(story.content) as any;
    if (parsed && typeof parsed.title === "string" && parsed.title.trim().length > 0) {
      storyTitle = parsed.title.trim();
    }
  } catch {
    // Keep the story id fallback for malformed story content.
  }
  return { title: `[${story.id}] ${storyTitle}`, description: story.content };
}

function stampTargetRepo(description: string, targetRepo: string | undefined): string {
  if (!targetRepo || /^[ \t]*target_repo[ \t]*:/im.test(description)) return description;
  const sep = description.length > 0 && !description.endsWith("\n") ? "\n" : "";
  return `${description}${sep}target_repo: ${targetRepo}\n`;
}

export function fileStoriesToMultica(
  parentIssueId: string,
  epic: CompletedEpic,
  opts: { project?: string; targetRepo?: string } = {},
): { filed: FiledStory[]; errors: Array<{ story_id: string; error: string }> } {
  const filed: FiledStory[] = [];
  const errors: Array<{ story_id: string; error: string }> = [];
  const tmp = mkdtempSync(join(tmpdir(), "minerva-consus-story-"));

  try {
    for (const story of epic.stories) {
      const { title, description } = storyToIssueFields(story);
      const descFile = join(tmp, `${story.id}.txt`);
      writeFileSync(descFile, stampTargetRepo(description, opts.targetRepo));

      const args = [
        "issue",
        "create",
        "--parent",
        parentIssueId,
        "--title",
        title,
        "--description-file",
        descFile,
        "--status",
        "todo",
        "--output",
        "json",
      ];
      if (opts.project) args.push("--project", opts.project);

      try {
        const created = multicaJson(args);
        const issueId = typeof created?.id === "string" ? created.id : String(created?.id ?? "");
        filed.push({ story_id: story.id, issue_id: issueId });
        if (issueId && opts.targetRepo) {
          try {
            multicaJson([
              "issue",
              "metadata",
              "set",
              issueId,
              "--key",
              "target_repo",
              "--value",
              opts.targetRepo,
              "--type",
              "string",
              "--output",
              "json",
            ]);
          } catch (e) {
            errors.push({ story_id: story.id, error: `target_repo metadata: ${e instanceof Error ? e.message : String(e)}` });
          }
        }
      } catch (e) {
        errors.push({ story_id: story.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  return { filed, errors };
}

export function fileAllStoriesToMultica(
  parentIssueId: string,
  epics: CompletedEpic[],
  opts: { project?: string; targetRepo?: string } = {},
): { filed: Array<FiledStory & { epic_id: string }>; errors: Array<{ story_id: string; epic_id: string; error: string }> } {
  const filed: Array<FiledStory & { epic_id: string }> = [];
  const errors: Array<{ story_id: string; epic_id: string; error: string }> = [];

  for (const epic of epics) {
    const result = fileStoriesToMultica(parentIssueId, epic, opts);
    for (const story of result.filed) filed.push({ ...story, epic_id: epic.epic_id });
    for (const error of result.errors) errors.push({ ...error, epic_id: epic.epic_id });
  }

  return { filed, errors };
}

function readPath(obj: any, keys: string[]): unknown {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function extractThreadAnswer(item: any, questionId: string): string | null {
  const thread = item?.threads?.[questionId];
  if (!Array.isArray(thread)) return null;
  for (let i = thread.length - 1; i >= 0; i--) {
    const msg = thread[i];
    if (msg?.role === "human" && typeof msg.text === "string" && msg.text.trim().length > 0) {
      return msg.text.trim();
    }
  }
  return null;
}

// Exported so consus-poller.ts's poll path can parse the same Consus item shape a pushed webhook
// item carries (a poll and a push both fetch/receive the identical shape) without duplicating
// this parsing logic.
export function extractAnswerFromItem(item: any, questionId: string): string | string[] | null {
  const direct = readPath(item, ["answer", "value"]);
  if (typeof direct === "string" || Array.isArray(direct)) return direct as string | string[];

  const answerEntry = item?.answers?.[questionId];
  if (typeof answerEntry === "string" || Array.isArray(answerEntry)) return answerEntry as string | string[];
  if (answerEntry && typeof answerEntry === "object") {
    const value = (answerEntry as any).value;
    if (typeof value === "string" || Array.isArray(value)) return value as string | string[];
  }

  const threaded = extractThreadAnswer(item, questionId);
  if (threaded) return threaded;

  if (item?.decided && typeof item.decided.rationale === "string" && item.decided.rationale.trim().length > 0) {
    return item.decided.rationale.trim();
  }
  if (item?.decided && typeof item.decided.choice === "string" && item.decided.choice.trim().length > 0) {
    return item.decided.choice.trim();
  }

  return null;
}

export function extractAnsweredConsusDecision(item: unknown): ResumeFromConsusAnswerParams | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as any;
  const payload = raw.decision_payload ?? raw.payload?.decision_payload ?? raw.payload ?? {};
  const runId = readPath(payload, ["run_id", "runId"]) ?? readPath(raw, ["run_id", "runId"]);
  const questionId = readPath(payload, ["question_id", "questionId"]) ?? readPath(raw, ["question_id", "questionId"]);
  if (typeof runId !== "string" || typeof questionId !== "string") return null;

  const kind = typeof payload.kind === "string" ? payload.kind : "";
  if (kind && !["minerva_run_question", "minerva-plan-question", "minerva_plan_question"].includes(kind)) {
    return null;
  }

  const answer = extractAnswerFromItem(raw, questionId);
  if (answer === null) return null;

  return {
    run_id: runId,
    question_id: questionId,
    channel: assertChannel(readPath(payload, ["channel"]) ?? readPath(raw, ["channel"]) ?? "human"),
    answer,
    parent_issue_id:
      typeof payload.parent_issue_id === "string"
        ? payload.parent_issue_id
        : typeof payload.ticket_id === "string"
          ? payload.ticket_id
          : typeof payload.ticket === "string"
            ? payload.ticket
            : undefined,
    project: typeof payload.project === "string" ? payload.project : undefined,
    target_repo: typeof payload.target_repo === "string" ? payload.target_repo : undefined,
  };
}

export async function resumeAnsweredConsusDecision(
  rawParams: Record<string, unknown>,
  deps: ResumeDeps = realDeps,
): Promise<ResumeResult> {
  const item = rawParams.item;
  const extracted = extractAnsweredConsusDecision(item);
  if (!extracted) {
    return {
      run_id: "",
      status: "waiting_on_human",
      resumed: false,
      filed_stories: [],
      file_errors: [],
      reason: "Consus item is not an answered Minerva run decision",
    };
  }
  return resumeFromConsusAnswer(
    {
      ...extracted,
      file_to_multica: rawParams.file_to_multica === true,
      parent_issue_id: rawParams.parent_issue_id ?? extracted.parent_issue_id,
      project: rawParams.project ?? extracted.project,
      target_repo: rawParams.target_repo ?? extracted.target_repo,
    },
    deps,
  );
}
