# 002 — ForkedHiveDriver's Production Path Depends on an Unmerged PR

**Status:** open dependency, tracked · **recheck_by: 2026-09-13**

---

## The gap

`ForkedHiveDriver` (`src/driver.ts`) is the driver implementation that fixes the orphaning risk
the swappable-driver epic exists to address, by driving plugin-hive's real structured
headless-question protocol instead of prose-scraping a driven turn's output. That protocol is
shipped in **`firefly-events/plugin-hive#341`** (branch `feat/headless-question-protocol`) — and
as of this writing, PR #341 is **unmerged**.

The class header comment in `src/driver.ts` (lines ~699-737) states this directly. Quoted
verbatim:

> ```
> // ForkedHiveDriver (forked-driver-integration epic) -- drives the real headless-question-
> // protocol shipped in firefly-events/plugin-hive#341 (branch feat/headless-question-protocol).
> // Unlike SpawnDriver/SubagentDriver, this driver does NOT keep a live session across the
> // question-wait boundary at all -- there is no process running while a question sits
> // unanswered, because the protocol hands off via a FILE (.pHive/questions/*.yaml), not a
> // tracked background job or a resumed conversation. This is the actual fix for the orphaning
> // risk the whole swappable-driver epic exists to address.
> ...
> // TESTING: point MINERVA_HIVE_PLUGIN_DIR at a local plugin-hive-fork checkout to test/drive
> // against the fork directly (via `claude --plugin-dir`) before PR #341 ships in a real release
> // -- unset in production once the protocol is installed via the normal marketplace mechanism.
> ```

And `src/envelope-detection.ts`'s module header comment (lines 1-10), quoted verbatim:

> ```
> // Envelope detection + parsing (forked-driver-integration epic) — read-only detection and
> // parsing of `.pHive/questions/<skill>-<invocation-id>.yaml` envelope files, mirroring
> // output-emitter.ts's findCompletedEpic directory-scan pattern. Full schema:
> // hive/references/question-envelope-schema.md in plugin-hive-fork.
> //
> // LOAD-BEARING (confirmed via the epic's own spike + PR #341's review): envelopes are DELETED
> // by the gateway the instant it consumes a status: answered one -- absence is a legitimate,
> // common state, never an error. Every function here is strictly read-only: no write, delete, or
> // mutation path exists in this module. Consuming (writing an answer + triggering deletion) is
> // the real driver implementation's own job, not this module's.
> ```

## Which path is production, which is testing — today

`pluginDirArgs()` in `src/driver.ts` reads the `MINERVA_HIVE_PLUGIN_DIR` environment variable to
decide whether to pass a `--plugin-dir` flag to `claude`:

- **`MINERVA_HIVE_PLUGIN_DIR` set** (points at a local `plugin-hive-fork` checkout) — this is the
  **only path that actually carries the headless-question protocol today**. It is explicitly a
  *testing* stopgap: it drives `claude` directly against the unmerged fork branch via
  `--plugin-dir`, ahead of PR #341 landing in a real release.
- **`MINERVA_HIVE_PLUGIN_DIR` unset** — this is the *intended* production path: `claude` relies on
  whatever `plugin-hive` is installed via the normal marketplace mechanism. **This path does not
  yet carry the protocol**, because the marketplace-distributed `plugin-hive` does not yet include
  PR #341's changes. Running `ForkedHiveDriver` in this configuration today will not behave as
  designed.

In short: the code is written as if the production path exists, but it doesn't yet — the only
configuration that has ever been exercised end-to-end is the local-fork-checkout testing path.
This is confirmed by `docs/architecture.md`'s own as-built note that `ForkedHiveDriver` was
"tested exclusively against a local fork checkout via `--plugin-dir`
(`MINERVA_HIVE_PLUGIN_DIR`), not the marketplace-installed plugin-hive, ahead of PR #341 merging
upstream."

## Why this matters

This is the single most load-bearing external dependency for `ForkedHiveDriver`: until PR #341
merges (or an equivalent protocol lands via the normal marketplace mechanism), there is no
production-viable way to run `MINERVA_DRIVER=forked` against a real marketplace install of
plugin-hive. Any planning or rollout work that assumes `ForkedHiveDriver` is production-ready
needs to account for this — either by keeping `MINERVA_DRIVER=forked` gated to environments that
set `MINERVA_HIVE_PLUGIN_DIR`, or by blocking on PR #341.

## Recheck

**recheck_by: 2026-09-13**

Per this project's existing convention (see `docs/decisions/kickoff-review.md`'s and the triage
queue schema's operator-driven-recheck posture — time-based auto-advance is deliberately
operator-driven, not automated), re-checking this dependency is a manual, dated action, not new
tooling. To recheck:

1. Run:
   ```
   gh pr view 341 --repo firefly-events/plugin-hive --json state,reviewDecision,updatedAt
   ```
2. Update this doc's status line based on the result:
   - Still open → bump `recheck_by` another 30 days and note the check in this file.
   - Merged → update this doc's **Status** to reflect that the production path now exists, and
     flag `src/driver.ts`'s `pluginDirArgs()` comment and `docs/architecture.md`'s as-built note
     for a follow-up story to drop the "ahead of PR #341 merging upstream" caveat and validate
     `MINERVA_DRIVER=forked` against the real marketplace-installed plugin-hive.
