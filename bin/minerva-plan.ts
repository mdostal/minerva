#!/usr/bin/env -S npx tsx
// bin/minerva-plan — the router-facing HEADLESS "plan this ticket/idea" entry (prebaked-plan-
// defaults epic, Auriga-integration slice). This is the exact command Auriga (or the `minerva-dev`
// Multica agent it routes an un-planned ticket to) invokes non-interactively:
//
//   minerva-plan --ticket <multica-issue-id> [--target-repo <path>] [--file-to-multica] [--commit] [--push]
//   minerva-plan --idea-brief <path>          [--mode auto|agent|off] [--json]
//   minerva-plan --idea "<text>"              [--target-repo <path>]  [--json]
//
// It resolves the idea (from a Multica ticket, an idea-brief file, or a literal string), drives
// plugin-hive kickoff+plan headlessly with Minerva's pre-baked defaults (mode: auto by default, so
// it completes unattended), writes the .pHive epic+stories into the run workspace, and — with
// --file-to-multica — files each decomposed story back to Multica as a sub-issue of the origin
// ticket (linked; left unassigned per standing policy). Only those PLANNED stories then become
// dev-agent work items. Prints a human summary (or --json for a machine-readable result).
//
// Exit code: 0 when the plan completed (and, if requested, stories were filed); 2 when the plan
// parked on a genuine human gate that had no pre-baked default (so a router can escalate to
// Delphi/a human); 1 on error.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runHeadlessPlan, resolveIdeaFromTicket, fileAllStoriesToMultica } from "../src/plan-runner.ts";
import { resolveLocalCheckout, deriveRepoSlugFromWorkspace } from "../src/target-repo-signal.ts";
import type { PlanDefaultsMode } from "../src/plan-defaults.ts";

