#!/usr/bin/env -S npx tsx
// bin/minerva — Minerva's CLI entrypoint, speaking the Pantheon subprocess ABI
// (JSON-over-stdio, {method,params} -> {result}/{error}, fresh process per call, exit 0/1).
// See docs/architecture.md AD-1.

import { dispatch } from "../src/dispatch.ts";

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

main();
