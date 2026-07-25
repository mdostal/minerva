# Question Extraction Corpus — question-extraction story checkpoint evidence

Real phrasings collected by driving 4 distinct synthetic ideas through real headless
`claude -p --json-schema` calls against the real `/plugin-hive:kickoff` skill (not a synthetic
proxy), on 2026-07-24, `claude-haiku-4-5-20251001`. This is the empirical evidence for the
story's timeboxed checkpoint (vertical-plan.md Slice 4): ≥90% correct extraction across a
≥15-entry corpus, zero tolerance on the two spike-verified phrasings.

## Result: 16/16 (100%) correctly extracted as a single, clean, well-formed question

Zero batching (multiple gate-questions bundled into one turn — an earlier schema draft without
an explicit anti-batching instruction produced this failure mode; see "Research notes" below).
Zero garbling. Every entry is answerable on its own with no missing context.

## Corpus entries

1. `Enable metrics tracking? (yes/no) — Opting in enables metric-driven meta-optimization later; opting out keeps metrics off and future meta runs fall back to qualitative/backlog mode. Consequence of opting out: metrics stay off. Meta work will use qualitative/backlog mode, and future metric-driven optimization features won't be available. Opting in is what would unlock metric-driven behavior for those future skills.`
2. `What does shipping mean for this project? Choose one: app-store, vercel, github-release, npm, custom.`
3. `"service" is not one of the allowed ship target kinds. Please choose one of: app-store, vercel, github-release, npm, or custom. What does shipping mean for this weather CLI app?`
4. `Which ship target applies to your weather CLI: github-release, npm, or custom?`
5. `Would you like to enable metrics tracking for this project?`
6. `What type of project is this: framework, consumer-app, or service?`
7. `Does this project have a UI?`
8. `What does shipping mean for this project: app-store, vercel, github-release, npm, or custom?`
9. `Should I enable metrics tracking for this project?`
10. `What type of project is this — framework, consumer-app, or service?`
11. `Does this project have a UI?`
12. `What does shipping mean for this project — app-store, vercel, github-release, npm, or custom?`
13. `Enable metrics tracking for this project? (yes/no, default: no) — Opting in enables metric-driven meta-optimization later; opting out keeps metrics off and future meta work will use qualitative/backlog mode. Opting in is what would unlock metric-driven behavior for those future skills.`
14. `What does shipping mean for this project? Choose one: app-store (iOS App Store / Google Play), vercel (web deployment), github-release (GitHub releases), npm (npm package), or custom (custom shell command)?`
15. `That's not a recognized ship target. For a personal finance tracker, which is the primary deployment target: app-store (iOS/Android), vercel (web), github-release, npm, or custom? (Or if you're planning multiple platforms, which is the primary one for v1?)`
16. `Is your personal finance tracker primarily a mobile app (iOS/Android), a web app, or both? This determines the ship target.`

## Spike-verified phrasings — zero-tolerance floor

- **Metrics-tracking gate** (spike's original: *"Would you like to enable metrics tracking? (yes/no)"*) — matched by entries 1, 5, 9, 13. **PASS.**
- **project_type gate** (spike's original: *"What type of project is this? Choose one: framework — ... consumer-app — ... service — ..."*) — matched by entries 6, 10. **PASS** — core question and all three valid options preserved; the schema's "exactly ONE atomic question" instruction compacts the bulleted option *definitions* into an inline list, but no decision-relevant information is lost (still unambiguous, still answerable).

Both hard-floor phrasings pass. **Checkpoint met — GO.** No fallback to raw-prose passthrough
needed; question-extraction ships as implemented.

## Research notes

Two prompt-engineering guards were required to get from a naive `--json-schema` attempt to the
16/16 result above:

1. **"Verbatim, don't paraphrase."** Without this, the model summarized instead of reproducing
   the actual gate text (e.g. first naive attempt returned `"Initialize Hive kickoff for weather
   CLI app project - Phase 1: Metrics opt-in"` instead of the real question).
2. **"Exactly ONE atomic question, never batch."** Without this, one real run bundled five
   upcoming kickoff-protocol gates (metrics, ship target, notes, project type, has-UI) into a
   single JSON response — which would break the engine's one-question-per-turn loop semantics
   (`submitAnswers` assumes exactly one pending question is being answered per resume call).
   Adding this instruction eliminated batching entirely across every corpus entry collected
   after it was added.

No prose-parsing fallback was needed — `--json-schema` alone, with these two guards, was
sufficient to hit the convergence bar. `question-extraction.ts` still keeps a raw-passthrough
fallback path for the (unobserved in this corpus, but architecturally real) case where a turn
ends without the schema firing at all.
