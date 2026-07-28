// forked-hive-driver-helpers.test.ts — real-forked-hive-driver story (forked-driver-integration
// epic). Fast, live-API-free tests for ForkedHiveDriver's pure helper functions: the
// session_id-as-opaque-pointer encode/decode pair, and the envelope answer-write-back function.
// The full runTurn() end-to-end behavior (real claude dispatch) is covered separately in
// real-forked-hive-driver.test.ts, per this project's "no mocking the CLI boundary" convention
// (AD-1) -- these tests cover only the parts that don't need a live call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import {
  encodeEnvelopePointer,
  decodeEnvelopePointer,
  writeAnswerOntoEnvelope,
  classifyKnownEnvelopeQuestion,
  NO_PENDING_SENTINEL,
} from "./driver.ts";

// --- Pointer encode/decode ------------------------------------------------------------------
// ForkedHiveDriver is confirmed stateless (the epic's own spike) -- session_id is never used
// for --resume. Instead it's repurposed as driver-opaque state (per the Driver contract's own
// "opaque from run-manager's perspective" design) pointing at which envelope+question an
// incoming answer belongs to, plus the original skill-invocation prompt needed to re-dispatch
// correctly (ForkedHiveDriver has no session continuity to fall back on for that).

test("encodeEnvelopePointer + decodeEnvelopePointer round-trip exactly", () => {
  const pointer = { envelopePath: "/tmp/some/.pHive/questions/kickoff-1.yaml", qid: "enable_metrics", skillPrompt: "/plugin-hive:kickoff a tiny project" };
  const encoded = encodeEnvelopePointer(pointer);
  assert.equal(typeof encoded, "string");
  const decoded = decodeEnvelopePointer(encoded);
  assert.deepEqual(decoded, pointer);
});

test("decodeEnvelopePointer returns null for the no-pending sentinel -- never throws", () => {
  assert.equal(decodeEnvelopePointer(NO_PENDING_SENTINEL), null);
});

test("decodeEnvelopePointer returns null for an unrecognized/malformed session_id -- never throws", () => {
  assert.equal(decodeEnvelopePointer("some-random-uuid-4a5b6c"), null);
  assert.equal(decodeEnvelopePointer(""), null);
  assert.equal(decodeEnvelopePointer("forked-hive-driver:not valid json{{{"), null);
});

// --- Known envelope question classification -------------------------------------------------
// Standard kickoff envelope qids do not need a live model classifier turn. Keeping these
// deterministic avoids burning a second claude call just to route a protocol-known gate, and
// removes a live stall observed on `project_type` during the MINERVA_DRIVER=forked service smoke.

test("classifyKnownEnvelopeQuestion routes kickoff metrics variants to human", () => {
  const classification = classifyKnownEnvelopeQuestion("metrics-opt-in", "Enable metrics tracking?");
  assert.equal(classification?.suggested_channel, "human");
  assert.ok((classification?.confidence ?? 0) >= 0.9);
});

test("classifyKnownEnvelopeQuestion routes kickoff project_type and has_ui deterministically", () => {
  assert.equal(classifyKnownEnvelopeQuestion("project_type", "What type of project is this?")?.suggested_channel, "human");
  assert.equal(classifyKnownEnvelopeQuestion("has_ui", "Does this project have a UI?")?.suggested_channel, "agent");
});

test("classifyKnownEnvelopeQuestion returns null for unknown qids so the live classifier remains the fallback", () => {
  assert.equal(classifyKnownEnvelopeQuestion("unknown_gate", "What should happen next?"), null);
});

// --- writeAnswerOntoEnvelope ------------------------------------------------------------------
// The ONLY write path ForkedHiveDriver has -- writes a single question's `answer`, and flips
// `status: answered` only once every required question has a non-null answer (the closure
// invariant). Never writes id/skill/phase/provenance/question text/options -- matches the
// schema's "Single writer per field group" rule.

