// subagent-driver-sigkill-harness.ts — test fixture only, spawned as a child process by
// subagent-driver.test.ts. Proves the exact property this epic exists to fix: a --bg session
// survives its launching process being killed. Dispatches via the same routed `--bg` mechanism
// SubagentDriver itself uses, prints the assigned short id the instant dispatch succeeds (so
// the test can synchronize on real output instead of guessing a wall-clock delay), then waits
// -- deliberately never reaching SubagentDriver's own poll/stop/extract steps, so the test
// controls exactly when this process dies relative to the dispatch having succeeded.
//
// It must never outlive its launcher (PANT-1094 / mdostal/minerva#94). The test SIGKILLs the
// process it spawned, but that is tsx's CLI wrapper, which runs this script in a *child* node
// process -- so the old `setInterval(() => {}, 1000)` hang left this process (plus its esbuild
// service) alive forever, reparented to init, holding the workdir open. Three independent
// guards now bound its lifetime:
//   1. orphan watchdog: exits as soon as its parent changes (the launcher died, however it
//      died -- SIGKILL included, which no exit handler of the launcher's can catch);
//   2. hard deadline: exits after MINERVA_SIGKILL_HARNESS_DEADLINE_MS no matter what;
//   3. on any exit path that runs JS (deadline, watchdog, signal, thrown error), the in-flight
//      `claude --bg` dispatch CLI, if still running, is killed with it.
// The test additionally spawns this harness into its own process group and kill(-pgid)s it
// from a `finally`, which covers this process itself being SIGKILLed.

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:os";
import { resolveRuntimeRoute, resolveClaudeSpawnEnv } from "./driver.ts";

function positiveIntEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const DEADLINE_MS = positiveIntEnv("MINERVA_SIGKILL_HARNESS_DEADLINE_MS", 120_000);
const DISPATCH_TIMEOUT_MS = positiveIntEnv("MINERVA_SIGKILL_HARNESS_DISPATCH_TIMEOUT_MS", 60_000);
const WATCHDOG_INTERVAL_MS = 200;

let dispatch: ChildProcess | null = null;

function killDispatch(): void {
  if (dispatch?.pid !== undefined && dispatch.exitCode === null && dispatch.signalCode === null) {
    try {
      process.kill(dispatch.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function die(code: number, reason: string): never {
  process.stderr.write(`sigkill-harness: exiting (${reason})\n`);
  process.exit(code);
}

process.on("exit", killDispatch);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => die(128 + constants.signals[sig], sig));
}

// Armed before anything else (including route resolution) so no await can outlive the launcher.
const launcherPid = process.ppid;
setInterval(() => {
  if (process.ppid !== launcherPid) die(0, `launcher ${launcherPid} is gone`);
}, WATCHDOG_INTERVAL_MS);
setTimeout(() => die(124, `hard deadline of ${DEADLINE_MS}ms reached`), DEADLINE_MS);

// The test asserts on this pid: it's the real work process, not tsx's wrapper.
process.stdout.write(`HARNESS_PID:${process.pid}\n`);

try {
  const prompt = process.argv[2] ?? "Say hello.";
  const route = await resolveRuntimeRoute();

  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      route.cli,
      ["--bg", "--model", route.model, "--permission-mode", "bypassPermissions", prompt],
      { env: resolveClaudeSpawnEnv(), stdio: ["ignore", "pipe", "inherit"] },
    );
    dispatch = child;
    let stdout = "";
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    const timer = setTimeout(() => {
      killDispatch();
      reject(new Error(`${route.cli} --bg did not finish within ${DISPATCH_TIMEOUT_MS}ms`));
    }, DISPATCH_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${route.cli} --bg exited with ${signal ?? `code ${code}`}`));
    });
  });

  const match = out.match(/backgrounded\s*[·:]\s*(\S+)/);
  process.stdout.write(`DISPATCHED:${match?.[1] ?? "UNKNOWN"}\n`);
  // Now wait -- the test kills our launcher here, well before we'd ever call `stop`. The
  // watchdog and deadline timers above keep the event loop alive and bound how long we wait.
} catch (e) {
  die(1, e instanceof Error ? e.message : String(e));
}
