#!/usr/bin/env node
// STANDALONE-BOUNDARY NOTE: this file is a separate, optional, Consus/Janus-dependent
// integration utility. It is NOT part of Minerva's core CLI/subprocess ABI (bin/minerva,
// bin/minerva-plan) and does NOT participate in, and is explicitly excluded from, Minerva's
// "genuinely standalone" claim (see docs/architecture.md, VISION.md). Minerva's core has no
// Consus coupling as of the rip-out in commit 8b450e0 ("core-rip-out-consus-coupling"); this
// tool intentionally still talks to Consus/Janus and is documented as an opt-in sibling
// utility, not a dependency of Minerva proper.
//
// ideate-to-consus — the MISSING HALF of the Pantheon ideation loop (VISION.md, Consus).
//
// An idea must NOT grind straight to code. This tool makes the loop real:
//
//   idea (ticket/brief)
//     → INGEST any attachments/artifacts the human referenced (docs, screenshots, in-repo files)
//     → a planning agent produces a design discussion + REAL wireframe (HTML) + PRD + mermaid diagram
//       + its OPEN QUESTIONS  (it ASKS, it does not silently guess or auto-decompose)
//     → commit those artifacts into the repo (handed down, not stranded in a link)
//     → FILE them into CONSUS as a decision item (rendered inline in the Janus Consus tab)
//     → WAIT for the human to answer/decide/send-back
//     → on --resume: the human's answers flow BACK, the agent iterates (re-files, version bumps)
//     → only on human SIGN-OFF does it hand to build (Minerva decompose → Auriga routes).
//
// This closes the plugin-hive "headless question gap": instead of stalling on a blocking
// AskUserQuestion (which needs a live foreground human), the questions are FILED to Consus where the
// human answers asynchronously and the answers return here.
//
// USAGE
//   ideate-to-consus --ticket PAN-6965 [--repo <dir>] [--janus <url>] [--model <id>] [--attach <path>]...
//   ideate-to-consus --idea "text" --title "..." [...]
//   ideate-to-consus --resume --item ideation:PAN-6965 [--janus <url>] [--decompose]
//
// HONEST by construction: it never fakes artifacts. If the planner produces nothing usable it says
// so and files nothing. --resume never advances to build without a real human sign-off.
//
// Zero-dep Node ESM (matches the Minerva "invoked, not served" model). Reversible: writes only under
// docs/ideation/<ticket>/ and files one Consus item; nothing destructive.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve, dirname, extname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

const HOME = homedir();
const CODE_ROOT = process.env.PANTHEON_CODE_ROOT || join(HOME, 'Documents', 'work', 'dostal', 'code');
const JANUS_DEFAULT = process.env.JANUS_URL || 'http://localhost:8726';

/* ------------------------------ arg parsing ------------------------------ */
function parseArgs(argv) {
  const a = { attach: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--ticket') a.ticket = next();
    else if (k === '--idea') a.idea = next();
    else if (k === '--title') a.title = next();
    else if (k === '--repo') a.repo = next();
    else if (k === '--janus') a.janus = next();
    else if (k === '--model') a.model = next();
    else if (k === '--attach') a.attach.push(next());
    else if (k === '--item') a.item = next();
    else if (k === '--resume') a.resume = true;
    else if (k === '--scan') a.scan = true;
    else if (k === '--refile-existing') a.refileExisting = true;
    else if (k === '--decompose') a.decompose = true;
    else if (k === '--no-commit') a.noCommit = true;
    else if (k === '--dry-run') a.dryRun = true;
  }
  a.janus = a.janus || JANUS_DEFAULT;
  a.model = a.model || process.env.IDEATE_MODEL || 'claude-sonnet-4-5';
  a.repo = a.repo || join(CODE_ROOT, 'minerva'); // artifacts committed to the planner repo by default
  return a;
}

const die = (msg) => { console.error(`ideate-to-consus: ${msg}`); process.exit(1); };
// Diagnostics go to STDERR so STDOUT carries ONLY the final JSON result (clean for the autopilot
// agent + any caller to parse).
const log = (...m) => console.error('[ideate]', ...m);

/* ------------------------------ multica ---------------------------------- */
function multicaBin() {
  for (const p of [process.env.MULTICA_BIN, join(HOME, '.local/bin/multica'), '/opt/homebrew/bin/multica', '/usr/local/bin/multica']) {
    if (p && existsSync(p)) return p;
  }
  return null;
}
function getTicket(id) {
  const bin = multicaBin();
  if (!bin) die('multica CLI not found');
  const env = { ...process.env, PATH: `/opt/homebrew/bin:${HOME}/.local/bin:${process.env.PATH || ''}` };
  delete env.MULTICA_TOKEN; delete env.MULTICA_PAT_TOKEN; delete env.MULTICA_WORKSPACE_ID;
  const out = execFileSync(bin, ['--profile', 'dostal', 'issue', 'get', String(id), '--output', 'json'], { encoding: 'utf8', env, timeout: 15000 });
  const parsed = JSON.parse(out);
  return parsed.issue || parsed;
}

