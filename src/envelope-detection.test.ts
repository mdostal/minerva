// envelope-detection.test.ts — envelope-detection-parsing story (forked-driver-integration epic)
//
// Fast, live-API-free tests using real fixture YAML content captured from the epic's own spike
// (spike-stateless-model-tier) -- genuine envelope shapes written by the real
// plugin-hive-fork gateway via `claude --plugin-dir`, not hand-authored guesses at the schema.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listEnvelopes, findEnvelopesForPhase, findEnvelopesByPhasePrefix } from "./envelope-detection.ts";

let workspace: string;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "minerva-envelope-detection-"));
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function questionsDir(): string {
  const dir = join(workspace, ".pHive", "questions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Genuine fixture, captured verbatim (structure) from the spike's real post-fix kickoff run.
const REAL_KICKOFF_ENVELOPE = `id: kickoff-2026-07-26T19-11-29.823Z
skill: kickoff
phase: 1a
status: pending
provenance:
  raised_by: kickoff
  raised_at: '2026-07-26T19:11:29.823Z'
deadline: '2026-07-26T19:41:29.823Z'
renewal_count: 0
questions:
- qid: enable_metrics
  text: 'Enable metrics tracking?


    Consequence of opting out: metrics stay off. Meta work will use qualitative/backlog
    mode, and future metric-driven optimization features won''t be available.


    Opting in is what would unlock metric-driven behavior for those future skills.'
  kind: single-select
  options:
  - 'yes'
  - 'no'
  required: true
  answer: null
`;

// Genuine fixture from the spike's design run -- topic+round-scoped phase id.
const REAL_DESIGN_ENVELOPE = `id: design-2026-07-26T19-17-40.053Z
skill: design
phase: touchpoint-1-round-1-spike-test-topic-settings
status: pending
provenance:
  raised_by: design
  raised_at: '2026-07-26T19:17:40.053Z'
deadline: '2026-07-26T19:47:40.053Z'
renewal_count: 0
questions:
- qid: wireframe_approval
  text: 'Approve this wireframe rendition?'
  kind: single-select
  options:
  - 'approve'
  - 'reject'
  required: true
  answer: null
`;

// A second design round, for the multi-round enumeration test.
const REAL_DESIGN_ROUND_2_ENVELOPE = `id: design-2026-07-26T19-25-00.000Z
skill: design
phase: touchpoint-1-round-2-spike-test-topic-settings
status: pending
provenance:
  raised_by: design
  raised_at: '2026-07-26T19:25:00.000Z'
deadline: '2026-07-26T19:55:00.000Z'
renewal_count: 0
questions:
- qid: wireframe_approval
  text: 'Approve this revised wireframe rendition?'
  kind: single-select
  options:
  - 'approve'
  - 'reject'
  required: true
  answer: null
`;

test("listEnvelopes returns an empty array when .pHive/questions/ doesn't exist -- never throws", () => {
  const emptyWorkspace = mkdtempSync(join(tmpdir(), "minerva-envelope-detection-empty-"));
  const result = listEnvelopes(emptyWorkspace);
  assert.deepEqual(result, []);
  rmSync(emptyWorkspace, { recursive: true, force: true });
});

test("listEnvelopes parses a real, genuine envelope fixture into every documented top-level field", () => {
  const dir = questionsDir();
  writeFileSync(join(dir, "kickoff-2026-07-26T19-11-29.823Z.yaml"), REAL_KICKOFF_ENVELOPE);

  const result = listEnvelopes(workspace);
  assert.equal(result.length, 1);
  const [envelope] = result;
  assert.ok(envelope);
  assert.equal(envelope.id, "kickoff-2026-07-26T19-11-29.823Z");
  assert.equal(envelope.skill, "kickoff");
  assert.equal(envelope.phase, "1a");
  assert.equal(envelope.status, "pending");
  assert.equal(envelope.provenance.raised_by, "kickoff");
  assert.equal(envelope.provenance.raised_at, "2026-07-26T19:11:29.823Z");
  assert.equal(envelope.deadline, "2026-07-26T19:41:29.823Z");
  assert.equal(envelope.renewal_count, 0);
  assert.equal(envelope.questions.length, 1);
  const [q] = envelope.questions;
  assert.ok(q);
  assert.equal(q.qid, "enable_metrics");
  assert.match(q.text, /Enable metrics tracking/);
  assert.equal(q.kind, "single-select");
  assert.deepEqual(q.options, ["yes", "no"]);
  assert.equal(q.required, true);
  assert.equal(q.answer, null);
  assert.equal(envelope.path, join(dir, "kickoff-2026-07-26T19-11-29.823Z.yaml"));
});

test("listEnvelopes defensively normalizes a kind value outside the documented enum, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "minerva-envelope-detection-kind-"));
  mkdirSync(join(dir, ".pHive", "questions"), { recursive: true });
  const envelopeWithBadKind = REAL_KICKOFF_ENVELOPE.replace("kind: single-select", "kind: yes-no");
  writeFileSync(join(dir, ".pHive", "questions", "kickoff-bad-kind.yaml"), envelopeWithBadKind);

  const result = listEnvelopes(dir);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.questions[0]?.kind, "free-text"); // normalized defensively, per normalizeQuestionKind
  rmSync(dir, { recursive: true, force: true });
});

