// target-repo-signal.test.ts — Gate-2 seam that carries a build target from a raw seed into the
// child stories + the target repo. Pure/git-local tests: parsing + normalization + stamping, plus
// a real clone-on-demand + dev-branch guarantee against a local bare "remote" (no network).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseTargetRepoLine,
  normalizeTargetRepoValue,
  stampTargetRepo,
  resolveLocalCheckout,
  repoCheckoutBase,
} from "./target-repo-signal.ts";

const cleanups: string[] = [];
const savedBase = process.env.MINERVA_REPO_CHECKOUT_BASE;
afterEach(() => {
  if (savedBase === undefined) delete process.env.MINERVA_REPO_CHECKOUT_BASE;
  else process.env.MINERVA_REPO_CHECKOUT_BASE = savedBase;
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

test("parseTargetRepoLine: reads the first target_repo: line, case/whitespace tolerant", () => {
  assert.equal(parseTargetRepoLine("do a thing\n\ntarget_repo: mdostal/cron-maker\n"), "mdostal/cron-maker");
  assert.equal(parseTargetRepoLine("Target_Repo:   owner/repo  "), "owner/repo");
  assert.equal(parseTargetRepoLine("no signal here"), null);
  assert.equal(parseTargetRepoLine(""), null);
  assert.equal(parseTargetRepoLine(undefined), null);
});

test("normalizeTargetRepoValue: slug, ssh URL, and https URL all yield owner/repo + repoName", () => {
  assert.deepEqual(normalizeTargetRepoValue("mdostal/cron-maker"), { slug: "mdostal/cron-maker", repoName: "cron-maker" });
  assert.deepEqual(normalizeTargetRepoValue("git@github.com:mdostal/cron-maker.git"), { slug: "mdostal/cron-maker", repoName: "cron-maker" });
  assert.deepEqual(normalizeTargetRepoValue("https://github.com/mdostal/cron-maker"), { slug: "mdostal/cron-maker", repoName: "cron-maker" });
});

test("stampTargetRepo: appends the build-lane signal, never double-stamps, no-op on null slug", () => {
  assert.equal(stampTargetRepo("id: s1\ntitle: X\n", "mdostal/cron-maker"), "id: s1\ntitle: X\ntarget_repo: mdostal/cron-maker\n");
  // already declared -> unchanged
  const already = "id: s1\ntarget_repo: a/b\n";
  assert.equal(stampTargetRepo(already, "mdostal/cron-maker"), already);
  // unknown slug -> unchanged
  assert.equal(stampTargetRepo("id: s1\n", null), "id: s1\n");
});

test("repoCheckoutBase: honors MINERVA_REPO_CHECKOUT_BASE override", () => {
  process.env.MINERVA_REPO_CHECKOUT_BASE = "/tmp/some-base";
  assert.equal(repoCheckoutBase(), "/tmp/some-base");
});

// Stand up a local bare "GitHub" with a dev branch, then prove resolveLocalCheckout clones a slug
// on demand into the configured base and guarantees a local dev branch to cut a worktree from.
test("resolveLocalCheckout: clones a slug on demand under the base and guarantees a dev branch", () => {
  const root = mkdtempSync(join(tmpdir(), "minerva-trs-"));
  cleanups.push(root);

  // seed repo -> push main + dev into a bare remote named like the slug's repo
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-q", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "# owner/widget\n");
  execFileSync("git", ["-C", seed, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  execFileSync("git", ["-C", seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
  const bare = join(root, "widget.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["-C", seed, "remote", "add", "origin", bare]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "main"]);
  execFileSync("git", ["-C", seed, "branch", "dev"]);
  execFileSync("git", ["-C", seed, "push", "-q", "origin", "dev"]);

  const base = join(root, "checkouts");
  execFileSync("mkdir", ["-p", base]);
  process.env.MINERVA_REPO_CHECKOUT_BASE = base;

  // Resolve by a file:// URL (so the test needs no github.com / network); the `://` marks it a
  // clone URL and repoName ("widget.git") drives the local dir name under the base.
  const fileUrl = "file://" + bare;
  const r = resolveLocalCheckout(fileUrl);
  assert.ok(existsSync(r.localPath), `expected a local checkout at ${r.localPath}`);
  assert.equal(r.cloned, true);
  assert.equal(r.localPath, join(base, "widget.git"));
  // a local dev branch must exist so allocateWorktreeWorkspace can cut run/<id> from it
  const branches = execFileSync("git", ["-C", r.localPath, "branch", "--list", "dev"], { encoding: "utf8" });
  assert.match(branches, /dev/, "resolveLocalCheckout must guarantee a local dev branch");

  // second call is a no-op (already cloned)
  const r2 = resolveLocalCheckout(fileUrl);
  assert.equal(r2.cloned, false);
});

// Security regression test (found by a full-repo security review ahead of this project's first
// public release): a target_repo value can originate from a Multica ticket's free-text
// description/title (bin/minerva-plan.ts's --ticket flow via parseTargetRepoLine), not just an
// operator-typed CLI flag -- so it must be treated as untrusted, not just "some string that
// happens to look URL-ish." Proves the fix actually blocks the exploit at the git-subprocess
// boundary (GIT_ALLOW_PROTOCOL), not just that the code "looks" fixed.
test("resolveLocalCheckout: a git-clone-injection payload via the ext:: transport helper is blocked, not executed", () => {
  const root = mkdtempSync(join(tmpdir(), "minerva-trs-sec-"));
  cleanups.push(root);
  const base = join(root, "checkouts");
  execFileSync("mkdir", ["-p", base]);
  process.env.MINERVA_REPO_CHECKOUT_BASE = base;

  const canary = join(root, "pwned");
  // `%` is git's ext:: argument separator (git help remote-ext); `$IFS` stands in for a space so
  // the payload survives parseTargetRepoLine's \S+ (whitespace-free token) capture -- the exact
  // value shape that would arrive from a crafted ticket description's `target_repo:` line.
  const payload = `ext::sh%-c%touch$IFS${canary}%git@`;

  assert.throws(
    () => resolveLocalCheckout(payload),
    /GIT_ALLOW_PROTOCOL|protocol|not allowed/i,
    "expected git itself to refuse the ext:: transport, not silently run it",
  );
  assert.equal(existsSync(canary), false, "the injected command must never actually execute");
});
