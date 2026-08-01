// Target-repo signal (Gate-2, PAN-6745 follow-on) — the seam that carries a build target from a
// RAW seed all the way down to the decomposed child stories AND into the target GitHub repo.
//
// The build lane (auriga-build.instructions.md) resolves the repo a story is built in from, in
// order: (a) a `target_repo: <value>` line in the story DESCRIPTION, else (b) the ticket's
// `metadata.target_repo`, else (c) an Auriga default. `<value>` may be an owner/repo slug, a git
// URL, or a local path. This module is Minerva's side of that same signal:
//
//   - parseTargetRepoLine  — read the `target_repo:` line the build lane reads (from a seed's
//                            description / idea prose).
//   - normalizeTargetRepoValue — turn a slug | git URL | local path into { slug, repoName }.
//   - resolveLocalCheckout — map a slug/URL to a LOCAL git checkout under the plugin-repo base
//                            (cloning on demand), guaranteeing a `dev` branch, so Minerva can cut
//                            a worktree and commit+push the planned bundle into that real repo.
//
// Config-driven (project idiom): MINERVA_REPO_CHECKOUT_BASE overrides where slugs are checked out;
// it defaults to ~/Documents/work/dostal/code, where the plugin repos already live.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Local base directory where target/plugin repos are checked out. A resolved owner/repo slug maps
// to <base>/<repo>. Config-driven so a different deployment can relocate it without a code change.
export function repoCheckoutBase(): string {
  return process.env.MINERVA_REPO_CHECKOUT_BASE ?? join(homedir(), "Documents", "work", "dostal", "code");
}

// Extract the FIRST `target_repo: <value>` line from a text blob — byte-for-byte the same signal
// the build lane reads. Case-insensitive key, whitespace-tolerant, value is the first token after
// the colon. Returns the trimmed value, or null when no such line exists.
export function parseTargetRepoLine(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = text.match(/^[ \t]*target_repo[ \t]*:[ \t]*(\S+)[ \t]*$/im);
  return m ? m[1]!.trim() : null;
}

