// run-record-harness.ts — test fixture only, spawned as a child process by
// run-record-concurrency.test.ts. Each ABI call is its own process in production, so run.yaml
// races are cross-process races; this harness is one such process.
//
//   patch <run_id> <field> <iterations>  -- updateRunRecord({ [field]: i }) for i = 1..iterations
//   update <run_id> <json_patch>         -- a single updateRunRecord(patch)

import { updateRunRecord, type RunRecord } from "./run-manager.ts";

const [mode, runId, ...rest] = process.argv.slice(2);

if (mode === "patch") {
  const [field, iterations] = rest;
  for (let i = 1; i <= Number(iterations); i++) {
    updateRunRecord(runId!, { [field!]: i } as Partial<RunRecord>);
  }
} else if (mode === "update") {
  updateRunRecord(runId!, JSON.parse(rest[0]!) as Partial<RunRecord>);
} else {
  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exit(2);
}
