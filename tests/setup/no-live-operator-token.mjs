// Test-run guard: never ask a live core-api for the operator token (PANT-1093).
//
// src/operator-token.ts injects the token onto /pantheon-secrets through core-api's
// /api/secrets/inject. Inside the Pantheon runtime container that volume is mounted and
// PANTHEON_API_URL points at the live core-api, so a test run would fetch a real secret onto the
// shared volume on every route/select or backlog write it exercises. Tests that cover the token
// client pass their own env/fetch/fs seams instead.
//
// Loaded by `npm test` via `--import`, and appended to NODE_OPTIONS so every node subprocess a
// test spawns with the inherited NODE_OPTIONS loads it too, even if its env otherwise drops the flag.

process.env.MINERVA_OPERATOR_TOKEN_INJECT = "off";

const importFlag = `--import=${new URL(import.meta.url).href}`;
if (!(process.env.NODE_OPTIONS ?? "").includes(importFlag)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${importFlag}`.trim();
}
