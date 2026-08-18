#!/usr/bin/env -S npx tsx
// bin/minerva — Minerva's CLI entrypoint, speaking the Pantheon subprocess ABI
// (JSON-over-stdio, {method,params} -> {result}/{error}, fresh process per call, exit 0/1).
// See docs/architecture.md AD-1.

import { dispatch } from "../src/dispatch.ts";
import { submitAnswers } from "../src/kickoff-engine.ts";
import { getRunStatus, type Channel } from "../src/run-manager.ts";
import { getOutput, type CompletedEpic } from "../src/output-emitter.ts";
import { fileAllStoriesToMultica } from "../src/plan-runner.ts";
import { runStdioServer } from "../src/mcp-server.ts";
import { agentInit, agentStatus } from "../src/agent-setup.ts";
import { readFileSync } from "node:fs";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  if (process.argv.length > 2) {
    const argv = process.argv.slice(2);
    // "mcp" was previously unreachable (mainArgs's flag parser throws "Unknown argument" for
    // anything that isn't a --flag it recognizes) -- safe, backward-compatible extension point,
    // no existing caller could have relied on this positional word meaning anything.
    if (argv[0] === "mcp") {
      await runStdioServer();
      return;
    }
    // Same backward-compatible extension point as "mcp" above -- "agent" was previously an
    // unrecognized flag that threw.
    if (argv[0] === "agent") {
      await mainAgent(argv.slice(1));
      return;
    }
    await mainArgs(argv);
    return;
  }

  const raw = await readStdin();

  let req: unknown;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    process.stdout.write(
      JSON.stringify({
        error: {
          code: "VALIDATION_FAILED",
          message: `Malformed JSON on stdin: ${e instanceof Error ? e.message : String(e)}`,
          retry_after_ms: null,
        },
      }),
    );
    process.exit(1);
  }

  const response = await dispatch(req);
  process.stdout.write(JSON.stringify(response));
  process.exit("error" in response ? 1 : 0);
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined) throw new Error(`Missing value for ${flag}`);
  return value;
}

async function mainArgs(argv: string[]): Promise<void> {
  const params: Record<string, unknown> = {};

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case "--run":
        params.run_id = nextValue(argv, i, flag);
        i++;
        break;
      case "--resume":
        params.run_id = nextValue(argv, i, flag);
        i++;
        break;
      case "--question":
        params.question_id = nextValue(argv, i, flag);
        i++;
        break;
      case "--channel":
        params.channel = nextValue(argv, i, flag);
        i++;
        break;
      case "--answer":
        params.answer = nextValue(argv, i, flag);
        i++;
        break;
      case "--answer-file":
        params.answer = readFileSync(nextValue(argv, i, flag), "utf8").trim();
        i++;
        break;
      case "--parent":
        params.parent_issue_id = nextValue(argv, i, flag);
        i++;
        break;
      case "--project":
        params.project = nextValue(argv, i, flag);
        i++;
        break;
      case "--target-repo":
        params.target_repo = nextValue(argv, i, flag);
        i++;
        break;
      case "--file-to-multica":
        params.file_to_multica = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(ARG_HELP);
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }

  if (!params.channel) params.channel = "human";

  const result = await resumeRun(params);

  process.stdout.write(JSON.stringify({ result }, null, 2) + "\n");
  process.exit(0);
}

// `minerva agent init` / `minerva agent status` -- detect installed agent CLIs (Claude Code,
// Codex CLI), register the MCP server for each, install the usage skill(s). Idempotent, safe to
// re-run any time (e.g. after installing a new harness). `--harness <name>` narrows either
// subcommand to just that one harness.
async function mainAgent(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== "init" && sub !== "status") {
    process.stdout.write(AGENT_HELP);
    process.exit(sub === "-h" || sub === "--help" ? 0 : 1);
  }

  let harness: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--harness") {
      harness = nextValue(argv, i, "--harness");
      i++;
    } else {
      throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }

  const result =
    sub === "init" ? agentInit(harness ? [harness] : undefined) : agentStatus(harness ? [harness] : undefined);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}

const AGENT_HELP = `minerva agent — one-command onboarding for agent/harness CLIs

  minerva agent init [--harness claude|codex]     detect harnesses, register the MCP server, install usage skills
  minerva agent status [--harness claude|codex]   report current state without changing anything
`;

// Resume a parked run by answering its pending question, then optionally file the resulting
// stories to Multica. Built entirely on the core provider-neutral ABI (submitAnswers/
// getRunStatus/getOutput) plus plan-runner.ts's own Multica-filing helper -- no dependency on any
// external decision-routing service, so --file-to-multica keeps working standalone.
async function resumeRun(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const runId = params.run_id;
  const questionId = params.question_id;
  const channel = params.channel;
  const answer = params.answer;
  if (typeof runId !== "string" || typeof questionId !== "string" || typeof answer !== "string") {
    throw new Error("--resume/--run, --question, and --answer/--answer-file are all required");
  }
  if (channel !== "agent" && channel !== "human") {
    throw new Error('--channel must be "agent" or "human"');
  }

  const fileToMultica = params.file_to_multica === true;
  const parentIssueId = typeof params.parent_issue_id === "string" ? params.parent_issue_id : undefined;
  if (fileToMultica && !parentIssueId) {
    throw new Error("--file-to-multica requires --parent <issue_id>");
  }

  await submitAnswers({
    run_id: runId,
    channel: channel as Channel,
    answers: [{ question_id: questionId, answer }],
  });

  const after = getRunStatus({ run_id: runId }) as { status: string };
  const result: Record<string, unknown> = {
    run_id: runId,
    status: after.status,
    resumed: true,
    filed_stories: [],
    file_errors: [],
  };

  if (after.status === "complete" && fileToMultica) {
    const output = getOutput({ run_id: runId }) as { epic: CompletedEpic | null; epics?: CompletedEpic[] };
    const epics = output.epics ?? (output.epic ? [output.epic] : []);
    const filed = fileAllStoriesToMultica(parentIssueId!, epics, {
      project: typeof params.project === "string" ? params.project : undefined,
      targetRepo: typeof params.target_repo === "string" ? params.target_repo : undefined,
    });
    result.filed_stories = filed.filed;
    result.file_errors = filed.errors;
  }

  return result;
}

const ARG_HELP = `minerva — JSON-over-stdio

  minerva --resume <run_id> --question <question_id> --answer "<answer>" [--channel human|agent]
          [--file-to-multica --parent <issue_id>] [--project <project_id>] [--target-repo owner/repo]
  minerva mcp                 run as an MCP server (stdio transport) exposing the full ABI as tools
  minerva agent init          detect installed agent CLIs, register the MCP server, install usage skills
  minerva agent status        report what's currently registered/installed, without changing anything
`;

main();