test("listEnvelopes skips (does not throw on) a malformed/unparseable YAML file, still returns valid siblings", () => {
  const dir = mkdtempSync(join(tmpdir(), "minerva-envelope-detection-malformed-"));
  mkdirSync(join(dir, ".pHive", "questions"), { recursive: true });
  writeFileSync(join(dir, ".pHive", "questions", "valid.yaml"), REAL_KICKOFF_ENVELOPE);
  writeFileSync(join(dir, ".pHive", "questions", "malformed.yaml"), "this: is: not: valid: yaml: [[[");

  const result = listEnvelopes(dir);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.id, "kickoff-2026-07-26T19-11-29.823Z");
  rmSync(dir, { recursive: true, force: true });
});

test("findEnvelopesForPhase filters by exact skill+phase match (kickoff/plan's simple phase-id convention)", () => {
  const dir = mkdtempSync(join(tmpdir(), "minerva-envelope-detection-phase-"));
  mkdirSync(join(dir, ".pHive", "questions"), { recursive: true });
  writeFileSync(join(dir, ".pHive", "questions", "kickoff-envelope.yaml"), REAL_KICKOFF_ENVELOPE);

  const matched = findEnvelopesForPhase(dir, "kickoff", "1a");
  assert.equal(matched.length, 1);

  const unmatched = findEnvelopesForPhase(dir, "kickoff", "1b");
  assert.equal(unmatched.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("findEnvelopesByPhasePrefix enumerates multiple rounds for design's topic+round-scoped phase ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "minerva-envelope-detection-rounds-"));
  mkdirSync(join(dir, ".pHive", "questions"), { recursive: true });
  writeFileSync(join(dir, ".pHive", "questions", "design-round1.yaml"), REAL_DESIGN_ENVELOPE);
  writeFileSync(join(dir, ".pHive", "questions", "design-round2.yaml"), REAL_DESIGN_ROUND_2_ENVELOPE);

  const rounds = findEnvelopesByPhasePrefix(dir, "design", "touchpoint-1-round-");
  assert.equal(rounds.length, 2);
  const phases = rounds.map((e) => e.phase).sort();
  assert.deepEqual(phases, [
    "touchpoint-1-round-1-spike-test-topic-settings",
    "touchpoint-1-round-2-spike-test-topic-settings",
  ]);
  rmSync(dir, { recursive: true, force: true });
});

test("listEnvelopes never writes, deletes, or mutates any file on disk -- confirmed by re-reading unchanged after the call", () => {
  const dir = mkdtempSync(join(tmpdir(), "minerva-envelope-detection-readonly-"));
  mkdirSync(join(dir, ".pHive", "questions"), { recursive: true });
  const path = join(dir, ".pHive", "questions", "kickoff-envelope.yaml");
  writeFileSync(path, REAL_KICKOFF_ENVELOPE);

  listEnvelopes(dir);
  findEnvelopesForPhase(dir, "kickoff", "1a");
  findEnvelopesByPhasePrefix(dir, "kickoff", "1");

  assert.equal(readFileSync(path, "utf8"), REAL_KICKOFF_ENVELOPE);
  assert.deepEqual(readdirSync(join(dir, ".pHive", "questions")), ["kickoff-envelope.yaml"]);
  rmSync(dir, { recursive: true, force: true });
});
