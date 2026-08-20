# Minerva v0.3.0 Video Script

## Hook

Today we are shipping Minerva v0.3.0: Surfaced by a round-2 /grill pass on the just-shipped harden-run-id-and-target-repo-boundaries epic (triage t-011).

## Highlights

1. Surfaced by a round-2 /grill pass on the just-shipped harden-run-id-and-target-repo-boundaries epic (triage t-011). (driver-telemetry-and-allowlist-fix/allowlist-skip-local-path-slug-derivation)
2. Recovered from a stale, never-merged PR (#57, opened 2026-08-11) that proposed a real, genuinely-still-missing capability -- confirmed via grep that neither src/telemetry.ts nor any driver_started/driver_succeeded/driver_failed reference exists anywhere on dev/main today. (driver-telemetry-and-allowlist-fix/driver-lifecycle-telemetry)

## Call To Action

Read the release details and try it from https://github.com/mdostal/minerva.

## Source Stories

- driver-telemetry-and-allowlist-fix/allowlist-skip-local-path-slug-derivation: Skip unnecessary git shell-out for local-path allowlist entries - .pHive/epics/driver-telemetry-and-allowlist-fix/stories/allowlist-skip-local-path-slug-derivation.yaml
- driver-telemetry-and-allowlist-fix/driver-lifecycle-telemetry: driver_started/driver_succeeded/driver_failed telemetry for ForkedHiveDriver - .pHive/epics/driver-telemetry-and-allowlist-fix/stories/driver-lifecycle-telemetry.yaml
