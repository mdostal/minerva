# Research Brief — epic `agent-drivable-core`

## Scope of research

Minerva v1 is a fresh greenfield build — no source code exists yet (`docs/` only). "Codebase
research" here means: (1) re-grounding in the project's own committed planning chain, which is
unusually complete for a greenfield kickoff (discovery brief → PRD → architecture → a validated
PoC spike), and (2) scanning sibling Pantheon repos for real conventions to match, since
Minerva is not being built in isolation.

## NORTH STAR
(from `.pHive/project-profile.yaml`, written at `/hive:kickoff`)
- **Goal:** Turn an idea into an approved, planned spec autonomously by running kickoff+plan.
  v1: an agent operator drives the Q&A and escalates strategic decisions to a human gate; v2
  upgrades the human surface to Delphi and wires Auriga/Vulcan/Multica/votem behind contracts.
- **Audience:** Both the human operator and other Pantheon services — Minerva is invoked
  directly by a person AND by Auriga's routing (v2).
- **Scale:** Low concurrency per instance, but must support many separate Minerva runs in
  parallel (one per repo / idea-intake session).
- **Pain points:** Manual per-idea kickoff over SSH doesn't scale; needs to run asynchronously
  with compute eventually pushed to Multica-managed boxes (v2).

## PRIOR DECISIONS
None found — `hive/lib/kg_why` (the knowledge-graph query helper) is not installed in this
consumer project; no prior-decision KG entries exist to surface. Treated as zero results per
the pre-flight contract (silent, no blocking).

## What's already decided (do not re-litigate)

The planning chain already resolved most of what a research phase would normally have to
discover:

- **`docs/initial-info.md`** — resolved discovery brief. v1 = standalone, agent-drivable;
  Delphi/Auriga/Vulcan/Multica/votem are all v2, each behind a contract.
- **`docs/prd.md`** — 8 requirements (REQ-01..08, 6 P0 + 2 P1) with Given/When/Then acceptance
  criteria. This is the traceability target for Phase C.
- **`docs/architecture.md`** — tech stack, components, API contract, data model, 5 architecture
  decisions (AD-1..AD-5), refined once already per `docs/decisions/kickoff-review.md`.
- **`docs/spike-plugin-hive-drivability-findings.md`** — Risk-A PoC spike, **GO**. Confirms
  `claude -p` headless invocation, clean stop-at-question, disk persistence, and
  `--resume`-based continuation all work against the real plugin-hive kickoff skill. One
  required follow-on identified: a **question-extraction step** (parse prose, since
  `AskUserQuestion` is unavailable headlessly) — this is not optional, it's load-bearing for
  REQ-02/REQ-03 and must appear as real story work, not be assumed away.

## Sibling-repo conventions (new research this phase)

Minerva is not an isolated project — it's one god among several on this box, and picking its
own scaffold conventions in a vacuum would create needless drift. Findings from scanning
`pantheon-orchestrator` (Auriga), `vulcan` (Builder — greenfield, nothing to copy yet), and
`plugin-hive`'s own subprocess-ABI adapters (the closest analog to what Minerva's CLI entrypoint
needs to do):

- **Package manager / module system:** npm, `"type": "module"`, `"engines": {"node": ">=20.19"}`
  (matches pantheon-orchestrator).
- **TypeScript, no build step:** `tsx` runs `.ts` directly — `tsconfig.json` with
  `target: ES2022`, `module`/`moduleResolution: NodeNext`, `strict: true`,
  `noUncheckedIndexedAccess: true`, `noEmit: true` (pantheon-orchestrator's exact settings).
  `vulcan` has no code yet, so nothing to reconcile there — it will presumably converge on the
  same pattern later.
- **Test runner:** `node:test` via `tsx --test` — confirmed in **both** pantheon-orchestrator
  (`"test": "tsx --test \"contracts/**/*.test.ts\" ..."`) and plugin-hive's own adapters
  (`"node --test --import tsx 'test/**/*.test.ts'"`). Not jest, not vitest. Matches what this
  epic's own spike test (`docs/spike-plugin-hive-drivability-spike.test.ts`) already used.
- **CLI-subprocess entrypoint pattern** (directly reusable for Minerva's `bin/minerva`, since
  AD-1 already committed to the same JSON-over-stdio ABI these adapters speak):
  - Shebang: `#!/usr/bin/env tsx` (plugin-hive's `github` adapter) or
    `#!/usr/bin/env -S npx tsx` (its `multica` adapter) — no compile step, ships as `.ts`.
  - `package.json` `"bin"` field points directly at the `.ts` file.
  - stdin read via **manual chunk concatenation**, not `readline`:
    `process.stdin.setEncoding("utf8")`, `.on("data", chunk => data += chunk)`,
    `.on("end", ...)`, then `JSON.parse`. (`hive/adapters/github/index.ts:437-440`,
    `hive/adapters/multica/index.ts:439-442` in the plugin-hive plugin cache.)
  - stdout via `process.stdout.write(JSON.stringify({result}))` or `{error}`, exit `0`/`1`.
    This is exactly AD-1's wire format — Minerva's `bin/minerva` should copy this pattern
    directly rather than reinvent it.
- **Lint/format:** no shared convention exists anywhere in the ecosystem (no eslint/prettier
  config in pantheon-orchestrator, vulcan, or plugin-hive's adapters). Minerva is free to stay
  config-free like its siblings — introducing one would itself be the drift.
- **CI:** local only, no GHA (matches this project's own stated discipline). Pantheon-orchestrator's
  pattern: `scripts/ci.sh` runs `npm test` then `npm run typecheck`, enforced via a `pre-push`
  git hook sample the developer copies in manually.

## Implication for story writing

Because a working, idiomatic reference implementation of "the exact wire format Minerva's
CLI needs to speak" already exists in this ecosystem (plugin-hive's adapters), the
CLI-entrypoint story should cite it directly as a code-pattern reference rather than design the
stdin/stdout handling from scratch. Same for the tsconfig/test-runner setup story — copy
pantheon-orchestrator's settings rather than re-deciding them.