/* -------------------------- attachment ingestion ------------------------- */
// Resolve a referenced path token to a real file: absolute, repo-root-relative, or bare in-code path.
function resolveRef(ref) {
  const candidates = [];
  if (isAbsolute(ref)) candidates.push(ref);
  else { candidates.push(resolve(CODE_ROOT, ref)); candidates.push(resolve(process.cwd(), ref)); }
  return candidates.find((p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } }) || null;
}
// Extract in-repo artifact path references from free text (idea/description). Matches paths ending in
// a known doc/image/code extension, e.g. `janus/docs/boards/command-board.html`, `.pHive/x/prd.md`.
function extractRefs(text) {
  const refs = new Set();
  const re = /[A-Za-z0-9._\/-]+\.(?:md|markdown|html|htm|txt|json|ya?ml|png|jpe?g|gif|webp|svg|mmd|mermaid|pdf|csv|ts|tsx|js|mjs|py)\b/g;
  const m = String(text || '').match(re) || [];
  for (const t of m) refs.add(t.replace(/[).,]+$/, ''));
  return [...refs];
}
const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.mmd', '.mermaid', '.csv', '.ts', '.tsx', '.js', '.mjs', '.py', '.html', '.htm']);
const MAX_INGEST = 60 * 1024;
// Build the ingested-context block. Text files are inlined (capped); images/binaries are listed by
// path so the planning agent (which has a Read tool + vision) pulls them itself.
function ingestAttachments(refs, explicit) {
  const seen = new Set();
  const items = [];
  for (const ref of [...explicit, ...refs]) {
    const path = resolveRef(ref);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const ext = extname(path).toLowerCase();
    if (TEXT_EXT.has(ext)) {
      let body = '';
      try { body = readFileSync(path, 'utf8'); } catch (e) { items.push({ path, error: String(e.message || e) }); continue; }
      const truncated = body.length > MAX_INGEST;
      items.push({ path, kind: 'text', body: truncated ? body.slice(0, MAX_INGEST) + '\n…(truncated)' : body, truncated });
    } else {
      items.push({ path, kind: 'binary', note: 'image/binary — the planning agent should Read it directly (vision).' });
    }
  }
  return items;
}
function renderIngestBlock(items) {
  if (!items.length) return '(none referenced)';
  return items.map((it) => {
    if (it.error) return `### ${it.path}\n(could not read: ${it.error})`;
    if (it.kind === 'binary') return `### ${it.path}\n${it.note}`;
    return `### ${it.path}\n\`\`\`\n${it.body}\n\`\`\``;
  }).join('\n\n');
}

