import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

function minervaHome(): string {
  return process.env.MINERVA_HOME ?? join(homedir(), ".minerva");
}

export function emitTelemetryEvent(event: string, payload: Record<string, unknown> = {}): void {
  const path = join(minervaHome(), "events", `${event}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    JSON.stringify({
      event,
      emitted_at: new Date().toISOString(),
      ...payload,
    }) + "\n"
  );
}
