# Q — MVP boundary (the one that matters)

**v1 = a standalone, local, human-invoked, file-gated idea-to-spec runner.** Smallest useful:
human drops an idea → Minerva runs kickoff+plan → surfaces questions → manual approve → emits the
approved epic. **Async + parallel** (several at once). Everything else is v2 behind contracts.

- **Delphi integration → v2.** v1 uses a **stopgap question surface** (file-based questions +
  rendered docs, like we do by hand today). Swap to real Delphi when it exists — via the contract.
- **Multica remote dispatch → v2.** v1 runs **locally** (SSH'd in, like today). Remote/multi-agent
  dispatch comes in v2.
- **votem approval gate → v2.** v1 uses a **manual "yes, proceed" checkpoint.** Real votem/quorum
  wiring is v2.

**NEVER (out of scope entirely, not just later):**
- Never auto-approve / skip the human gate — a human must approve the spec before it hands off.
- Never let Minerva **execute** work — it only plans → hands off (Auriga executes).
- Never let Minerva **route** (that's Auriga) or **provision repos** (that's Vulcan).
- No GHA; no rogue-overwrite; no advancing unlocked/untested parts.

## REFINEMENT (2026-07-24) — the async mechanism is an AGENT OPERATOR, not a UI
The file-based stopgap doesn't actually make v1 async (someone still has to watch/answer). The
real v1 async mechanism = **an agent operator (Claude / any agent) drives Minerva**: kicks it off,
monitors it, and answers its questions — escalating only genuinely-strategic calls to the human.
This is exactly how Claude ran the Auriga kickoff/plan this session. So:
- **v1 REQUIREMENT: Minerva must be AGENT-DRIVABLE** — a programmatic kickoff + Q&A interface an
  agent can operate (not just interactive terminal prompts). This same interface IS the
  service/Auriga path, so it is not throwaway.
- **Delphi = v2** (the nicer *human* surface; NOT required for v1's async — the agent operator is).
- **votem = v2** (v1 = a manual "yes, proceed" on the escalated decisions).
- **Multica remote dispatch = v2** (v1 runs local/SSH).
