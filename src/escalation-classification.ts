// Escalation Classification (AD-2) — self-classification of each extracted question against
// the anchored escalate/absorb principle (docs/initial-info.md / docs/architecture.md AD-2):
// escalate strategic/ambiguous/irreversible/low-confidence questions; absorb routine/
// mechanical/pre-decided ones. When genuinely uncertain, always escalate -- never guess.
//
// Composed into the SAME claude -p / --json-schema call kickoff-engine already makes for
// extraction (question-extraction.ts) -- AD-2 requires the classification be judged "at
// question-generation time by the same planning persona that generates the question," so this
// is one combined schema, not a second model call. See
// .pHive/epics/agent-drivable-core/docs/classification-pairs.md for the checkpoint evidence.

import { QUESTION_SCHEMA_PROPERTY } from "./question-extraction.ts";
import type { Channel } from "./run-manager.ts";

const CLASSIFICATION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    question: QUESTION_SCHEMA_PROPERTY,
    suggested_channel: {
      type: "string",
      enum: ["agent", "human"],
      description:
        "Classify the question you are about to ask. Escalate to human if the question is " +
        "strategic, ambiguous, irreversible, or you have low confidence in a safe default " +
        "answer. Classify as agent if the question is routine, mechanical, or has an " +
        "obvious/safe pre-decided default that a coding agent could answer on the human " +
        "operator's behalf without real risk. When genuinely uncertain, always choose human " +
        "-- never guess.",
    },
    confidence: {
      type: "number",
      description: "Your confidence, 0.0 to 1.0, in the suggested_channel classification above.",
    },
    reason: {
      type: "string",
      description: "One concise sentence explaining why you classified it this way.",
    },
  },
  required: ["question", "suggested_channel", "confidence", "reason"],
});

export function classificationSchemaArgs(): string[] {
  return ["--json-schema", CLASSIFICATION_SCHEMA];
}

export interface ClassifiedQuestion {
  text: string;
  suggested_channel: Channel;
  confidence: number;
  reason: string;
}

const SAFE_DEFAULT_REASON =
  "classification unavailable (unparseable or missing fields) -- defaulted to human per " +
  "the 'when uncertain, escalate' principle";

// Parses the structured JSON result into question + classification. Any failure to parse, or
// any missing/invalid classification field, falls back to the safe default (channel: human,
// confidence: 0) rather than guessing a channel or throwing -- consistent with AD-2/AD-5's
// hard exclusion against auto-resolution. The question text itself still falls back to raw-prose
// passthrough (matching question-extraction.ts's own fallback), since a run should never lose
// the question just because classification failed alongside it.
export function extractClassifiedQuestion(rawResult: string): ClassifiedQuestion {
  let parsed: any;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    return {
      text: rawResult.trim(),
      suggested_channel: "human",
      confidence: 0,
      reason: SAFE_DEFAULT_REASON,
    };
  }

  const text =
    parsed && typeof parsed.question === "string" && parsed.question.trim().length > 0
      ? parsed.question.trim()
      : rawResult.trim();

  const channel: Channel =
    parsed && (parsed.suggested_channel === "agent" || parsed.suggested_channel === "human")
      ? parsed.suggested_channel
      : "human";

  const confidence: number =
    parsed && typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0;

  const reason: string =
    parsed && typeof parsed.reason === "string" && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : SAFE_DEFAULT_REASON;

  return { text, suggested_channel: channel, confidence, reason };
}

// --- Classification-only path (forked-driver-integration epic) -----------------------------
// ForkedHiveDriver's envelope questions arrive already-structured (text/kind/options straight
// from the envelope) -- no extraction step is needed, unlike SpawnDriver/SubagentDriver's
// prose-scraping turns. This is a SEPARATE, smaller schema that requests only the
// classification fields, reusing the exact same safe-default fallback discipline as
// extractClassifiedQuestion() above. Each call classifies exactly one question -- callers
// classify a multi-question envelope's batch by calling this once per question, never bundling
// several questions' judgments into one ambiguous response.

const CLASSIFICATION_ONLY_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    suggested_channel: {
      type: "string",
      enum: ["agent", "human"],
      description:
        "Classify the given question. Escalate to human if the question is strategic, " +
        "ambiguous, irreversible, or you have low confidence in a safe default answer. " +
        "Classify as agent if the question is routine, mechanical, or has an obvious/safe " +
        "pre-decided default that a coding agent could answer on the human operator's behalf " +
        "without real risk. When genuinely uncertain, always choose human -- never guess.",
    },
    confidence: {
      type: "number",
      description: "Your confidence, 0.0 to 1.0, in the suggested_channel classification above.",
    },
    reason: {
      type: "string",
      description: "One concise sentence explaining why you classified it this way.",
    },
  },
  required: ["suggested_channel", "confidence", "reason"],
});

export function classificationOnlySchemaArgs(): string[] {
  return ["--json-schema", CLASSIFICATION_ONLY_SCHEMA];
}

export type Classification = Omit<ClassifiedQuestion, "text">;

// Same safe-default fallback discipline as extractClassifiedQuestion(): any parse failure or
// missing/invalid field falls back to human/confidence-0/a safe-default reason, never guesses,
// never throws.
export function extractClassification(rawResult: string): Classification {
  let parsed: any;
  try {
    parsed = JSON.parse(rawResult);
  } catch {
    return {
      suggested_channel: "human",
      confidence: 0,
      reason: SAFE_DEFAULT_REASON,
    };
  }

  const channel: Channel =
    parsed && (parsed.suggested_channel === "agent" || parsed.suggested_channel === "human")
      ? parsed.suggested_channel
      : "human";

  const confidence: number =
    parsed && typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0;

  const reason: string =
    parsed && typeof parsed.reason === "string" && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : SAFE_DEFAULT_REASON;

  return { suggested_channel: channel, confidence, reason };
}
