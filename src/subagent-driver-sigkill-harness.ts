// subagent-driver-sigkill-harness.ts — test fixture only, spawned as a child process by
// subagent-driver.test.ts. Proves the exact property this epic exists to fix: a --bg session
// survives its launching process being killed. Dispatches via the same `claude --bg` mechanism
// SubagentDriver itself uses, prints the assigned short id the instant dispatch succeeds (so
// the test can synchronize on real output instead of guessing a wall-clock delay), then hangs
// indefinitely -- deliberately never reaching SubagentDriver's own poll/stop/extract steps, so
// the test controls exactly when this process dies relative to the dispatch having succeeded.

import { execFileSync } from "node:child_process";

const MODEL = process.env.MINERVA_DRIVE_MODEL ?? "claude-haiku-4-5-20251001";
const prompt = process.argv[2] ?? "Say hello.";

const out = execFileSync(
  "claude",
  ["--bg", "--model", MODEL, "--permission-mode", "bypassPermissions", prompt],
  { encoding: "utf8" },
);

const match = out.match(/backgrounded\s*[·:]\s*(\S+)/);
process.stdout.write(`DISPATCHED:${match?.[1] ?? "UNKNOWN"}\n`);

setInterval(() => {}, 1000); // hang -- the test kills us here, well before we'd ever call `stop`
