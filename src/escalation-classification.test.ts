// escalation-classification.test.ts — escalation-classification story
// Fast, deterministic regression coverage for extractClassifiedQuestion()'s parsing logic,
// using fixtures built from real classification calls (see
// .pHive/epics/agent-drivable-core/docs/classification-pairs.md for the one-time live-API
// convergence proof: 10/10 = 100% correct escalate/absorb judgment against a deliberately
// diverse curated set spanning both directions of the anchored principle, plus a fresh
// 16-entry live corpus proving parseability of the combined question+classification schema).

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractClassifiedQuestion, extractClassification, classificationOnlySchemaArgs } from "./escalation-classification.ts";

test("parses a well-formed classified question with all four fields", () => {
  const raw = JSON.stringify({
    question: "Enable metrics tracking for this project?",
    suggested_channel: "human",
    confidence: 0.95,
    reason: "Strategic preference requiring user judgment, not a safe default.",
  });
  const result = extractClassifiedQuestion(raw);
  assert.equal(result.text, "Enable metrics tracking for this project?");
  assert.equal(result.suggested_channel, "human");
  assert.equal(result.confidence, 0.95);
  assert.match(result.reason, /strategic/i);
});

test("real escalate case (from classification-pairs.md): irreversible action", () => {
  const raw = JSON.stringify({
    question: "Should I delete the existing production database before running migrations?",
    suggested_channel: "human",
    confidence: 0.95,
    reason:
      "This is a destructive, irreversible action affecting production systems with very high stakes.",
  });
  const result = extractClassifiedQuestion(raw);
  assert.equal(result.suggested_channel, "human");
});

test("real absorb case (from classification-pairs.md): routine, mechanical, pre-decided", () => {
  const raw = JSON.stringify({
    question: "The build output directory doesn't exist yet -- should I create it before writing files?",
    suggested_channel: "agent",
    confidence: 0.95,
    reason: "Routine, reversible procedural decision with an obvious safe default.",
  });
  const result = extractClassifiedQuestion(raw);
  assert.equal(result.suggested_channel, "agent");
});

test("malformed JSON falls back to the safe default: human, confidence 0, raw text preserved", () => {
  const rawProse = "Would you like to enable metrics tracking? (yes/no)";
  const result = extractClassifiedQuestion(rawProse);
  assert.equal(result.text, rawProse);
  assert.equal(result.suggested_channel, "human");
  assert.equal(result.confidence, 0);
  assert.match(result.reason, /unavailable/);
});

test("invalid suggested_channel value falls back to human, never guesses a channel", () => {
  const raw = JSON.stringify({
    question: "Some question?",
    suggested_channel: "maybe", // not a valid enum value
    confidence: 0.8,
    reason: "test",
  });
  const result = extractClassifiedQuestion(raw);
  assert.equal(result.suggested_channel, "human");
});

test("missing confidence/reason fields fall back to safe defaults without throwing", () => {
  const raw = JSON.stringify({ question: "Some question?", suggested_channel: "agent" });
  const result = extractClassifiedQuestion(raw);
  assert.equal(result.suggested_channel, "agent");
  assert.equal(result.confidence, 0);
  assert.match(result.reason, /unavailable/);
});

test("out-of-range confidence value falls back to 0 rather than propagating an invalid number", () => {
  const raw = JSON.stringify({
    question: "Some question?",
    suggested_channel: "human",
    confidence: 42, // out of the valid 0.0-1.0 range
    reason: "test",
  });
  const result = extractClassifiedQuestion(raw);
  assert.equal(result.confidence, 0);
});

// --- Classification-only path (forked-driver-integration epic) -----------------------------
// ForkedHiveDriver's envelope questions arrive already-structured (text/kind/options from the
// envelope) -- no extraction step is needed, so this is a SEPARATE, smaller schema/parser that
// classifies without also re-extracting question text. Reuses the exact same safe-default
// fallback discipline as extractClassifiedQuestion() above -- never guesses, never throws.
// See .pHive/epics/forked-driver-integration/stories/escalation-classification-envelope.yaml.

test("classificationOnlySchemaArgs returns a --json-schema pair whose schema has no `question` property", () => {
  const args = classificationOnlySchemaArgs();
  assert.equal(args[0], "--json-schema");
  const schema = JSON.parse(args[1] as string);
  assert.equal(schema.properties.question, undefined);
  assert.ok(schema.properties.suggested_channel);
  assert.ok(schema.properties.confidence);
  assert.ok(schema.properties.reason);
  assert.deepEqual(schema.required.sort(), ["confidence", "reason", "suggested_channel"]);
});

test("extractClassification parses a well-formed classification-only response", () => {
  const raw = JSON.stringify({
    suggested_channel: "human",
    confidence: 0.9,
    reason: "Strategic preference requiring user judgment.",
  });
  const result = extractClassification(raw);
  assert.equal(result.suggested_channel, "human");
  assert.equal(result.confidence, 0.9);
  assert.match(result.reason, /Strategic/);
});

test("extractClassification falls back to the safe default on malformed JSON, matching extractClassifiedQuestion's discipline exactly", () => {
  const result = extractClassification("not json at all");
  assert.equal(result.suggested_channel, "human");
  assert.equal(result.confidence, 0);
  assert.match(result.reason, /unavailable/);
});

test("extractClassification never guesses a channel on an invalid suggested_channel value", () => {
  const raw = JSON.stringify({ suggested_channel: "maybe", confidence: 0.8, reason: "test" });
  const result = extractClassification(raw);
  assert.equal(result.suggested_channel, "human");
});

test("extractClassification clamps an out-of-range confidence to 0, exactly like the extraction-time parser", () => {
  const raw = JSON.stringify({ suggested_channel: "agent", confidence: 99, reason: "test" });
  const result = extractClassification(raw);
  assert.equal(result.confidence, 0);
});

test("extractClassification's result never carries a `text`/`question` field -- it classifies, it does not re-extract", () => {
  const raw = JSON.stringify({ suggested_channel: "human", confidence: 0.5, reason: "test" });
  const result = extractClassification(raw);
  assert.equal("text" in result, false);
  assert.equal("question" in result, false);
});
