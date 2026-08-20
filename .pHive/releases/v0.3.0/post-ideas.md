# Minerva v0.3.0 Post Ideas

## Channels

### Primary changelog

- Angle: Lead with the shipped outcomes and link to the release notes.
  - Emphasize: Surfaced by a round-2 /grill pass on the just-shipped harden-run-id-and-target-repo-boundaries epic (triage t-011). (driver-telemetry-and-allowlist-fix/allowlist-skip-local-path-slug-derivation)
  - Emphasize: Recovered from a stale, never-merged PR (#57, opened 2026-08-11) that proposed a real, genuinely-still-missing capability -- confirmed via grep that neither src/telemetry.ts nor any driver_started/driver_succeeded/driver_failed reference exists anywhere on dev/main today. (driver-telemetry-and-allowlist-fix/driver-lifecycle-telemetry)

### Team update

- Angle: Emphasize why the shipped work matters for current users and operators.
  - Emphasize: Surfaced by a round-2 /grill pass on the just-shipped harden-run-id-and-target-repo-boundaries epic (triage t-011). (driver-telemetry-and-allowlist-fix/allowlist-skip-local-path-slug-derivation)
  - Emphasize: Recovered from a stale, never-merged PR (#57, opened 2026-08-11) that proposed a real, genuinely-still-missing capability -- confirmed via grep that neither src/telemetry.ts nor any driver_started/driver_succeeded/driver_failed reference exists anywhere on dev/main today. (driver-telemetry-and-allowlist-fix/driver-lifecycle-telemetry)

## Reusable Highlights

- Surfaced by a round-2 /grill pass on the just-shipped harden-run-id-and-target-repo-boundaries epic (triage t-011). (driver-telemetry-and-allowlist-fix/allowlist-skip-local-path-slug-derivation)
- Recovered from a stale, never-merged PR (#57, opened 2026-08-11) that proposed a real, genuinely-still-missing capability -- confirmed via grep that neither src/telemetry.ts nor any driver_started/driver_succeeded/driver_failed reference exists anywhere on dev/main today. (driver-telemetry-and-allowlist-fix/driver-lifecycle-telemetry)

## Source Stories

- driver-telemetry-and-allowlist-fix/allowlist-skip-local-path-slug-derivation: Skip unnecessary git shell-out for local-path allowlist entries - .pHive/epics/driver-telemetry-and-allowlist-fix/stories/allowlist-skip-local-path-slug-derivation.yaml
- driver-telemetry-and-allowlist-fix/driver-lifecycle-telemetry: driver_started/driver_succeeded/driver_failed telemetry for ForkedHiveDriver - .pHive/epics/driver-telemetry-and-allowlist-fix/stories/driver-lifecycle-telemetry.yaml
