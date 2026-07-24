# Minerva — North Star (the Planner / ideation-to-spec engine)

## Mission
Turn an IDEA into an approved, planned SPEC — autonomously — so a human can feed ideas and get
back a ready-to-build plan without hand-running the flow in a shell per idea.

## Loop
1. Take an idea (from the idea board / a human / Auriga's routing).
2. Run `kickoff` + `plan` (plugin-hive's proven front half).
3. **Generate the human-gate questions → surface them to Delphi** (rendered, not a terminal).
4. Collect answers, **iterate the back-and-forth**, re-plan.
5. Emit the approved epic + stories → hand to Auriga (route/execute) + Vulcan (provision).

## Why separate (the decomposition)
- **Auriga** (orchestrator) = routes + hands off, never plans.
- **Vulcan** (builder) = provisions/maintains repos.
- **Delphi** = the human view/decision SURFACE.
- **Minerva** = the ENGINE that runs kickoff+plan+ideation and drives Delphi.
Separating Minerva is what enables **parallel intake** — many ideas planned at once.

## Fit
TS default + Pantheon subprocess ABI (any-language, interchangeable). Feeds Delphi; hands to
Auriga + Vulcan. Same discipline as every Pantheon component.