// Classify + decompose a target_repo value into { slug, repoName }.
//   - owner/repo slug        -> slug="owner/repo", repoName="repo"
//   - GitHub URL (ssh/https) -> slug="owner/repo", repoName="repo"
//   - local filesystem path  -> slug=<derived from the checkout's origin remote, best-effort|null>,
//                               repoName=<last path segment>
export function normalizeTargetRepoValue(value: string): { slug: string | null; repoName: string } {
  const v = value.trim();

  // git@github.com:owner/repo(.git)  |  https://github.com/owner/repo(.git)
  const url = v.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (url) return { slug: `${url[1]}/${url[2]}`, repoName: url[2]! };

  // bare owner/repo slug (exactly one slash, no scheme, not a filesystem path)
  if (isSlug(v)) {
    const [owner, repo] = v.split("/");
    return { slug: `${owner}/${repo}`, repoName: repo! };
  }

  // local path -- derive a slug from its origin remote when the checkout already exists
  const localPath = expandHome(v);
  const repoName = localPath.replace(/\/+$/, "").split("/").pop() || localPath;
  let slug: string | null = null;
  try {
    const remote = execFileSync("git", ["-C", localPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const rm = remote.match(/github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
    if (rm) slug = `${rm[1]}/${rm[2]}`;
  } catch {
    // no checkout yet / no origin -- slug stays null (a path-only target still builds, just can't
    // be re-expressed as a slug for stamping onto child stories).
  }
  return { slug, repoName };
}

export interface ResolvedCheckout {
  // Absolute local git checkout path a worktree can be cut from (feeds allocateWorktreeWorkspace).
  localPath: string;
  // owner/repo slug to STAMP onto child stories + set as ticket metadata; null for a bare local
  // path whose origin remote could not be read.
  slug: string | null;
  // True iff this call cloned the repo (was previously absent locally).
  cloned: boolean;
}

// Map a target_repo value (slug | URL | local path) to a concrete LOCAL git checkout, cloning on
// demand and guaranteeing a `dev` branch exists so a run worktree can be cut from it.
//   - slug/URL   -> <base>/<repoName>, cloned from git@github.com:<slug>.git (or the URL) if absent.
//   - local path -> used verbatim (legacy --target-repo behavior), still dev-branch-guaranteed.
// Throws only on a genuine clone failure (a target that literally cannot be checked out).
export function resolveLocalCheckout(value: string): ResolvedCheckout {
  const v = value.trim();
  const { slug, repoName } = normalizeTargetRepoValue(v);
  const isUrl = /:\/\/|git@/i.test(v) || /github\.com[/:]/i.test(v);

  // A bare local path (absolute/home/relative or a multi-segment path that is not a slug): use it
  // as-is. This preserves the existing `--target-repo <abs path>` behavior exactly.
  if (!isUrl && !isSlug(v)) {
    const localPath = expandHome(v);
    ensureDevBranch(localPath);
    return { localPath, slug, cloned: false };
  }

  // Slug or URL -> a managed checkout under the repo base, cloned on demand.
  const localPath = join(repoCheckoutBase(), repoName);
  let cloned = false;
  if (!existsSync(localPath)) {
    const cloneUrl = isUrl ? v : `git@github.com:${slug}.git`;
    execFileSync("git", ["clone", cloneUrl, localPath], { stdio: "pipe" });
    cloned = true;
  }
  ensureDevBranch(localPath);
  return { localPath, slug, cloned };
}

// --- internals ------------------------------------------------------------------------------

function isSlug(v: string): boolean {
  return (
    !isAbsolute(v) &&
    !v.startsWith("~") &&
    !v.startsWith(".") &&
    !/:\/\/|git@/i.test(v) &&
    /^[\w.-]+\/[\w.-]+$/.test(v)
  );
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function tryGit(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Guarantee the checkout has a local `dev` branch for a worktree to be cut from. A freshly cloned
// repo only has its default branch checked out, so `dev` must be materialized. Best-effort refresh
// of local dev to origin/dev keeps run worktrees cut from current dev (Minerva is the only writer
// of these managed checkouts, and `dev` is never the checked-out branch of the bare/default clone,
// so a force-update of the ref is safe). Never throws -- a git hiccup here must not wedge planning.
function ensureDevBranch(localPath: string): void {
  tryGit(localPath, ["fetch", "origin", "--prune"]);
  const hasOriginDev = tryGit(localPath, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/dev"]);
  const hasLocalDev = tryGit(localPath, ["rev-parse", "--verify", "--quiet", "refs/heads/dev"]);
  if (hasOriginDev) {
    if (hasLocalDev) tryGit(localPath, ["branch", "-f", "dev", "origin/dev"]);
    else tryGit(localPath, ["branch", "dev", "origin/dev"]);
    return;
  }
  if (!hasLocalDev) {
    // No dev anywhere -> create it off the current default HEAD and publish it so the run branch
    // (and downstream build lane, which integrates into dev) has a real dev to target.
    tryGit(localPath, ["branch", "dev"]);
    tryGit(localPath, ["push", "-u", "origin", "dev"]);
  }
}

// Append the build-lane-readable `target_repo: <slug>` signal to a story description, so the
// decomposed child story carries its build target the same way the seed did. No-op when the slug
// is unknown or the description already declares one (never double-stamps). The line is also valid
// YAML (a top-level key), so it is harmless whether the description is read as text or as YAML.
export function stampTargetRepo(description: string, slug: string | null | undefined): string {
  if (!slug) return description;
  if (/^[ \t]*target_repo[ \t]*:/im.test(description)) return description;
  const sep = description.length > 0 && !description.endsWith("\n") ? "\n" : "";
  return `${description}${sep}target_repo: ${slug}\n`;
}

// Derive the owner/repo slug from a git checkout / run-workspace's OWN origin remote — the
// authoritative, foolproof build target: the repo the plan actually ran against. This is the
// forward-facing mirror of the one-off backfill rule (a story's target_repo = the git origin of
// its Minerva workspace). Returns null when the path is not a git repo or has no origin remote (a
// genuinely greenfield / fresh_init workspace), so a child story legitimately carries no
// target_repo rather than a guessed one — Minerva never invents a repo it cannot prove.
export function deriveRepoSlugFromWorkspace(workspacePath: string | undefined | null): string | null {
  if (!workspacePath) return null;
  try {
    const remote = execFileSync("git", ["-C", workspacePath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!remote) return null;
    return normalizeTargetRepoValue(remote).slug;
  } catch {
    return null;
  }
}
