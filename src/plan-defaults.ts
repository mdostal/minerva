// Pre-baked plan defaults (prebaked-plan-defaults epic) — the auto-answer / "pre-decided
// operator answers" layer that lets a FRESH headless Minerva plan run drive kickoff+plan to
// completion without a human sitting on every gate question.
//
// WHY THIS EXISTS (and how it stays consistent with the architecture's "No Autonomous Progress"
// / AD-5 stance): AD-5 rejects *timeout-then-default-answer* — auto-approving a question just
// because a human was slow to respond. This module does something categorically different: it
// lets the operator PRE-DECIDE answers to the standard, routine kickoff/plan gate questions
// AHEAD OF TIME, and then supplies those answers through the exact same `submitAnswers` write
// path a human would use. It is the concrete "external system consumes the classification signal
// and decides the answer" role AD-2 explicitly leaves open for Vesta/Delphi in v2 — played here
// by a small, operator-authored, per-run-overridable config instead of a live human. It never
// fires on a timer, never guesses when genuinely uncertain, and (outside "auto" mode) never
// touches a question the classifier escalated to the `human` channel unless the operator gave an
// explicit answer for it. A question with no resolvable default still parks as
// `waiting_on_human`, unbounded, exactly as before (AD-5 preserved).
//
// Default posture is `mode: "off"` — i.e. a plain `startRun` with no defaults configured behaves
// EXACTLY as it did before this module existed (park every question), so every existing test and
// every existing caller is unaffected. Headless idea-builds opt in explicitly, per-run
// (`params.defaults`) or per-deployment (`MINERVA_PLAN_DEFAULTS_MODE` / a `MINERVA_PLAN_DEFAULTS`
// config file). "Overridable per-run" is a first-class requirement, not an afterthought.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { MinervaError } from "./errors.ts";
import type { Channel, QuestionKind } from "./run-manager.ts";

// mode:
//   "off"   — never auto-answer; park every question (backwards-compatible default).
//   "agent" — auto-answer questions the classifier routed to the `agent` channel (routine /
//             mechanical / pre-decided, per AD-2) plus any explicit operator `answers` match;
//             still park `human`-channel questions with no explicit answer (AD-5 preserved for
//             genuinely strategic gates). The recommended headless-idea-build posture.
//   "auto"  — fully unattended: auto-answer EVERY question for which a default resolves,
//             including `human`-channel ones. Only questions with no resolvable default at all
//             still park. Use when the whole point is "no human in the loop, complete or bust."
export type PlanDefaultsMode = "off" | "agent" | "auto";

// How to pick from a single/multi-select question's option list when no more specific rule
// (explicit answer, sign-off, tech-stack) applies.
//   "recommended" — prefer an option whose text looks like the safe/recommended/affirmative
//                    choice (recommend/default/yes/proceed/…); fall back to the first option.
//   "first"       — always take the first listed option.
export type SelectStrategy = "recommended" | "first";

// An operator-pre-decided answer to a specific gate question, matched by the envelope's own
// `qid` (exact) or by a case-insensitive substring of the question text. First match wins, so
// per-run rules (checked before file/built-in rules) override broader ones.
export interface AnswerRule {
  qid?: string;
  match?: string;
  answer: string | string[];
}

export interface PlanDefaults {
  mode: PlanDefaultsMode;
  // Auto-answer sign-off / approval / "ready to proceed?" gates affirmatively.
  skip_sign_off: boolean;
  // When set, answer tech-stack / language / framework questions with this string.
  tech_stack: string | null;
  select_strategy: SelectStrategy;
  // Default answer for free-text questions (and for prose questions from SpawnDriver/
  // SubagentDriver, which carry no `kind`). `{idea}` is interpolated with the run's idea brief.
  // Set to null to make free-text questions park instead of auto-answering.
  free_text_default: string | null;
  answers: AnswerRule[];
  // Hard ceiling on how many questions one drive sequence will auto-answer before giving up and
  // leaving the current question parked. A guardrail against a pathological loop, never a normal
  // stopping point for a real kickoff+plan (7 kickoff questions + a handful of plan gates).
  max_auto_answers: number;
  // Optional text appended to the INITIAL kickoff drive prompt (e.g. an explicit "skip the
  // sign-off gate" instruction). null = append nothing (unchanged prompt).
  drive_prompt_suffix: string | null;
}