interface Args {
  ticket?: string;
  ideaBrief?: string;
  idea?: string;
  targetRepo?: string;
  mode: PlanDefaultsMode;
  project?: string;
  fileToMultica: boolean;
  commit: boolean;
  push: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { mode: "auto", fileToMultica: false, commit: false, push: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${flag}`);
      return v;
    };
    switch (flag) {
      case "--ticket": a.ticket = next(); break;
      case "--idea-brief": a.ideaBrief = next(); break;
      case "--idea": a.idea = next(); break;
      case "--target-repo": a.targetRepo = next(); break;
      case "--mode": a.mode = next() as PlanDefaultsMode; break;
      case "--project": a.project = next(); break;
      case "--file-to-multica": a.fileToMultica = true; break;
      case "--commit": a.commit = true; break;
      case "--push": a.push = true; break;
      case "--json": a.json = true; break;
      case "-h": case "--help":
        process.stdout.write(HELP);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return a;
}

const HELP = `minerva-plan — headless "plan this ticket/idea" entry (Auriga-invokable)

  --ticket <id>          plan a Multica issue (fetched via the multica CLI)
  --idea-brief <path>    plan an idea-brief file
  --idea "<text>"        plan a literal idea string
  --target-repo <path>   plan against an existing repo (worktree off dev); omit = greenfield
  --mode <auto|agent|off>  pre-baked-defaults mode (default: auto = fully unattended)
  --project <id>         Multica project id for filed story sub-issues
  --file-to-multica      file decomposed stories back to Multica as sub-issues of the ticket
  --commit               commit the .pHive epic+stories in the run workspace
  --push                 push the run workspace branch to origin (durable; needs a remote)
  --json                 emit a machine-readable JSON result
`;

// Best-effort commit of the produced .pHive epic+stories in the run workspace. The run workspace
// is either a worktree on branch run/<run_id> off the target repo's dev (idea targets a repo), or
// a fresh scratch git repo (greenfield). Never throws -- durability failures are reported, not
// fatal to the plan itself.
function commitWorkspace(workspacePath: string, ideaLabel: string): { committed: boolean; error?: string } {
  try {
    execFileSync("git", ["-C", workspacePath, "add", "-A", ".pHive"], { stdio: "pipe" });
    execFileSync("git", ["-C", workspacePath, "commit", "-q", "-m", `plan: ${ideaLabel} -- Minerva headless kickoff+plan output`], { stdio: "pipe" });
    return { committed: true };
  } catch (e) {
    return { committed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function pushWorkspace(workspacePath: string, runId: string): { pushed: boolean; branch?: string; error?: string } {
  try {
    const branch = execFileSync("git", ["-C", workspacePath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", workspacePath, "push", "-u", "origin", branch], { stdio: "pipe" });
    return { pushed: true, branch };
  } catch (e) {
    return { pushed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Resolve the idea from exactly one source.
  const sources = [args.ticket, args.ideaBrief, args.idea].filter((v) => v !== undefined);
  if (sources.length !== 1) {
    throw new Error("Provide exactly one of --ticket, --idea-brief, or --idea");
  }

  let idea: string;
  let ideaLabel: string;
  let ticketTargetRepo: string | null = null;
  if (args.ticket !== undefined) {
    const resolved = resolveIdeaFromTicket(args.ticket);
    idea = resolved.idea;
    ideaLabel = resolved.title || `ticket ${args.ticket}`;
    ticketTargetRepo = resolved.targetRepo;
  } else if (args.ideaBrief !== undefined) {
    idea = readFileSync(args.ideaBrief, "utf8");
    ideaLabel = args.ideaBrief;
  } else {
    idea = args.idea!;
    ideaLabel = idea.slice(0, 60);
  }

  // Resolve the build target repo for this seed (Gate-2). Explicit --target-repo (CLI) wins;
  // otherwise the ticket's OWN declared target_repo (metadata or a `target_repo:` line in the
  // description) drives it. A slug/URL is cloned on demand into a local checkout (with a `dev`
  // branch) so the finished plan is committed+pushed into that real repo, and the slug is stamped
  // onto every filed child story so the build lane builds each in the same repo.
  let targetRepoPath: string | undefined = args.targetRepo;
  let targetRepoSlug: string | null = null;
  const declaredTarget = args.targetRepo ?? ticketTargetRepo ?? null;
  if (declaredTarget) {
    const checkout = resolveLocalCheckout(declaredTarget);
    targetRepoPath = checkout.localPath;
    targetRepoSlug = checkout.slug;
  }

  const result = await runHeadlessPlan({
    idea,
    ...(targetRepoPath ? { targetRepo: targetRepoPath } : {}),
    mode: args.mode, pollConsusForAnswers: true,
    ...(args.ticket ? { ticketId: args.ticket } : {}),
  });

  const totalStories = result.epics.reduce((n, e) => n + e.stories.length, 0);
  const report: Record<string, unknown> = {
    run_id: result.run_id,
    status: result.status,
    workspace_path: result.workspace_path,
    epic_id: result.epic?.epic_id ?? null, // first epic (backward compat)
    epic_ids: result.epics.map((e) => e.epic_id), // ALL epics this plan produced
    epic_count: result.epics.length,
    story_count: totalStories, // total across all epics
  };

  // Parked on a genuine gate with no pre-baked default -> surface for escalation, exit 2.
  if (result.status !== "complete" || result.epics.length === 0) {
    report.pending_questions = result.pending_questions.map((q) => ({ id: q.id, text: q.text, channel: q.channel }));
    emit(args, report, `Plan did NOT complete (status: ${result.status}). Parked on ${result.pending_questions.length} gate(s) needing escalation.`);
    process.exit(2);
  }

  // Durability: commit (+ optionally push) the .pHive output in the run workspace.
  if (args.commit || args.push) {
    const c = commitWorkspace(result.workspace_path, ideaLabel);
    report.commit = c;
    if (args.push && c.committed) report.push = pushWorkspace(result.workspace_path, result.run_id);
  }

  // File the decomposed stories of EVERY produced epic back to Multica as sub-issues of the origin
  // ticket. Multi-epic plans (the norm) file all of their stories, not just the first epic's.
  if (args.fileToMultica) {
    if (!args.ticket) throw new Error("--file-to-multica requires --ticket (the parent to link sub-issues under)");
    const filed = fileAllStoriesToMultica(args.ticket, result.epics, {
      ...(args.project ? { project: args.project } : {}),
      ...(targetRepoSlug ? { targetRepo: targetRepoSlug } : {}),
      // The run workspace's own origin remote is the guaranteed fallback build target, so every
      // filed child story carries target_repo even when the seed declared none explicitly.
      workspacePath: result.workspace_path,
    });
    report.filed_stories = filed.filed;
    report.file_errors = filed.errors;
    report.target_repo =
      targetRepoSlug ?? deriveRepoSlugFromWorkspace(result.workspace_path) ?? targetRepoPath ?? null;
  }

  emit(
    args,
    report,
    `Planned '${ideaLabel}' -> ${result.epics.length} epic(s) [${result.epics.map((e) => e.epic_id).join(", ")}] ` +
      `with ${totalStories} stories total` +
      (args.fileToMultica ? ` (filed ${(report.filed_stories as unknown[] | undefined)?.length ?? 0} to Multica)` : ""),
  );
}

function emit(args: Args, report: Record<string, unknown>, human: string): void {
  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(human + "\n");
    if (report.filed_stories) {
      for (const f of report.filed_stories as Array<{ story_id: string; issue_id: string }>) {
        process.stdout.write(`  filed ${f.story_id} -> issue ${f.issue_id}\n`);
      }
    }
  }
}

main().catch((e) => {
  process.stderr.write(`minerva-plan error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
