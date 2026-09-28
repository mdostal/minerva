// Test-run guard: refuse any fetch() that targets a live Consus instance.
//
// Loaded by `npm test` via `--import`, and appended to NODE_OPTIONS so every
// node subprocess a test spawns (bin/minerva.ts via tsx, etc.) loads it too.
// Plain JS on purpose: plain `node` children must be able to load it.
//
// Why (PANT-920): 77 "What is your favorite fruit?" / "Unknown command:
// /plugin-hive:plan" / "Pick an option for gate N" items landed in the live
// Consus decision queue because Minerva test runs posted parked questions to
// whatever Consus answered on localhost:8722. Tests must never have side
// effects on live systems; a test that needs a Consus stands up its own fake
// on an ephemeral port.

const CONSUS_PORT = "8722";

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Consus URLs from the ambient environment, captured before any test mutates env.
const liveOrigins = new Set(
  [process.env.CONSUS_URL, process.env.JANUS_CONSUS].map(originOf).filter(Boolean),
);

export function isLiveConsusUrl(input) {
  let url;
  try {
    url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return (
    url.port === CONSUS_PORT ||
    url.hostname === "consus" ||
    url.hostname.endsWith(".ts.net") ||
    liveOrigins.has(url.origin)
  );
}

if (!globalThis.__minervaNoLiveConsusGuard) {
  globalThis.__minervaNoLiveConsusGuard = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = function guardedFetch(input, init) {
    if (isLiveConsusUrl(input)) {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.reject(
        new Error(
          `refusing to reach a live Consus from a test run: ${target} ` +
            "(tests/setup/no-live-consus.mjs, PANT-920). Use a fake server on an ephemeral port.",
        ),
      );
    }
    return realFetch(input, init);
  };

  const importFlag = `--import=${new URL(import.meta.url).href}`;
  if (!(process.env.NODE_OPTIONS ?? "").includes(importFlag)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${importFlag}`.trim();
  }
}