// Built-in defaults. mode:"off" keeps a bare `startRun` byte-for-byte identical to pre-existing
// behavior. The non-mode fields carry sensible values so that flipping ONLY the mode (e.g.
// `MINERVA_PLAN_DEFAULTS_MODE=agent`) already yields a working headless run with zero further
// config.
export const BUILTIN_PLAN_DEFAULTS: PlanDefaults = {
  mode: "off",
  skip_sign_off: true,
  tech_stack: null,
  select_strategy: "recommended",
  free_text_default:
    "Use your best judgment consistent with the idea brief and proceed with sensible, " +
    "conventional defaults. Do not block on this — pick the most reasonable option and continue.",
  answers: [],
  max_auto_answers: 40,
  drive_prompt_suffix: null,
};

function validateMode(raw: unknown, source: string): PlanDefaultsMode {
  if (raw === "off" || raw === "agent" || raw === "auto") return raw;
  throw new MinervaError(
    "VALIDATION_FAILED",
    `Invalid plan-defaults mode "${String(raw)}" from ${source} -- expected "off", "agent", or "auto"`,
  );
}

function validateSelectStrategy(raw: unknown, source: string): SelectStrategy {
  if (raw === "recommended" || raw === "first") return raw;
  throw new MinervaError(
    "VALIDATION_FAILED",
    `Invalid select_strategy "${String(raw)}" from ${source} -- expected "recommended" or "first"`,
  );
}

function validateAnswerRules(raw: unknown, source: string): AnswerRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new MinervaError("VALIDATION_FAILED", `plan-defaults answers from ${source} must be an array`);
  }
  return raw.map((r, i) => {
    if (!r || typeof r !== "object") {
      throw new MinervaError("VALIDATION_FAILED", `plan-defaults answers[${i}] from ${source} must be an object`);
    }
    const rule = r as Record<string, unknown>;
    const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
    if (typeof rule.answer !== "string" && !isStringArray(rule.answer)) {
      throw new MinervaError(
        "VALIDATION_FAILED",
        `plan-defaults answers[${i}] from ${source} requires an "answer" (string or string[])`,
      );
    }
    if (rule.qid !== undefined && typeof rule.qid !== "string") {
      throw new MinervaError("VALIDATION_FAILED", `plan-defaults answers[${i}].qid from ${source} must be a string`);
    }
    if (rule.match !== undefined && typeof rule.match !== "string") {
      throw new MinervaError("VALIDATION_FAILED", `plan-defaults answers[${i}].match from ${source} must be a string`);
    }
    if (rule.qid === undefined && rule.match === undefined) {
      throw new MinervaError(
        "VALIDATION_FAILED",
        `plan-defaults answers[${i}] from ${source} needs at least one of "qid" or "match"`,
      );
    }
    return { qid: rule.qid, match: rule.match, answer: rule.answer } as AnswerRule;
  });
}

