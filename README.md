# minerva

**Minerva** — the Pantheon's **Planner** (Roman goddess of wisdom + strategic planning).

Turns an **idea** into an **approved, planned spec** — autonomously. Minerva runs the *front
half* of the hive flow (`kickoff` + `plan`), generates the human-gate questions, drives them
through **Delphi** (the view/decision surface, not a shell), iterates the back-and-forth, and
emits the approved epic/stories — then hands off to **Auriga** (orchestrator) + **Vulcan**
(builder) for execution.

## Why it's its own thing
Auriga **routes + hands off** (never plans). Vulcan **provisions repos**. Delphi is the human
**surface**. **Minerva is the ENGINE that runs the ideation→plan loop.** Splitting it out is what
lets you **feed many ideas at once** — each idea gets its own Minerva run + Delphi thread in
parallel, instead of hand-running `/hive:kickoff` in a terminal per idea.

## The pipeline
```
Idea → Auriga (route) → Minerva (kickoff + plan · questions → Delphi → iterate → spec)
     → Vulcan (provision) + Auriga (hand to swarm) → execution swarm (execute→review→test→ship)
```

## What it runs
Built on plugin-hive's `kickoff` + `plan`, wrapped as a service: idea in → run kickoff+plan →
**surface questions to Delphi** → collect answers → iterate → emit the approved epic/stories.

## Discipline
TS default + the Pantheon subprocess ABI (interchangeable, any-language). Plugin with a contract.
named → interfaced → FULL TDD → locked. Local CI, no GHA. Rogue-overwrite guardrails.

_Lives beside the meta repo (`Dostal-Pantheon-Hive-v1`). Feeds Delphi; hands to Auriga + Vulcan._
