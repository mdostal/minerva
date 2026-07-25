// Question extraction — kickoff-engine's raw prose turn -> a single, clean question string.
// Primary approach: claude -p --json-schema, constraining the driven turn's own final output
// directly, rather than parsing free prose after the fact. Two prompt-engineering guards were
// necessary (see .pHive/epics/agent-drivable-core/docs/extraction-corpus.md "Research notes"):
// (1) explicit "verbatim, don't paraphrase" instruction -- without it the model summarizes
//     instead of reproducing the actual gate question text.
// (2) explicit "exactly ONE atomic question, never batch" instruction -- without it the model
//     sometimes bundles several upcoming kickoff-protocol gates into one JSON response, which
//     breaks the engine's one-question-per-turn loop semantics (submitAnswers assumes exactly
//     one pending question is being answered per resume call).
//
// No prose-parsing fallback was needed -- see the story's checkpoint outcome in
// docs/architecture.md's Kickoff+Plan Engine section for the full result.

const EXTRACTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    question: {
      type: "string",
      description:
        "The exact, verbatim text of exactly ONE single question -- the very next atomic " +
        "question you would ask right now, and nothing else. Do NOT bundle, batch, combine, " +
        "or list multiple questions together, even if the underlying protocol has several " +
        "upcoming questions -- ask only the single next one, exactly as you would phrase it " +
        "in prose, including any consequence/explanation lines for that one question only.",
    },
  },
  required: ["question"],
});

export function extractionSchemaArgs(): string[] {
  return ["--json-schema", EXTRACTION_SCHEMA];
}

// Parses the structured JSON result text (from a --json-schema-constrained claude -p call)
// into the clean question string. Falls back to treating the raw text as the question itself
// if it isn't valid JSON in the expected shape -- this handles the (rare, per the corpus) case
// where a turn ends without invoking the schema (e.g. stop_reason other than the schema path),
// so extraction degrades to raw-prose passthrough rather than throwing.
export function extractQuestion(rawResult: string): string {
  try {
    const parsed = JSON.parse(rawResult);
    if (parsed && typeof parsed.question === "string" && parsed.question.trim().length > 0) {
      return parsed.question.trim();
    }
  } catch {
    // Not JSON -- fall through to raw-prose passthrough below.
  }
  return rawResult.trim();
}
