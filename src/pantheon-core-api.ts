// pantheon-core-api.ts — the single place Minerva resolves Pantheon core-api's base URL.
//
// Precedence: MINERVA_PANTHEON_CORE_API_URL > PANTHEON_CORE_API_URL > PANTHEON_API_URL.
// PANTHEON_API_URL is what the Pantheon runtime actually exports (e.g. http://core-api:3012);
// the other two are Minerva-specific overrides. Blank values count as unset. Returns null when
// none is set so each caller keeps its own failure policy (throw vs. fail-open).

export const PANTHEON_CORE_API_URL_VARS = [
  "MINERVA_PANTHEON_CORE_API_URL",
  "PANTHEON_CORE_API_URL",
  "PANTHEON_API_URL",
] as const;

export function resolvePantheonCoreApiUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const name of PANTHEON_CORE_API_URL_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export const PANTHEON_CORE_API_URL_MISSING =
  "Pantheon core-api URL not configured: set PANTHEON_API_URL, PANTHEON_CORE_API_URL or MINERVA_PANTHEON_CORE_API_URL";
