# Q — Competitive landscape
**The real alternative is literally hand-running `/hive:kickoff` + `/hive:plan` per idea in a
terminal** — the current pain (serial, babysat, one-at-a-time, unreadable in a shell).
No off-the-shelf tool does "idea → autonomous kickoff/plan → human-gated → approved spec, in
parallel": PM/AI tools (Linear/Notion AI, PRD generators) are surface-level doc helpers, and the
agent frameworks (LangGraph/CrewAI/etc., from Auriga's CBA) are *execution* frameworks, not
idea-to-spec-with-gates. So: **the bar is "better than by hand"** (async, parallel, non-babysat),
and the **moat is wrapping plugin-hive's proven kickoff+plan as a parallel, human-gated planning
service.** A full external-tool CBA is overkill here (unlike Auriga's 5 prior attempts + real
market) — the differentiator is clear.