const SINGLE_QUESTION_ENVELOPE = `id: kickoff-test.yaml
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
    text: Enable metrics tracking?
    kind: single-select
    options: ["yes", "no"]
    required: true
    answer: null
`;

const MULTI_QUESTION_ENVELOPE = `id: kickoff-1b.yaml
skill: kickoff
phase: 1b
status: pending
provenance:
  raised_by: kickoff
  raised_at: '2026-07-26T19:12:00.000Z'
deadline: '2026-07-26T19:42:00.000Z'
renewal_count: 0
questions:
  - qid: ship_kind
    text: What does shipping mean for this project?
    kind: single-select
    options: ["app-store", "vercel", "github-release", "npm", "custom"]
    required: true
    answer: null
  - qid: ship_notes
    text: Optional notes
    kind: free-text
    options: null
    required: false
    answer: null
`;

test("writeAnswerOntoEnvelope writes the answer and flips status:answered when it's the only required question", () => {
  const dir = mkdtempSync(join(tmpdir(), "minerva-envelope-write-"));
  const path = join(dir, "envelope.yaml");
  writeFileSync(path, SINGLE_QUESTION_ENVELOPE);

  const consumed = writeAnswerOntoEnvelope(path, "enable_metrics", "no");
  assert.equal(consumed, true);

  const written = parseYaml(readFileSync(path, "utf8"));
  assert.equal(written.status, "answered");
  assert.equal(written.questions[0].answer, "no");
  // Everything else must be byte-identical -- this writer never touches id/skill/phase/
  // provenance/question text/options, per the schema's single-writer field-group rule.
  assert.equal(written.id, "kickoff-test.yaml");
  assert.equal(written.phase, "1a");
  assert.equal(written.questions[0].text, "Enable metrics tracking?");
  assert.deepEqual(written.questions[0].options, ["yes", "no"]);
  rmSync(dir, { recursive: true, force: true });
});

test("writeAnswerOntoEnvelope does NOT flip status:answered while a required sibling question is still unanswered", () => {
  const dir = mkdtempSync(join(tmpdir(), "minerva-envelope-write-multi-"));
  const path = join(dir, "envelope.yaml");
  writeFileSync(path, MULTI_QUESTION_ENVELOPE);

  // Only answering the optional question -- the required "ship_kind" is still null.
  const consumed = writeAnswerOntoEnvelope(path, "ship_notes", "no special notes");
  assert.equal(consumed, false);

  const written = parseYaml(readFileSync(path, "utf8"));
  assert.equal(written.status, "pending");
  assert.equal(written.questions[1].answer, "no special notes");
  assert.equal(written.questions[0].answer, null);
  rmSync(dir, { recursive: true, force: true });
});

test("writeAnswerOntoEnvelope flips status:answered only once EVERY required question has an answer -- the closure invariant", () => {
  const dir = mkdtempSync(join(tmpdir(), "minerva-envelope-write-closure-"));
  const path = join(dir, "envelope.yaml");
  writeFileSync(path, MULTI_QUESTION_ENVELOPE);

  const firstConsumed = writeAnswerOntoEnvelope(path, "ship_notes", "no notes");
  assert.equal(firstConsumed, false); // required ship_kind still unanswered

  const secondConsumed = writeAnswerOntoEnvelope(path, "ship_kind", "github-release");
  assert.equal(secondConsumed, true); // now every required question has a non-null answer

  const written = parseYaml(readFileSync(path, "utf8"));
  assert.equal(written.status, "answered");
});

test("writeAnswerOntoEnvelope throws a clear error for an unknown qid -- never silently no-ops", () => {
  const dir = mkdtempSync(join(tmpdir(), "minerva-envelope-write-badqid-"));
  const path = join(dir, "envelope.yaml");
  writeFileSync(path, SINGLE_QUESTION_ENVELOPE);

  assert.throws(() => writeAnswerOntoEnvelope(path, "not_a_real_qid", "no"), /not_a_real_qid/);
  rmSync(dir, { recursive: true, force: true });
});