// Merge one partial config layer over a base. Unknown keys are ignored; each known key is
// validated. `answers` from the overlay are PREPENDED to the base's (so a higher-priority layer's
// rules are checked first / win first-match), rather than replacing them.
function mergeLayer(base: PlanDefaults, overlay: unknown, source: string): PlanDefaults {
  if (overlay === undefined || overlay === null) return base;
  if (typeof overlay !== "object" || Array.isArray(overlay)) {
    throw new MinervaError("VALIDATION_FAILED", `plan-defaults from ${source} must be an object`);
  }
  const o = overlay as Record<string, unknown>;
  const merged: PlanDefaults = { ...base };

  if (o.mode !== undefined) merged.mode = validateMode(o.mode, source);
  if (o.skip_sign_off !== undefined) {
    if (typeof o.skip_sign_off !== "boolean") {
      throw new MinervaError("VALIDATION_FAILED", `plan-defaults skip_sign_off from ${source} must be a boolean`);
    }
    merged.skip_sign_off = o.skip_sign_off;
  }
  if (o.tech_stack !== undefined) {
    if (o.tech_stack !== null && typeof o.tech_stack !== "string") {
      throw new MinervaError("VALIDATION_FAILED", `plan-defaults tech_stack from ${source} must be a string or null`);
    }
    merged.tech_stack = o.tech_stack;
  }
  if (o.select_strategy !== undefined) merged.select_strategy = validateSelectStrategy(o.select_strategy, source);
  if (o.free_text_default !== undefined) {
    if (o.free_text_default !== null && typeof o.free_text_default !== "string") {
      throw new MinervaError("VALIDATION_FAILED", `plan-defaults free_text_default from ${source} must be a string or null`);
    }
    merged.free_text_default = o.free_text_default;
  }
  if (o.answers !== undefined) merged.answers = [...validateAnswerRules(o.answers, source), ...base.answers];
  if (o.max_auto_answers !== undefined) {
    const n = Number(o.max_auto_answers);
    if (!Number.isInteger(n) || n <= 0) {
      throw new MinervaError(
        "VALIDATION_FAILED",
        `plan-defaults max_auto_answers from ${source} must be a positive integer`,
      );
    }
    merged.max_auto_answers = n;
  }
  if (o.drive_prompt_suffix !== undefined) {
    if (o.drive_prompt_suffix !== null && typeof o.drive_prompt_suffix !== "string") {
      throw new MinervaError(
        "VALIDATION_FAILED",
        `plan-defaults drive_prompt_suffix from ${source} must be a string or null`,
      );
    }
    merged.drive_prompt_suffix = o.drive_prompt_suffix;
  }
  return merged;
}

