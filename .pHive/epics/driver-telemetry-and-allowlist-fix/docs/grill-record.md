# Grill Record — driver-telemetry-and-allowlist-fix

**Source draft:** .pHive/epics/driver-telemetry-and-allowlist-fix/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** absent (heuristic pass)
**round_number:** 1
**unresolved_count:** 1
**Generated:** 2026-08-20T00:20:00Z

## Summary

- Vocabulary mismatches: clean
- Hidden assumptions: 1 finding
- Unresolved tensions: clean
- Convention violations: clean
- Posture mismatches: clean

## Hidden assumptions

- **H1** — §2a claims "`MINERVA_HOME` resolution matches the existing convention... so tests get
  free isolation the same way every other `MINERVA_HOME`-scoped test already does, no new test
  seam needed." Verified false by reading the actual test file: `src/real-forked-hive-driver.test.ts`'s
  `before()`/`after()` hooks (lines 26-35) set `MINERVA_HEIMDALL_AVAILABLE_ROUTE_URL` and
  `MINERVA_HIVE_PLUGIN_DIR` but never `MINERVA_HOME` — `grep -n "MINERVA_HOME"
  src/real-forked-hive-driver.test.ts` returns nothing.
  - Draft location: §2a, "no new test seam needed"
  - Why this matters: without adding a `MINERVA_HOME` override to this test file, a test that
    exercises `ForkedHiveDriver.runTurn()` and triggers `emitTelemetryEvent` would write real
    JSONL files to the developer's actual `~/.minerva/events/` directory during test runs —
    exactly the kind of test-hygiene bug this codebase has repeatedly caught and fixed elsewhere
    (e.g. the sibling `fix-test-suite-flakiness-t006`/`minerva-value-audit` epics' seed-repo and
    fork-path hermeticity fixes).
  - Question for planner: the test-spec step must ADD a `MINERVA_HOME` override
    (`mkdtempSync`-based, matching the pattern already used elsewhere in this codebase, e.g.
    `run-manager.test.ts`) to this test file's `before()`/`after()` hooks — not assume it already
    exists.

## Unresolved tensions

No findings.

## Convention violations

No findings.

## Posture mismatches

No findings — both changes stay within "Minerva only plans" (observability/validation, not
execution/routing/provisioning), and telemetry write failures are deliberately NOT swallowed,
matching the project's fail-loud discipline (CONTEXT.md conventions).

## Notes

None.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize findings. H1 ends with a
question for the planner; the planner's job is to revise the draft (or document an accepted
deviation) before stories are written.