/* ------------------------------ claude -p -------------------------------- */
function resolveToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  for (const f of [join(HOME, '.zshrc'), join(HOME, '.hermes/claude.env')]) {
    try {
      if (!existsSync(f)) continue;
      const m = readFileSync(f, 'utf8').match(/(?:export\s+)?CLAUDE_CODE_OAUTH_TOKEN\s*=\s*["']?([^"'\n\r]+)/);
      if (m && m[1]) return m[1].trim();
    } catch { /* keep trying */ }
  }
  return null;
}
function claudeBin() {
  for (const p of [process.env.CLAUDE_BIN, join(HOME, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (p && existsSync(p)) return p;
  }
  return null;
}
// Drive claude -p with tools (Write/Read/Bash) in `cwd`, letting it AUTHOR the artifact files. We
// rely on files-on-disk (robust for large HTML) rather than parsing a giant stdout blob.
function runPlanner({ prompt, cwd, model, timeoutMs = 600000 }) {
  const bin = claudeBin();
  if (!bin) return Promise.resolve({ ok: false, reason: 'claude CLI not found' });
  const token = resolveToken();
  if (!token) return Promise.resolve({ ok: false, reason: 'no CLAUDE_CODE_OAUTH_TOKEN' });
  return new Promise((res) => {
    const env = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, PATH: `/opt/homebrew/bin:${HOME}/.local/bin:${process.env.PATH || ''}` };
    const args = ['-p', prompt, '--model', model, '--permission-mode', 'bypassPermissions',
      '--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep', '--output-format', 'json'];
    let child;
    try { child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return res({ ok: false, reason: `spawn failed: ${e.message || e}` }); }
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} res({ ok: false, reason: `planner timeout after ${timeoutMs}ms`, partial: out }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); res({ ok: false, reason: `planner error: ${e.message || e}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let result = out.trim();
      try { const j = JSON.parse(out); if (j && typeof j.result === 'string') result = j.result; } catch { /* plain */ }
      res({ ok: code === 0, code, result, stderr: err.slice(-800) });
    });
  });
}

/* ------------------------------ janus seam ------------------------------- */
async function janusPost(base, capability, payload) {
  const res = await fetch(`${base}/api/seam/consus/${capability}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload, actor: 'minerva@ideation' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `janus ${capability} → HTTP ${res.status}`);
  // The seam write channel wraps the adapter result under `result` — unwrap so callers read id/version.
  return body.result && typeof body.result === 'object' ? body.result : body;
}
async function janusReadDecisions(base) {
  const res = await fetch(`${base}/api/seam/read/consus/decisions`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !Array.isArray(body.data)) throw new Error(body.error || `janus read decisions → HTTP ${res.status}`);
  return body.data;
}

/* ------------------------------ git commit ------------------------------- */
function gitCommitPush(repo, addPaths, message, push = true) {
  const run = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30000 });
  try {
    run(['add', ...addPaths]);
    // nothing staged → skip (idempotent re-run)
    const staged = run(['diff', '--cached', '--name-only']).trim();
    if (!staged) return { committed: false, note: 'no changes to commit' };
    run(['commit', '-m', message]);
    let pushed = false;
    if (push) { try { run(['push']); pushed = true; } catch (e) { return { committed: true, pushed: false, note: `push failed: ${String(e.message || e).slice(0, 200)}` }; } }
    return { committed: true, pushed, sha: run(['rev-parse', '--short', 'HEAD']).trim() };
  } catch (e) {
    return { committed: false, note: `git error: ${String(e.message || e).slice(0, 200)}` };
  }
}

/* ============================ FILE (default) ============================= */
const PLANNER_PROMPT = ({ ident, title, brief, ingest, workdir }) => `You are Minerva, the Pantheon PLANNING agent, working the ideation loop for idea "${ident}".

Your job is NOT to build and NOT to decompose into tickets. Your job is to produce a real DESIGN
DISCUSSION plus its OPEN QUESTIONS for a human to answer — because this idea is ambiguous and must
not silently grind to code. ASK real questions rather than guessing.

IDEA TITLE: ${title}

IDEA / BRIEF:
${brief}

REFERENCED ARTIFACTS THE HUMAN HANDED YOU (ingest these as context; Read any image/binary paths
directly with your Read tool — you have vision):
${ingest}

Working directory (write ALL outputs here): ${workdir}

Produce EXACTLY these files in the working directory, using your Write tool:

1. design-discussion.md — a crisp design discussion: the problem, your interpretation(s) of the
   ambiguous parts, options with tradeoffs, a recommended direction, and scope boundaries.

2. prd.md — a real PRD in markdown: Summary, Goals/Non-goals, Users, Requirements (numbered),
   Acceptance criteria, Risks. Where a flow helps, embed a mermaid diagram in a \`\`\`mermaid fence.

3. wireframe.html — a REAL, self-contained HTML+CSS wireframe of the primary UI/surface this idea
   implies (inline <style>, no external assets, no <script>). Make it genuinely represent the layout,
   not a placeholder. If the idea has no UI, make a diagram-style HTML overview instead.

4. flow.mmd — ONE mermaid diagram (graph/flowchart/sequence) of the core flow or architecture.
   Raw mermaid source only (no fences).

5. questions.json — a JSON object with this exact shape:
   {
     "summary": "<2-3 sentence synopsis of the design discussion>",
     "interpretations": [ {"id":"a","title":"<short label>","note":"<what choosing this means>"}, ... 2-4 items ],
     "recommended": "<id of your recommended interpretation>",
     "open_questions": [ {"id":"q1","question":"<the exact question>","why":"<why it matters / what's blocked>"}, ... ]
   }
   The open_questions are the WHOLE POINT — surface the genuinely ambiguous decisions the human must
   make (e.g. for a vague idea, what a fuzzy term concretely means, which hooks/surfaces are in scope).

After writing all five files, print a one-line confirmation. Do not ask me anything interactively —
file your questions into questions.json.`;

async function doFile(a) {
  let ident, title, brief, description = '';
  if (a.ticket) {
    const t = getTicket(a.ticket);
    ident = t.identifier || a.ticket;
    title = a.title || t.title || ident;
    description = t.description || '';
    brief = description || title;
  } else if (a.idea) {
    ident = a.title ? a.title.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 32) : `idea-${Date.now().toString(36)}`;
    title = a.title || a.idea.slice(0, 80);
    brief = a.idea;
  } else {
    die('need --ticket <id> or --idea "<text>"');
  }

  const slug = String(ident).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const workdir = join(a.repo, 'docs', 'ideation', slug);
  mkdirSync(workdir, { recursive: true });

  // 1. INGEST attachments (the human→agent half of the ingestion contract).
  const refs = extractRefs(`${title}\n${brief}`);
  const ingested = ingestAttachments(refs, a.attach);
  log(`ingested ${ingested.length} referenced artifact(s):`, ingested.map((i) => i.path).join(', ') || '(none)');
  writeFileSync(join(workdir, 'ingested-context.md'), `# Ingested context for ${ident}\n\nReferences pulled into the planner's context:\n\n${renderIngestBlock(ingested)}\n`);

  // 2. Plan → author artifacts (the agent ASKS via questions.json instead of guessing/decomposing).
  const prompt = PLANNER_PROMPT({ ident, title, brief, ingest: renderIngestBlock(ingested), workdir });
  if (a.dryRun) { log('dry-run: prompt built, skipping planner + file. workdir:', workdir); return; }
  log(`running planner (${a.model}) — authoring design-discussion / PRD / wireframe / diagram / questions…`);
  const plan = await runPlanner({ prompt, cwd: workdir, model: a.model });
  if (!plan.ok) log(`planner returned non-zero/none: ${plan.reason || plan.code}. Proceeding with whatever files exist (honest).`);

  // 3. Read what the planner produced (never fake it).
  const readIf = (f) => { const p = join(workdir, f); return existsSync(p) ? readFileSync(p, 'utf8') : null; };
  let questions = null;
  const qjson = readIf('questions.json');
  if (qjson) { try { questions = JSON.parse(qjson.replace(/^```json\s*|\s*```$/g, '')); } catch { questions = null; } }
  const prdPath = existsSync(join(workdir, 'prd.md')) ? join(workdir, 'prd.md') : null;
  const wfPath = existsSync(join(workdir, 'wireframe.html')) ? join(workdir, 'wireframe.html') : null;
  const ddPath = existsSync(join(workdir, 'design-discussion.md')) ? join(workdir, 'design-discussion.md') : null;
  const mmd = readIf('flow.mmd');

  const produced = [prdPath, wfPath, ddPath, questions ? 'questions' : null, mmd ? 'diagram' : null].filter(Boolean);
  if (!produced.length) die(`planner produced no usable artifacts (${plan.reason || 'unknown'}). Nothing filed — honest.`);
  log('planner produced:', produced.map((p) => (typeof p === 'string' && p.includes('/') ? p.split('/').pop() : p)).join(', '));

  // write an open-questions.md so the questions render as a doc too
  if (questions && Array.isArray(questions.open_questions)) {
    const qmd = `# Open questions — ${ident}\n\n${questions.summary ? questions.summary + '\n\n' : ''}` +
      questions.open_questions.map((q, i) => `## Q${i + 1}. ${q.question}\n\n${q.why ? '_Why it matters:_ ' + q.why + '\n' : ''}`).join('\n');
    writeFileSync(join(workdir, 'open-questions.md'), qmd);
  }

  // 4. Commit the artifacts into the repo (handed down, version-controlled — not a stranded link).
  let git = { committed: false, note: 'skipped (--no-commit)' };
  if (!a.noCommit) {
    git = gitCommitPush(a.repo, [join('docs', 'ideation', slug)], `docs(ideation): ${ident} — design discussion + PRD + wireframe + diagram + open questions\n\nFiled to Consus for human answers before any build (ideation loop).\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`);
    log('git:', JSON.stringify(git));
  }

  // 5. FILE into Consus. A multi-question idea is filed as a SURVEY (N discrete answerable questions),
  // not a single choose — so the human answers EACH question and the surface renders them cleanly.
  const attachments = [];
  if (wfPath) attachments.push({ id: 'wireframe', label: 'wireframe.html', kind: 'wireframe', path: wfPath });
  if (prdPath) attachments.push({ id: 'prd', label: 'PRD.md', kind: 'prd', path: prdPath });
  if (mmd) attachments.push({ id: 'diagram', label: 'flow.mermaid', kind: 'diagram', diagram: { kind: 'mermaid', code: mmd.trim() } });
  if (ddPath) attachments.push({ id: 'design', label: 'design-discussion.md', path: ddPath });
  if (existsSync(join(workdir, 'open-questions.md'))) attachments.push({ id: 'questions', label: 'open-questions.md', path: join(workdir, 'open-questions.md') });

  const filed = await fileIdeationItem({ janus: a.janus, id: `ideation:${slug}`, ident, title, questions, attachments, ticket: a.ticket, gitSha: git.sha, slug, workdir });
  log(`FILED to Consus: id=${filed.id} version=${filed.version} status=${filed.status} type=${filed.type}`);
  console.log(JSON.stringify({ ok: true, mode: 'file', item: filed.id, type: filed.type, ticket: a.ticket || null, workdir, git, questions: (questions && questions.open_questions || []).length, attachments: attachments.map((x) => x.label) }, null, 2));
}

// Build + file the ideation item. Shared by doFile and --refile-existing so the SAME shape is used.
// >=2 open questions → a SURVEY of discrete questions (interpretations become Q1's options + a first
// "direction" question); the summary is CLEAN PROSE (the design-discussion synopsis), never a crammed
// run-on of questions. Fewer than 2 → a choose with interpretations.
export async function fileIdeationItem({ janus, id, ident, title, questions, attachments, ticket, gitSha, slug, workdir }) {
  const q = questions || {};
  const openQ = Array.isArray(q.open_questions) ? q.open_questions : [];
  const interps = Array.isArray(q.interpretations) ? q.interpretations : [];
  const summary = (q.summary || 'A design discussion + real wireframe/PRD/diagram is attached; answer the questions below before this is decomposed to build.').trim();
  const links = [
    ticket ? { label: ticket, href: `http://100.75.161.82:3010/issues/${encodeURIComponent(ticket)}`, external: true, kind: 'origin' } : null,
    gitSha ? { label: `artifacts @ ${gitSha}`, href: '#', kind: 'ref' } : null,
  ].filter(Boolean);
  const decision_payload = { kind: 'ideation', ticket: ticket || null, slug, workdir, recommended: q.recommended, open_questions: openQ, interpretations: interps };

  let payload;
  if (openQ.length >= 2) {
    // survey: direction question (if interpretations exist) + one block per open question.
    const qs = [];
    if (interps.length) {
      // The "direction" question presents the interpretations as REFERENCE cards to MIX freely — NOT a
      // forced single pick. The answer is free-form (combine A+C, add your own).
      qs.push({ id: 'direction', prompt: 'Which overall direction should this take? (mix/combine freely — this is not a single choice)', why: q.recommended ? `Agent's recommendation: ${q.recommended}.` : '', refs: interps.map((o) => ({ id: o.id, title: o.title, note: o.note || '' })) });
    }
    for (let i = 0; i < openQ.length; i++) {
      const oq = openQ[i];
      qs.push({ id: oq.id || `q${i + 1}`, prompt: oq.question || oq.prompt || `Question ${i + 1}`, why: oq.why || '', refs: Array.isArray(oq.options) ? oq.options : undefined });
    }
    payload = {
      id, source: 'agent', type: 'survey',
      kicker: 'IDEATION · NEEDS YOUR ANSWERS',
      title: `${ident} — ${title}`.slice(0, 110),
      summary, attachments, links, questions: qs, recommended: q.recommended, decision_payload,
    };
  } else {
    payload = {
      id, source: 'agent', type: 'choose',
      kicker: 'IDEATION · NEEDS YOUR ANSWERS',
      title: `${ident} — ${title}`.slice(0, 110),
      summary, attachments, links, composeHybrid: true,
      options: interps.length ? interps.map((o) => ({ id: o.id, title: o.title, note: o.note || '' }))
        : [{ id: 'proceed', title: 'Proceed as recommended', note: 'accept the recommended direction' }, { id: 'discuss', title: 'Discuss first', note: 'ask in the thread' }],
      recommended: q.recommended, decision_payload,
    };
  }
  return janusPost(janus, 'decision.file', payload);
}

/* ============================== RESUME =================================== */
// Extract the human's answers from a filed item: the verdict (choice+rationale), any human messages
// in the discussion thread, and any send-back composed text.
function extractHumanInput(item) {
  const parts = [];
  const byId = {};
  for (const q of (item.questions || [])) byId[String(q.id)] = q.prompt || q.question || q.id;
  // PER-QUESTION conversation — pull back EVERY human entry per question (comment-style), plus any
  // agent probe replies, so the iteration has the full back-and-forth (not just one blob).
  if (item.threads && typeof item.threads === 'object') {
    for (const [qid, thread] of Object.entries(item.threads)) {
      const msgs = Array.isArray(thread) ? thread : [];
      const human = msgs.filter((m) => m.role === 'human' && String(m.text || '').trim());
      if (!human.length) continue;
      const label = byId[qid] || qid;
      for (const m of human) parts.push(`Q[${label}] → ${String(m.text).trim()}`);
      const agent = msgs.filter((m) => m.role === 'agent' && String(m.text || '').trim());
      for (const m of agent) parts.push(`  (agent on ${label}): ${String(m.text).trim()}`);
    }
  } else if (item.answers && typeof item.answers === 'object') {
    // fallback for older items without per-question threads
    for (const [qid, a] of Object.entries(item.answers)) {
      const val = a && typeof a === 'object' ? a.value : a;
      if (val == null || String(val).trim() === '') continue;
      parts.push(`Q[${byId[qid] || qid}] → ${String(val).trim()}`);
    }
  }
  if (item.decided && item.decided.actor && item.decided.actor !== 'minerva@ideation') {
    parts.push(`DECISION: chose "${item.decided.choice}"${item.decided.rationale ? ` — ${item.decided.rationale}` : ''}`);
  }
  for (const m of (item.discussion || [])) {
    if (m.role === 'human') parts.push(`HUMAN (${m.actor || 'you'}): ${m.text}`);
  }
  if (item.sentBack && item.sentBack.text) parts.push(`SENT BACK: ${item.sentBack.text}`);
  const signedOff = !!(item.decided && item.decided.choice && !['discuss', 'sendback', 'send-back'].includes(String(item.decided.choice).toLowerCase()) && item.status === 'decided');
  return { text: parts.join('\n'), hasInput: parts.length > 0, signedOff };
}

// A stable signature of the human's per-question answers — the IDEMPOTENCY key. Auto-resume fires
// once per distinct answer-set: when Mathew adds/edits/deletes an answer the signature changes and a
// new iterate fires; if nothing changed since the last resume, the scanner skips (no double-resume).
// Built ONLY from human messages (agent replies/iterations never change it), so the agent's own
// re-file doesn't re-trigger itself.
function answerSignature(item) {
  const parts = [];
  const threads = (item && item.threads && typeof item.threads === 'object') ? item.threads : {};
  for (const [qid, thread] of Object.entries(threads)) {
    for (const m of (Array.isArray(thread) ? thread : [])) {
      if (m && m.role === 'human' && String(m.text || '').trim()) parts.push(`${qid}${m.text}${m.editedAt || m.ts || ''}`);
    }
  }
  if (!parts.length && item && item.answers && typeof item.answers === 'object') {
    for (const [qid, a] of Object.entries(item.answers)) { const v = a && a.value; if (v && String(v).trim()) parts.push(`${qid}${v}`); }
  }
  if (!parts.length) return null;
  const s = parts.sort().join('');
  let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `${parts.length}:${(h >>> 0).toString(36)}`;
}
function countAnswered(item) {
  const threads = (item && item.threads) || {};
  return (item && Array.isArray(item.questions) ? item.questions : []).filter((q) => {
    const t = threads[String(q.id)];
    return Array.isArray(t) && t.some((m) => m.role === 'human' && String(m.text || '').trim());
  }).length;
}

// Reconstruct the ideation attachments from the workdir PATHS (the adapter re-reads them on render).
// We pass paths, not the enriched blobs from the read, so we never persist inlined HTML/markdown back.
function ideationAttachments(workdir) {
  const at = [];
  const mmd = existsSync(join(workdir, 'flow.mmd')) ? readFileSync(join(workdir, 'flow.mmd'), 'utf8').trim() : '';
  if (existsSync(join(workdir, 'wireframe.html'))) at.push({ id: 'wireframe', label: 'wireframe.html', kind: 'wireframe', path: join(workdir, 'wireframe.html') });
  if (existsSync(join(workdir, 'prd.md'))) at.push({ id: 'prd', label: 'PRD.md', kind: 'prd', path: join(workdir, 'prd.md') });
  if (mmd) at.push({ id: 'diagram', label: 'flow.mermaid', kind: 'diagram', diagram: { kind: 'mermaid', code: mmd } });
  if (existsSync(join(workdir, 'design-discussion.md'))) at.push({ id: 'design', label: 'design-discussion.md', path: join(workdir, 'design-discussion.md') });
  if (existsSync(join(workdir, 'what-changed.md'))) at.push({ id: 'whatchanged', label: 'what-i-did.md', path: join(workdir, 'what-changed.md') });
  if (existsSync(join(workdir, 'open-questions.md'))) at.push({ id: 'questions', label: 'open-questions.md', path: join(workdir, 'open-questions.md') });
  return at;
}

// Resume ONE ideation survey on the human's answers — the conversational iterate. CONSERVATIVE by
// design so his input is untouchable: it KEEPS the same questions (his answers stay attached via the
// store's merge), regenerates the wireframe/PRD to fold in his answers, adds an agent "here's what I
// did with your answers" note, and stamps the idempotency signature. HONEST: if the planner is
// unreachable it records that (never fakes an iterate) and still stamps the sig so it doesn't loop —
// Mathew edits/adds an answer (new sig) to trigger another attempt. NEVER decomposes here (that is a
// separate, gated step). Returns a result summary.
export async function resumeOne(a, item, { sig } = {}) {
  const dp = (item && item.decision_payload) || {};
  const slug = dp.slug || String(item.id).replace(/^ideation:/, '');
  const workdir = dp.workdir || join(a.repo, 'docs', 'ideation', slug);
  const answerSig = sig || answerSignature(item);
  const human = extractHumanInput(item);
  if (!human.hasInput) return { item: item.id, resumed: false, reason: 'no human answers yet (waiting)' };
  mkdirSync(workdir, { recursive: true });

  // CLAIM the answer-set up front (set the idempotency marker BEFORE the heavy planner) so a second
  // autopilot run that overlaps this one sees the marker and SKIPS — no concurrent double-resume. The
  // merge preserves his answers. If the planner later fails, the marker stays (no retry loop); he
  // edits/adds an answer (new sig) to trigger another pass. Best-effort — a claim failure doesn't
  // block the iterate.
  try {
    await janusPost(a.janus, 'decision.file', {
      id: item.id, source: 'agent', type: 'survey', title: item.title,
      kicker: 'IDEATION · ITERATING…', summary: `Auto-resume in progress — folding your answers into the design (${countAnswered(item)}/${(item.questions || []).length} answered).`,
      questions: item.questions, attachments: ideationAttachments(workdir), recommended: dp.recommended,
      decision_payload: { ...dp, autoResumedSig: answerSig, claimedAt: new Date().toISOString() },
    });
  } catch (e) { log('claim write failed (continuing):', String(e.message || e).slice(0, 120)); }

  // 1. Planner: fold his answers into the artifacts; write what-changed.md. DO NOT touch questions.json
  //    (his answers are keyed to those question ids).
  const prevPrd = existsSync(join(workdir, 'prd.md')) ? readFileSync(join(workdir, 'prd.md'), 'utf8') : '(none)';
  const prompt = `You are Minerva iterating the Consus ideation loop for "${item.title}". Mathew ANSWERED the survey — fold his answers into the DESIGN. UPDATE these files in ${workdir}: prd.md, wireframe.html, flow.mmd (reflect his decisions). Then WRITE what-changed.md — a short "Here's what I did with your answers" (3-8 bullets) plus any questions that are still genuinely open. Do NOT modify questions.json (his answers are attached to those question ids). Do NOT decompose into tickets.

HIS ANSWERS (per question):
${human.text}

PREVIOUS PRD (reference):
${prevPrd.slice(0, 16000)}

Write the updated files now, then print one line.`;
  let plannerOk = false; let whatChanged = '';
  if (!a.dryRun) {
    const plan = await runPlanner({ prompt, cwd: workdir, model: a.model });
    plannerOk = !!plan.ok;
    if (!plannerOk) log(`resumeOne(${item.id}): planner unreachable — ${plan.reason || plan.code} (recording honestly)`);
    whatChanged = existsSync(join(workdir, 'what-changed.md')) ? readFileSync(join(workdir, 'what-changed.md'), 'utf8') : '';
  }

  const answered = countAnswered(item);
  const total = Array.isArray(item.questions) ? item.questions.length : 0;
  const allAnswered = total > 0 && answered >= total;

  // 2. Re-file as a SURVEY, KEEPING the same questions (the store MERGE preserves his answers/threads);
  //    refresh attachments + summary + the idempotency marker.
  const summary = `Auto-resumed on your answers (${answered}/${total} answered). ` +
    (plannerOk ? 'I folded your input into the wireframe + PRD (see "what I did" below and the updated attachments).'
               : '(The planner was unreachable this pass — nothing was faked; your answers are safe. Edit or add an answer to trigger another pass.)') + ' ' +
    (allAnswered ? 'All questions answered — review the updated artifacts, then reply/edit to refine or say the word to build.'
                 : 'Keep answering the remaining questions — I iterate each time you do.');
  const refiled = await janusPost(a.janus, 'decision.file', {
    id: item.id, source: 'agent', type: 'survey',
    kicker: allAnswered ? 'IDEATION · READY FOR SIGN-OFF' : 'IDEATION · UPDATED · KEEP ANSWERING',
    title: item.title, summary,
    questions: item.questions,               // SAME questions → his answers stay attached (merge)
    attachments: ideationAttachments(workdir),
    recommended: dp.recommended,
    decision_payload: { ...dp, autoResumedSig: answerSig, iterated_at: new Date().toISOString(), plannerOk },
  });

  // 3. Agent note — "here's what I did with your answers" (honest if the planner failed).
  const note = plannerOk
    ? `Auto-resume: I folded your answers into the design and updated the wireframe + PRD.${whatChanged ? '\n\nWhat I did:\n' + whatChanged.slice(0, 1400) : ''}\n\nEdit any answer or add more, and I'll iterate again.`
    : `Auto-resume tried to iterate on your answers but the planner was unreachable this pass — recorded honestly (no faked changes). Your answers are safe. Add or edit an answer and I'll try again.`;
  try { await janusPost(a.janus, 'discuss', { itemId: item.id, actor: 'minerva@auto-resume', text: note }); } catch (e) { log('discuss note failed:', String(e.message || e).slice(0, 120)); }

  if (!a.noCommit && plannerOk) gitCommitPush(a.repo, [join('docs', 'ideation', slug)], `docs(ideation): ${slug} — auto-resume iterate on answers\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`);
  return { item: item.id, resumed: true, plannerOk, version: refiled.version, answered, total, allAnswered };
}

// Single-item resume (hand invocation / testing): --resume --item <id>.
async function doResume(a) {
  if (!a.item) die('--resume needs --item <id> (e.g. ideation:pan-6965)');
  const decisions = await janusReadDecisions(a.janus);
  const item = decisions.find((d) => d.id === a.item);
  if (!item) die(`item "${a.item}" not found in Consus (filed yet?)`);
  const human = extractHumanInput(item);
  if (!human.hasInput) { log('no human answers yet — the loop is correctly WAITING (not grinding to build).'); console.log(JSON.stringify({ ok: true, mode: 'resume', waiting: true, item: a.item }, null, 2)); return; }
  log('human input detected:\n' + human.text);
  const r = await resumeOne(a, item, {});
  console.log(JSON.stringify({ ok: true, mode: 'resume', ...r }, null, 2));
}

// SCAN — the AUTOPILOT's action. Polls Consus for ideation surveys with NEW human answers (signature
// changed since the last resume) and iterates each. Idempotent (the signature marker), resilient
// (per-item try/catch; honest awaiting-reply on planner failure), and SCOPED: only `ideation` surveys
// are touched — Mathew's fired `[idea]` intake tickets are NOT here and are never auto-decomposed.
async function doScan(a) {
  const decisions = await janusReadDecisions(a.janus);
  const candidates = decisions.filter((it) => it && it.type === 'survey' && it.decision_payload && it.decision_payload.kind === 'ideation');
  log(`scan: ${candidates.length} ideation survey(s) on the surface`);
  const results = [];
  for (const item of candidates) {
    const sig = answerSignature(item);
    if (!sig) { results.push({ item: item.id, action: 'wait', reason: 'no human answers yet' }); continue; }
    const marker = item.decision_payload && item.decision_payload.autoResumedSig;
    if (marker === sig) { results.push({ item: item.id, action: 'skip', reason: 'already resumed for these answers (idempotent)' }); continue; }
    // --dry-run is strictly READ-ONLY: report what WOULD resume, mutate NOTHING (never touches items).
    if (a.dryRun) { results.push({ item: item.id, action: 'would-resume', answered: countAnswered(item), total: (item.questions || []).length }); continue; }
    log(`scan: AUTO-RESUME ${item.id} — answers changed (sig ${sig} != marker ${marker || '∅'})`);
    try { const r = await resumeOne(a, item, { sig }); results.push({ item: item.id, action: 'resumed', ...r }); }
    catch (e) { results.push({ item: item.id, action: 'error', error: String((e && e.message) || e).slice(0, 200) }); }
  }
  const resumed = results.filter((r) => r.action === 'resumed').length;
  log(`scan done: ${resumed} resumed, ${results.length - resumed} skipped/waiting`);
  console.log(JSON.stringify({ ok: true, mode: 'scan', scanned: candidates.length, resumed, results }, null, 2));
}

/* ========================= REFILE-EXISTING ============================== */
// Re-file an ideation item from ALREADY-COMMITTED workdir artifacts, WITHOUT running the planner.
// Deletes any prior store item for the id first (clean slate — no stale thread/version), then files
// fresh (v1, open). Used to convert an item to the survey shape or to reset it honestly.
async function doRefileExisting(a) {
  if (!a.ticket) die('--refile-existing needs --ticket <id>');
  const slug = String(a.ticket).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const workdir = join(a.repo, 'docs', 'ideation', slug);
  if (!existsSync(join(workdir, 'questions.json'))) die(`no committed questions.json at ${workdir}`);
  const q = JSON.parse(readFileSync(join(workdir, 'questions.json'), 'utf8').replace(/^```json\s*|\s*```$/g, ''));
  const mmd = existsSync(join(workdir, 'flow.mmd')) ? readFileSync(join(workdir, 'flow.mmd'), 'utf8').trim() : '';
  const attachments = [];
  if (existsSync(join(workdir, 'wireframe.html'))) attachments.push({ id: 'wireframe', label: 'wireframe.html', kind: 'wireframe', path: join(workdir, 'wireframe.html') });
  if (existsSync(join(workdir, 'prd.md'))) attachments.push({ id: 'prd', label: 'PRD.md', kind: 'prd', path: join(workdir, 'prd.md') });
  if (mmd) attachments.push({ id: 'diagram', label: 'flow.mermaid', kind: 'diagram', diagram: { kind: 'mermaid', code: mmd } });
  if (existsSync(join(workdir, 'design-discussion.md'))) attachments.push({ id: 'design', label: 'design-discussion.md', path: join(workdir, 'design-discussion.md') });
  if (existsSync(join(workdir, 'open-questions.md'))) attachments.push({ id: 'questions', label: 'open-questions.md', path: join(workdir, 'open-questions.md') });

  const id = `ideation:${slug}`;
  // ⛔ NEVER delete/overwrite. A re-file MERGES through the store — existing HUMAN answers, per-question
  // threads, discussion, and audit are preserved; only agent-authored presentation (questions/summary/
  // attachments) is refreshed. (A prior version deleted-then-refiled and WIPED a human answer; removed.)
  const ident = a.ticket;
  const filed = await fileIdeationItem({ janus: a.janus, id, ident, title: a.title || ident, questions: q, attachments, ticket: a.ticket, slug, workdir });
  log(`RE-FILED (merge): id=${filed.id} version=${filed.version} status=${filed.status} type=${filed.type} — human content preserved`);
  console.log(JSON.stringify({ ok: true, mode: 'refile-existing', merged: true, item: filed.id, type: filed.type, questions: (q.open_questions || []).length, attachments: attachments.map((x) => x.label) }, null, 2));
}

/* -------------------------------- main ----------------------------------- */
(async () => {
  const a = parseArgs(process.argv.slice(2));
  try {
    if (a.scan) await doScan(a);
    else if (a.refileExisting) await doRefileExisting(a);
    else if (a.resume) await doResume(a);
    else await doFile(a);
  } catch (e) {
    die(String(e && e.stack || e.message || e));
  }
})();