function readConfigFile(path: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `Could not read MINERVA_PLAN_DEFAULTS file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    // parseYaml handles JSON too (JSON is a subset of YAML), so one path covers both file forms.
    return parseYaml(raw);
  } catch (e) {
    throw new MinervaError(
      "VALIDATION_FAILED",
      `Could not parse MINERVA_PLAN_DEFAULTS file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function warningMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function warnInvalidConfigFile(path: string, e: unknown): void {
  console.warn(`[minerva] Ignoring plan-defaults config file ${path}: ${warningMessage(e)}`);
}

// Resolve the effective config from three layers, lowest-to-highest priority:
//   1. built-in defaults (mode: off)
//   2. MINERVA_PLAN_DEFAULTS  — path to a YAML/JSON config file (per-deployment)
//   3. MINERVA_PLAN_DEFAULTS_MODE — a bare mode override (per-deployment quick switch)
//   4. perRun — the `defaults` object passed to startRun (per-run, highest priority)
// Later layers override earlier ones field-by-field; `answers` accumulate (higher priority
// first). The optional file layer is best-effort: missing, unreadable, unparsable, or schema-
// invalid files warn and are ignored so Minerva can initialize safely with the built-in empty
// defaults. Direct env/per-run overrides still fail loudly because they are explicit inputs.
export function loadPlanDefaults(perRun?: unknown): PlanDefaults {
  let cfg = { ...BUILTIN_PLAN_DEFAULTS };

  const filePath = process.env.MINERVA_PLAN_DEFAULTS;
  if (filePath) {
    try {
      cfg = mergeLayer(cfg, readConfigFile(filePath), `MINERVA_PLAN_DEFAULTS (${filePath})`);
    } catch (e) {
      warnInvalidConfigFile(filePath, e);
    }
  }

  const modeEnv = process.env.MINERVA_PLAN_DEFAULTS_MODE;
  if (modeEnv) cfg = mergeLayer(cfg, { mode: modeEnv }, "MINERVA_PLAN_DEFAULTS_MODE");

  if (perRun !== undefined) cfg = mergeLayer(cfg, perRun, "startRun params.defaults");

  return cfg;
}

// --- Answer resolution ----------------------------------------------------------------------

// The minimal shape resolveDefaultAnswer needs from a pending question. Structurally satisfied by
// run-manager's Question (envelope-sourced questions carry kind/options/qid; prose questions
// don't, and fall through to the free-text path).
export interface ResolvableQuestion {
  text: string;
  channel: Channel;
  kind?: QuestionKind;
  options?: string[] | null;
  qid?: string;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

const SIGN_OFF_PATTERNS = [
  /sign[\s-]?off/i,
  /\bapprov/i,
  /ready to (proceed|plan|build|go)/i,
  /good to (go|proceed)/i,
  /\bproceed\?/i,
  /shall i proceed/i,
  /finali[sz]e/i,
  /look(s)? (good|right)/i,
];

const TECH_STACK_PATTERNS = [
  /tech(nology)? stack/i,
  /which stack/i,
  /what stack/i,
  /\blanguage\b/i,
  /\bframework\b/i,
  /\bruntime\b/i,
];

const AFFIRMATIVE_OPTION = /\b(approv|yes|proceed|accept|confirm|go\b|looks good|lgtm|recommend|default)/i;

function isSignOffQuestion(text: string): boolean {
  return matchesAny(text, SIGN_OFF_PATTERNS);
}

function isTechStackQuestion(text: string): boolean {
  return matchesAny(text, TECH_STACK_PATTERNS);
}

function pickApprovingOption(options: string[] | null | undefined): string | null {
  if (!options || options.length === 0) return null;
  const hit = options.find((o) => AFFIRMATIVE_OPTION.test(o));
  return hit ?? options[0] ?? null;
}

function pickOption(options: string[], strategy: SelectStrategy): string {
  // options is guaranteed non-empty by the caller.
  if (strategy === "first") return options[0]!;
  const recommended = options.find((o) => /\b(recommend|default|yes|proceed|standard)/i.test(o));
  return recommended ?? options[0]!;
}

// The core decision. Returns the answer to auto-supply for this question, or `null` to mean
// "no pre-baked default applies -- leave it parked for a human" (which, outside `auto` mode, is
// the correct, AD-5-preserving outcome for a genuine strategic gate). Pure and deterministic:
// same inputs -> same output, no I/O, no model call. This is the fixed point the auto-answer
// loop in kickoff-engine.ts is built on, and where the bulk of the behavior lives + is tested.
export function resolveDefaultAnswer(
  q: ResolvableQuestion,
  d: PlanDefaults,
  idea: string,
): string | string[] | null {
  if (d.mode === "off") return null;

  const text = q.text ?? "";
  const lower = text.toLowerCase();

  // 1. Explicit operator-pre-decided answers win over everything, regardless of channel or mode
  //    -- this is the "I already decided this" override the whole feature exists to serve.
  for (const rule of d.answers) {
    if (rule.qid !== undefined && q.qid !== undefined && rule.qid === q.qid) return rule.answer;
    if (rule.match !== undefined && lower.includes(rule.match.toLowerCase())) return rule.answer;
  }

  // 2. In "agent" mode, a human-channel question with no explicit answer is a genuine strategic
  //    gate -- park it (AD-5). "auto" mode intentionally continues past this to answer everything.
  if (d.mode === "agent" && q.channel === "human") return null;

  // 3. Sign-off / approval gate -> affirm.
  if (d.skip_sign_off && isSignOffQuestion(text)) {
    const opt = pickApprovingOption(q.options);
    return opt ?? "Approved — proceed.";
  }

  // 4. Tech-stack / language / framework question -> the pre-decided stack, when configured.
  if (d.tech_stack && isTechStackQuestion(text)) {
    return d.tech_stack;
  }

  // 5. Structured selects -> pick per strategy.
  if (q.kind === "single-select" && q.options && q.options.length > 0) {
    return pickOption(q.options, d.select_strategy);
  }
  if (q.kind === "multi-select" && q.options && q.options.length > 0) {
    // Answer a multi-select as a single-element selection (the safe minimal choice). Callers
    // join a string[] into prose for the driven turn, matching submitAnswers' own handling.
    return [pickOption(q.options, d.select_strategy)];
  }

  // 6. Free-text (and prose questions with no `kind`) -> the configured generic default.
  if (d.free_text_default) {
    return d.free_text_default.replace(/\{idea\}/g, idea);
  }

  // 7. Nothing applies -> park for a human.
  return null;
}

// Build the initial kickoff drive prompt's suffix (drive_prompt_suffix), or "" when unset. Kept
// here (not in kickoff-engine) so all prompt-shaping policy that plan-defaults owns lives in one
// place. Leading separator included so callers can concatenate directly.
export function drivePromptSuffix(d: PlanDefaults): string {
  return d.drive_prompt_suffix ? `\n\n${d.drive_prompt_suffix}` : "";
}
