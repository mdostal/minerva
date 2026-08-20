// telemetry.ts — driver-lifecycle-telemetry: a flat, cross-run operational event log an operator
// can tail/ship externally (e.g. `tail -f ~/.minerva/events/driver_started.jsonl`). Deliberately
// separate from the RunMetrics system in run-manager.ts (recordDriverTurn/
// updateRunMetricsDriver/finalizeRunMetrics), which is per-run introspection embedded in the run
// record -- different consumers, different shape. Do not conflate or merge the two mechanisms.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Matches the existing MINERVA_HOME convention (run-manager.ts's minervaHome()):
// process.env.MINERVA_HOME ?? join(homedir(), ".minerva").
function minervaHome(): string {
  return process.env.MINERVA_HOME ?? join(homedir(), ".minerva");
}

function eventsDir(): string {
  return join(minervaHome(), "events");
}

// Appends one JSON line ({event, emitted_at, ...payload}) to
// <MINERVA_HOME>/events/<event>.jsonl. Write failures are not swallowed (this codebase's
// fail-loud discipline) -- a real fs error here is worth surfacing, not hiding.
export function emitTelemetryEvent(event: string, payload?: object): void {
  const dir = eventsDir();
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ event, emitted_at: new Date().toISOString(), ...(payload ?? {}) });
  appendFileSync(join(dir, `${event}.jsonl`), line + "\n");
}
