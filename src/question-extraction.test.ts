// question-extraction.test.ts — question-extraction story
// Fast, deterministic regression coverage for extractQuestion()'s parsing logic, using the
// REAL corpus strings captured live against claude -p --json-schema + the real
// /plugin-hive:kickoff skill (see .pHive/epics/agent-drivable-core/docs/extraction-corpus.md
// for the one-time live-API convergence proof: 16/16, including both spike-verified
// phrasings). Re-running all 16 against the live API on every CI run would be slow and costly
// -- this file re-validates the PARSING logic against those exact captured strings instead,
// wrapped in the same {"question": "..."} envelope the real schema-constrained calls produce.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractQuestion } from "./question-extraction.ts";

// Verbatim from .pHive/epics/agent-drivable-core/docs/extraction-corpus.md
const CORPUS = [
  'Enable metrics tracking? (yes/no) — Opting in enables metric-driven meta-optimization later; opting out keeps metrics off and future meta runs fall back to qualitative/backlog mode. Consequence of opting out: metrics stay off. Meta work will use qualitative/backlog mode, and future metric-driven optimization features won\'t be available. Opting in is what would unlock metric-driven behavior for those future skills.',
  'What does shipping mean for this project? Choose one: app-store, vercel, github-release, npm, custom.',
  '"service" is not one of the allowed ship target kinds. Please choose one of: app-store, vercel, github-release, npm, or custom. What does shipping mean for this weather CLI app?',
  'Which ship target applies to your weather CLI: github-release, npm, or custom?',
  'Would you like to enable metrics tracking for this project?',
  'What type of project is this: framework, consumer-app, or service?',
  'Does this project have a UI?',
  'What does shipping mean for this project: app-store, vercel, github-release, npm, or custom?',
  'Should I enable metrics tracking for this project?',
  'What type of project is this — framework, consumer-app, or service?',
  'Does this project have a UI?',
  'What does shipping mean for this project — app-store, vercel, github-release, npm, or custom?',
  'Enable metrics tracking for this project? (yes/no, default: no) — Opting in enables metric-driven meta-optimization later; opting out keeps metrics off and future meta work will use qualitative/backlog mode. Opting in is what would unlock metric-driven behavior for those future skills.',
  'What does shipping mean for this project? Choose one: app-store (iOS App Store / Google Play), vercel (web deployment), github-release (GitHub releases), npm (npm package), or custom (custom shell command)?',
  'That\'s not a recognized ship target. For a personal finance tracker, which is the primary deployment target: app-store (iOS/Android), vercel (web), github-release, npm, or custom? (Or if you\'re planning multiple platforms, which is the primary one for v1?)',
  'Is your personal finance tracker primarily a mobile app (iOS/Android), a web app, or both? This determines the ship target.',
];

const SPIKE_METRICS_INDICES = [0, 4, 8, 12]; // entries 1,5,9,13 (1-indexed in the doc)
const SPIKE_PROJECT_TYPE_INDICES = [5, 9]; // entries 6,10 (1-indexed in the doc)

function looksLikeCleanSingleQuestion(text: string): boolean {
  if (text.trim().length === 0) return false;
  // Contains a question mark somewhere -- real entries often have a trailing clarifying
  // clause or option list after the "?" (e.g. "...custom." or "...(yes/no, default: no)"),
  // so requiring the LAST character to be "?" is too strict; requiring one to be PRESENT
  // is the right bar for "phrased as a question."
  if (!text.includes("?")) return false;
  // Anti-batching regression guard: no numbered-list pattern indicating multiple bundled
  // questions (the failure mode the corpus doc's "Research notes" describes and fixed).
  if (/\n\s*[1-9]\.\s/.test(text)) return false;
  return true;
}

test("extractQuestion correctly parses a clean question for >=90% of the 16-entry corpus", () => {
  let passCount = 0;
  for (const question of CORPUS) {
    const raw = JSON.stringify({ question });
    const extracted = extractQuestion(raw);
    if (extracted === question && looksLikeCleanSingleQuestion(extracted)) passCount++;
  }
  const passRate = passCount / CORPUS.length;
  assert.ok(passRate >= 0.9, `pass rate ${passRate} below the 90% convergence bar`);
});

test("zero-tolerance floor: both spike-verified phrasings extract correctly, no exceptions", () => {
  for (const i of [...SPIKE_METRICS_INDICES, ...SPIKE_PROJECT_TYPE_INDICES]) {
    const question = CORPUS[i]!;
    const raw = JSON.stringify({ question });
    const extracted = extractQuestion(raw);
    assert.equal(extracted, question, `spike-verified corpus entry ${i + 1} failed to extract cleanly`);
  }
});

test("malformed/non-JSON result falls back to raw-prose passthrough rather than throwing", () => {
  const rawProse = "Would you like to enable metrics tracking? (yes/no)";
  assert.equal(extractQuestion(rawProse), rawProse);
});

test("JSON without a non-empty question field falls back to raw-prose passthrough", () => {
  const raw = JSON.stringify({ question: "" });
  assert.equal(extractQuestion(raw), raw.trim());
});

test("well-formed extraction trims surrounding whitespace", () => {
  const raw = JSON.stringify({ question: "  Enable metrics tracking?  " });
  assert.equal(extractQuestion(raw), "Enable metrics tracking?");
});
