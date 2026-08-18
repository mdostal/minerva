// agent-setup.ts — agent harness setup, `minerva agent init`/`status` (agent-interactivity epic).
//
// Wires Minerva's MCP server into whatever AI coding agent CLIs are already on this machine
// (Claude Code, Codex CLI today) and installs the usage skill(s) this repo ships, without a human
// doing it by hand, one harness at a time. Modeled directly on the sibling Pantheon project
// Portunus's real, shipped `portunus agent init`/`status` (firefly-events/portunus PR #101).
//
// Zero secret/state surface, by construction: every operation here is local config plumbing (MCP
// server registration, copying markdown skill files) -- nothing here touches a run, a workspace,
// or the run-manager's on-disk state.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const AGENT_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "agent-skills");

// Ordered so agentInit()'s default target list (every present harness) has a stable, predictable
// order -- matters for tests and for readable output.
export const KNOWN_HARNESSES = ["claude", "codex"] as const;
export type Harness = (typeof KNOWN_HARNESSES)[number];

// Overridable per harness for testing -- same convention as agnostic-plan-driver.ts's
// OPENCODE_BIN/HIVE_PLAN_AGNOSTIC_CLI env-var seams (real fake-executable scripts in tests, not
// framework-level mocking). Defaults to the real binary name.
function binFor(harness: string): string {
  if (harness === "claude") return process.env.MINERVA_CLAUDE_BIN ?? "claude";
  if (harness === "codex") return process.env.MINERVA_CODEX_BIN ?? "codex";
  return harness;
}

function commandExists(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectHarnesses(): Record<Harness, boolean> {
  return Object.fromEntries(
    KNOWN_HARNESSES.map((name) => [name, commandExists(binFor(name))]),
  ) as Record<Harness, boolean>;
}

// Best-effort, targeted per-server lookup -- never the harness's full `mcp list`. Real-world
// finding (mirrors Portunus's own): Claude Code's `mcp list` health-checks EVERY registered
// server, including slow/unreachable ones -- 30+ seconds on a machine with several configured.
// `mcp get <name>` is a fast, targeted lookup. Codex's own `mcp list` has no such per-server
// health check, so it's safe to use directly. False on any failure; never assumes registered
// when it can't tell.
export function mcpRegistered(harness: string): boolean {
  // "Not registered" is an expected, routine outcome (every fresh init hits it at least once
  // per harness) -- both CLIs write an error line to stderr in that case (e.g. claude's "No MCP
  // server named ..."). Explicitly pipe (not inherit) stderr so that expected-failure noise never
  // leaks into a caller's terminal; only stdout is read.
  let stdout: string;
  try {
    if (harness === "claude") {
      stdout = execFileSync(binFor("claude"), ["mcp", "get", "minerva"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } else if (harness === "codex") {
      stdout = execFileSync(binFor("codex"), ["mcp", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } else {
      return false;
    }
  } catch {
    return false;
  }
  return stdout.includes("minerva");
}

// Registers `minerva mcp` with the given harness. Idempotent -- a no-op success if already
// registered, so re-running init is always safe.
export function registerMcp(harness: string): boolean {
  if (mcpRegistered(harness)) return true;
  let args: string[];
  if (harness === "claude") {
    args = ["mcp", "add", "--scope", "user", "minerva", "--", "minerva", "mcp"];
  } else if (harness === "codex") {
    args = ["mcp", "add", "minerva", "--", "minerva", "mcp"];
  } else {
    return false;
  }
  try {
    execFileSync(binFor(harness), args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Names of every packaged usage skill (directory name == skill name).
export function skillNames(): string[] {
  if (!existsSync(AGENT_SKILLS_DIR)) return [];
  return readdirSync(AGENT_SKILLS_DIR)
    .filter((name) => existsSync(join(AGENT_SKILLS_DIR, name, "SKILL.md")))
    .sort();
}

function skillsDest(dest?: string): string {
  return dest ?? join(homedir(), ".claude", "skills");
}

export function skillsInstalled(dest?: string): Record<string, boolean> {
  const target = skillsDest(dest);
  return Object.fromEntries(
    skillNames().map((name) => [name, existsSync(join(target, name, "SKILL.md"))]),
  );
}

function filesEqual(a: string, b: string): boolean {
  return readFileSync(a, "utf8") === readFileSync(b, "utf8");
}

// Copies every packaged skill into dest, creating it if needed. Overwrites only when the content
// actually differs, so re-running this is silent when nothing changed. Returns the names actually
// (re)written.
export function installSkills(dest?: string): string[] {
  const target = skillsDest(dest);
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  for (const name of skillNames()) {
    const srcFile = join(AGENT_SKILLS_DIR, name, "SKILL.md");
    const destDir = join(target, name);
    const destFile = join(destDir, "SKILL.md");
    if (existsSync(destFile) && statSync(destFile).isFile() && filesEqual(srcFile, destFile)) {
      continue;
    }
    mkdirSync(destDir, { recursive: true });
    writeFileSync(destFile, readFileSync(srcFile, "utf8"));
    written.push(name);
  }
  return written;
}

// Combined report: which harnesses are present, which have the MCP server registered, and which
// usage skills are installed. `only` narrows harnesses/mcp_registered to just those names (same
// shape as agentInit's `only`); skills stay Claude-scoped regardless -- they're not really a
// per-harness concept, they're a Claude-Code-install concept.
export function agentStatus(only?: string[], dest?: string): Record<string, unknown> {
  const harnessNames = only ?? KNOWN_HARNESSES;
  const allHarnesses = detectHarnesses();
  const harnesses = Object.fromEntries(harnessNames.map((name) => [name, allHarnesses[name as Harness] ?? false]));
  return {
    harnesses,
    mcp_registered: Object.fromEntries(
      harnessNames.map((name) => [name, harnesses[name] ? mcpRegistered(name) : false]),
    ),
    skills: only && !only.includes("claude") ? {} : skillsInstalled(dest),
  };
}

// Idempotent, best-effort setup across every detected (or explicitly requested via `only`)
// harness. One harness failing to register never blocks the others -- each is attempted and
// reported independently. Skills are Claude-Code-specific (Codex has no equivalent mechanism
// today), so they're only installed when "claude" is among the actual targets -- an explicit
// only=["codex"] leaves them untouched even if Claude Code also happens to be present.
export function agentInit(only?: string[], dest?: string): Record<string, unknown> {
  const harnesses = detectHarnesses();
  const targets = only ?? KNOWN_HARNESSES.filter((name) => harnesses[name]);
  const mcpResults = Object.fromEntries(targets.map((name) => [name, registerMcp(name)]));
  const skillsWritten = targets.includes("claude") ? installSkills(dest) : [];
  return {
    harnesses,
    requested: targets,
    mcp_registered: mcpResults,
    skills_installed: skillsWritten,
  };
}
