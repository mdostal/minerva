// Envelope detection + parsing (forked-driver-integration epic) — read-only detection and
// parsing of `.pHive/questions/<skill>-<invocation-id>.yaml` envelope files, mirroring
// output-emitter.ts's findCompletedEpic directory-scan pattern. Full schema:
// hive/references/question-envelope-schema.md in plugin-hive-fork.
//
// LOAD-BEARING (confirmed via the epic's own spike + PR #341's review): envelopes are DELETED
// by the gateway the instant it consumes a status: answered one -- absence is a legitimate,
// common state, never an error. Every function here is strictly read-only: no write, delete, or
// mutation path exists in this module. Consuming (writing an answer + triggering deletion) is
// the real driver implementation's own job, not this module's.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { normalizeQuestionKind, type QuestionKind } from "./run-manager.ts";

export interface EnvelopeQuestion {
  qid: string;
  text: string;
  kind: QuestionKind;
  options: string[] | null;
  required: boolean;
  answer: string | string[] | null;
}

export interface Envelope {
  id: string;
  skill: string;
  phase: string;
  status: "pending" | "answered";
  provenance: { raised_by: string; raised_at: string };
  deadline: string;
  renewal_count: number;
  questions: EnvelopeQuestion[];
  // Not part of the upstream schema itself -- the file's own path, needed by the real driver
  // implementation's answer-write-back step to locate the file it's about to edit.
  path: string;
}

function questionsDir(workspacePath: string): string {
  return join(workspacePath, ".pHive", "questions");
}

// Read-only. Never throws -- returns null on any read/parse failure or structural mismatch,
// since a malformed or mid-write file is a real, expected transient state from this reader's
// perspective (the gateway's write is not guaranteed atomic relative to a concurrent read).
function parseEnvelopeFile(path: string): Envelope | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.skill !== "string" || typeof p.phase !== "string") {
    return null;
  }

  const provenanceRaw = p.provenance && typeof p.provenance === "object" ? (p.provenance as Record<string, unknown>) : {};
  const questionsRaw = Array.isArray(p.questions) ? p.questions : [];

  const questions: EnvelopeQuestion[] = questionsRaw
    .filter(
      (q): q is Record<string, unknown> =>
        !!q && typeof q === "object" && typeof (q as Record<string, unknown>).qid === "string" && typeof (q as Record<string, unknown>).text === "string",
    )
    .map((q) => ({
      qid: q.qid as string,
      text: q.text as string,
      kind: normalizeQuestionKind(q.kind),
      options: Array.isArray(q.options) ? (q.options as string[]) : null,
      required: q.required === true,
      answer:
        typeof q.answer === "string" || (Array.isArray(q.answer) && q.answer.every((a) => typeof a === "string"))
          ? (q.answer as string | string[])
          : null,
    }));

  return {
    id: p.id,
    skill: p.skill,
    phase: p.phase,
    status: p.status === "answered" ? "answered" : "pending",
    provenance: {
      raised_by: typeof provenanceRaw.raised_by === "string" ? provenanceRaw.raised_by : p.skill,
      raised_at: typeof provenanceRaw.raised_at === "string" ? provenanceRaw.raised_at : "",
    },
    deadline: typeof p.deadline === "string" ? p.deadline : "",
    renewal_count: typeof p.renewal_count === "number" ? p.renewal_count : 0,
    questions,
    path,
  };
}

// Read-only. Enumerates every parseable envelope under workspacePath/.pHive/questions/. Returns
// an empty array when the directory is absent -- never throws.
export function listEnvelopes(workspacePath: string): Envelope[] {
  const dir = questionsDir(workspacePath);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  } catch {
    return [];
  }

  return files.map((f) => parseEnvelopeFile(join(dir, f))).filter((e): e is Envelope => e !== null);
}

// Read-only. Exact skill+phase match -- fits kickoff/plan's simple phase-id convention (at most
// one invocation in flight per project, per the schema's Phase-id scoping section).
export function findEnvelopesForPhase(workspacePath: string, skill: string, phase: string): Envelope[] {
  return listEnvelopes(workspacePath).filter((e) => e.skill === skill && e.phase === phase);
}

// Read-only. Prefix match -- fits design's topic+round-scoped phase ids
// (touchpoint-1-round-1-<topic>, touchpoint-1-round-2-<topic>, ...), letting a caller enumerate
// every round for a topic without knowing the current round number ahead of time. This function
// does not itself understand round-counter semantics -- it is a pure prefix filter; the caller
// (the real driver implementation) decides what "current round" means from the results.
export function findEnvelopesByPhasePrefix(workspacePath: string, skill: string, phasePrefix: string): Envelope[] {
  return listEnvelopes(workspacePath).filter((e) => e.skill === skill && e.phase.startsWith(phasePrefix));
}
