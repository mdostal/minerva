#!/usr/bin/env -S npx tsx
// bin/minerva — Minerva's CLI entrypoint, speaking the Pantheon subprocess ABI
// (JSON-over-stdio, {method,params} -> {result}/{error}, fresh process per call, exit 0/1).
// See docs/architecture.md AD-1.

import { dispatch } from "../src/dispatch.ts";
import { resumeFromConsusAnswer, resumeAnsweredConsusDecision } from "../src/consus-resume.ts";
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
    await mainArgs(process.argv.slice(2));
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
  let consusItemFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
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
      case "--consus-item-file":
        consusItemFile = nextValue(argv, i, flag);
        i++;
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

  const result = consusItemFile
    ? await resumeAnsweredConsusDecision({
        item: JSON.parse(readFileSync(consusItemFile, "utf8")),
        file_to_multica: params.file_to_multica === true,
        parent_issue_id: params.parent_issue_id,
        project: params.project,
        target_repo: params.target_repo,
      })
    : await resumeFromConsusAnswer(params);

  process.stdout.write(JSON.stringify({ result }, null, 2) + "\n");
  process.exit(0);
}

const ARG_HELP = `minerva — JSON-over-stdio by default, plus Consus resume shorthand

  minerva --resume <run_id> --question <question_id> --answer "<answer>" [--channel human|agent]
          [--file-to-multica --parent <issue_id>] [--project <project_id>] [--target-repo owner/repo]

  minerva --consus-item-file <path.json> [--file-to-multica --parent <issue_id>]
`;

main();
