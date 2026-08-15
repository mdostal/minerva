#!/usr/bin/env node
// turn-timeout-harness.mjs — test fixture only, used as a fake "claude" CLI (via a custom
// Heimdall route) by turn-timeout.test.ts. Ignores whatever argv ClaudeAdapter.formatTurnArgs
// built entirely -- instead counts its own invocations via HARNESS_COUNTER_FILE, so a test can
// script "hang past the turn timeout N times, then respond quickly" deterministically, with no
// real `claude` process or network call involved.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const counterFile = process.env.HARNESS_COUNTER_FILE;
const hangCount = Number(process.env.HARNESS_HANG_COUNT ?? "0");

let count = existsSync(counterFile) ? Number(readFileSync(counterFile, "utf8")) : 0;
count += 1;
writeFileSync(counterFile, String(count));

if (count <= hangCount) {
  setInterval(() => {}, 1000); // hang past the caller's timeout -- its own timer kills us
} else {
  // Mirrors the shape a real `claude -p --output-format json` call produces, with `result`
  // holding the combined question+classification --json-schema payload recordTurn() expects.
  const result = JSON.stringify({
    question: "fake question from turn-timeout harness",
    suggested_channel: "agent",
    confidence: 0.9,
    reason: "turn-timeout regression test",
  });
  process.stdout.write(
    JSON.stringify({
      is_error: false,
      stop_reason: "end_turn",
      session_id: randomUUID(),
      result,
    }),
  );
  process.exit(0);
}
