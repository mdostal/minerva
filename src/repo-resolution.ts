// Repo Resolution (PAN-6745, autonomy unlock) — guarantees every seed ends up targeting a real,
// buildable git repo, so a finished plan can be committed + pushed for downstream build agents.
//
// WHY THIS EXISTS: run-manager's allocateRun uses a throwaway `fresh_init` scratch git whenever a
// seed carries NO target repo. A plan produced in a fresh_init workspace is never committed to any
// real repo, so downstream build agents self-block ("no committed plan to check out"). That is the
// single seam where headless autonomy broke: the plan was genuinely produced, but never landed
// anywhere a build agent could reach it (the only work that ever built had its plan committed to a
// real repo BY HAND). This module closes that seam by resolving a real target repo for every seed,
// so the worktree path (which cuts a run-scoped branch off the repo's `dev` and can be committed +
// pushed — see output-emitter.commitAndPushPlan) is used instead of fresh_init.
//
// Config-driven, never hard-coded god names in code (matches this project's env-var config idiom,
// cf. MINERVA_PLAN_DEFAULTS in plan-defaults.ts):
//   - MINERVA_REPO_MAP       — path to a YAML/JSON file mapping component/god keys -> local repo
//                              paths, used to resolve god-scoped work to that god's repo.
//   - MINERVA_INCUBATOR_REPO — a single local repo path used as the greenfield fallback when a
//                              seed matches no explicit repo and no god.
//
// Backwards-compatible: with neither env var set, greenfield seeds resolve to `undefined` and the
// caller keeps the exact legacy fresh_init behavior (so every existing test/caller is unaffected).

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { MinervaError } from "./errors.ts";

export type RepoResolutionSource = "explicit" | "god" | "incubator" | "none";

export interface ResolvedTarget {
  // The local git repo path to allocate a worktree against, or `undefined` when nothing resolved
  // (greenfield with no incubator configured -> caller keeps legacy fresh_init behavior).
  repo: string | undefined;
  source: RepoResolutionSource;
  // Human-readable rationale, persisted on the run record and useful in logs.
  reason: string;
}

// Load the component/god -> repo-path map from MINERVA_REPO_MAP (a YAML/JSON file). Absent env ->
// empty map (god resolution simply never fires). Invalid file/shape fails loudly rather than being
// silently ignored, matching this project's "never guess" config discipline.
function loadRepoMap(): Record<string, string> {
  const path = process.env.MINERVA_REPO_MAP;
  if (!path) return {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `Could not read MINERVA_REPO_MAP file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    // parseYaml handles JSON too (JSON is a subset of YAML), so one path covers both file forms.
    parsed = parseYaml(raw);
  } catch (e) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `Could not parse MINERVA_REPO_MAP file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `MINERVA_REPO_MAP file ${path} must be a map of component-key -> repo-path`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string" || v.length === 0) {
      throw new MinervaError("VALIDATION_FAILED", `MINERVA_REPO_MAP["${k}"] must be a non-empty string repo path`);
    }
    out[k] = v;
  }
  return out;
}

// Escape a map key for safe use inside a whole-word RegExp (keys are operator-authored, not
// hostile, but a key like "c++" would otherwise be an invalid/greedy pattern).
function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Deterministic god/component match: the FIRST map key — in case-insensitive sorted order, so the
// result never depends on the config file's key ordering — whose lowercased key appears as a whole
// word in the lowercased idea text. Whole-word (\b) so a short key never matches inside an
// unrelated longer token. Returns null when nothing matches.
function matchGodRepo(idea: string, map: Record<string, string>): { key: string; repo: string } | null {
  const lower = idea.toLowerCase();
  const keys = Object.keys(map).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const key of keys) {
    const k = key.toLowerCase();
    if (k.length === 0) continue;
    const re = new RegExp(`\\b${escapeForRegExp(k)}\\b`);
    if (re.test(lower)) return { key, repo: map[key]! };
  }
  return null;
}

// Resolve a build-target repo for a seed. Priority, highest first:
//   1. explicit — the seed carried a target_repo (metadata/field). Use it verbatim (this is the
//      already-working worktree path via allocateWorktreeWorkspace).
//   2. god      — the idea names a known component/god in MINERVA_REPO_MAP -> that god's repo.
//   3. incubator — greenfield seed, no explicit repo, no god match -> MINERVA_INCUBATOR_REPO, when
//      configured. This is the deterministic, config-driven fallback that replaces the silent
//      fresh_init scratch for greenfield work.
//   4. none     — nothing configured -> `undefined`. The caller keeps legacy fresh_init behavior.
//      This is the ONE remaining path where a plan is not pushed anywhere, and it is a
//      deployment-config gap (operator must set MINERVA_INCUBATOR_REPO), not a code gap. See
//      PAN-6745 notes on where incubator repos should live.
export function resolveTargetRepo(opts: { explicit?: string | undefined; idea: string }): ResolvedTarget {
  if (opts.explicit && opts.explicit.length > 0) {
    return { repo: opts.explicit, source: "explicit", reason: "seed carried an explicit target_repo" };
  }

  const god = matchGodRepo(opts.idea, loadRepoMap());
  if (god) {
    return { repo: god.repo, source: "god", reason: `idea matched god/component "${god.key}" in MINERVA_REPO_MAP` };
  }

  const incubator = process.env.MINERVA_INCUBATOR_REPO;
  if (incubator && incubator.length > 0) {
    return { repo: incubator, source: "incubator", reason: "greenfield seed -> configured MINERVA_INCUBATOR_REPO" };
  }

  return {
    repo: undefined,
    source: "none",
    reason: "no explicit repo, no god match, no incubator configured -> fresh_init scratch (plan will NOT be pushed)",
  };
}
