# Research Brief: harden-run-id-and-target-repo-boundaries

Source: triage entry `t-008` (filed 2026-08-19 during the pre-public-release security review
that also produced the Critical git-clone-injection fix in `src/target-repo-signal.ts`, shipped
in v0.2.0). t-008 itself already contains a thorough, file:line-cited investigation — this brief
condenses it into planning inputs rather than re-deriving it from scratch.

## Finding 1 — `run_id` reaches a filesystem path join with no format check

- `src/run-manager.ts:132-136` (`runDir`/`runRecordPath`): `run_id` is joined directly into
  `join(runsRoot(), runId)` with zero validation beyond whatever the caller passed.
- Every entry point that accepts `run_id` from an external caller does so as an untyped
  `Record<string, unknown>` field, cast at the point of use: `src/run-manager.ts:332`,
  `src/kickoff-engine.ts:350` and `:387`, `src/output-emitter.ts:449`, `src/cleanup-ledger.ts:60`.
  None of these validate shape — only `typeof === "string"` (or nothing at all) before the value
  reaches a path join.
- `src/mcp-server.ts` declares `run_id: { type: "string" }` in every relevant tool's JSON Schema
  (`getRunStatus`, `getQuestions`, `submitAnswers`, `getOutput`, `abortRun` — lines 56-130) — MCP
  schema validation enforces "is a string," not "is a UUID."
- `allocateRun()` (the only legitimate producer of a `run_id`) always uses `randomUUID()` — so any
  non-UUID value reaching these functions is definitionally an external/malformed input, never a
  value Minerva itself generated.
- Exploitability is bounded: `readRunRecord()` (`run-manager.ts:159-165`) requires an existing,
  parseable `run.yaml` at the traversed path — there is no blind-write primitive, every write path
  requires a successful prior read. The trust model is same-privilege local execution (whoever can
  call the ABI already runs code with the operator's own permissions). This is why the original
  review classified it Informational, not Critical.
- Suggested fix (from t-008, confirmed reasonable): validate `run_id` against a UUID regex at the
  boundary — `dispatch.ts` for the stdin-JSON ABI, `mcp-server.ts` for the MCP tools — and reject
  non-matching values with `VALIDATION_FAILED` before they ever reach `run-manager.ts`.

## Finding 2 — `target_repo` has no allowlist for the worktree/commit/push trust boundary

- `src/kickoff-engine.ts:270-279` (`startRun`): `target_repo` (explicit param or resolved via
  `resolveTargetRepo`) is used directly as a `git -C <path> worktree add` target, then later as a
  commit+push destination.
- This is an intentional design feature, not an oversight — Minerva is meant to plan against an
  arbitrary local repo the operator names. There is no bug in the current behavior for the
  documented, intended caller (a trusted operator or the operator's own tooling).
- The gap: any MCP/ABI caller — including an LLM agent steered via prompt injection embedded in
  idea text — can direct Minerva to create a worktree against, and later commit+push into, *any*
  local repo path reachable on the operator's machine. There is currently no way to constrain this
  for a deployment where the calling agent is not fully trusted (e.g. a shared MCP server, or an
  agent that ingests untrusted third-party text into its idea prompts).
- Suggested fix (from t-008): an **optional** allowlist env var, e.g. `MINERVA_ALLOWED_TARGET_REPOS`
  (comma-separated slugs or paths), consulted only when set — preserves today's default-open
  behavior for the common trusted-operator case, and gives operators of less-trusted deployments an
  opt-in way to constrain it.

## Non-goals (explicitly out of scope, per t-008 and the original review's own severity call)

- Neither finding blocks or retroactively un-ships v0.2.0 — both are already-released-software
  hardening, not defects in currently-documented behavior.
- No change to the `git_clone_injection` fix already shipped (`GIT_ALLOW_PROTOCOL` in
  `target-repo-signal.ts`) — that's a different code path (cloning a *new* checkout) from this
  epic's scope (constraining which *existing* local repo path a worktree may target).
- No general-purpose sandboxing, auth, or multi-tenant isolation — that's a different, much larger
  scope than two hardening notes from a triage entry.

## Validation note

No third-party library/SDK involved — both fixes are pure Node.js (`node:crypto` `randomUUID`
regex shape already used elsewhere in the codebase, plus a plain env-var allowlist check). context7
validation not applicable.
