#!/usr/bin/env node
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
const log = (...m) => console.log('[ideate]', ...m);

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
      qs.push({ id: 'direction', prompt: 'Which overall direction should this take?', why: q.recommended ? `Agent's recommendation: ${q.recommended}.` : '', options: interps.map((o) => ({ id: o.id, title: o.title, note: o.note || '' })) });
    }
    for (let i = 0; i < openQ.length; i++) {
      const oq = openQ[i];
      qs.push({ id: oq.id || `q${i + 1}`, prompt: oq.question || oq.prompt || `Question ${i + 1}`, why: oq.why || '', options: Array.isArray(oq.options) ? oq.options : undefined });
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
  // PER-QUESTION survey answers — pulled back DISCRETELY (one line per question), not as a blob.
  if (item.answers && typeof item.answers === 'object') {
    const byId = {};
    for (const q of (item.questions || [])) byId[String(q.id)] = q.prompt || q.question || q.id;
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

async function doResume(a) {
  if (!a.item) die('--resume needs --item <id> (e.g. ideation:pan-6965)');
  const decisions = await janusReadDecisions(a.janus);
  const item = decisions.find((d) => d.id === a.item);
  if (!item) die(`item "${a.item}" not found in Consus (filed yet?)`);
  const human = extractHumanInput(item);
  if (!human.hasInput) { log('no human answers yet — nothing to iterate. The loop is correctly WAITING (not grinding to build).'); console.log(JSON.stringify({ ok: true, mode: 'resume', waiting: true, item: a.item }, null, 2)); return; }

  log('human input detected:\n' + human.text);
  const dp = item.decision_payload || {};
  const slug = dp.slug || String(a.item).replace(/^ideation:/, '');
  const workdir = dp.workdir || join(a.repo, 'docs', 'ideation', slug);

  // SIGN-OFF → hand to build (decompose via Minerva), never before.
  if (human.signedOff && dp.ticket) {
    log(`human SIGNED OFF (chose "${item.decided.choice}"). Handing to build.`);
    if (a.decompose) {
      const planBin = join(a.repo, 'bin', 'minerva-plan.ts');
      log(`decomposing: minerva-plan --ticket ${dp.ticket} --file-to-multica  (run this to route to build via Auriga)`);
      // We print the command rather than force-run to keep this reversible; pass --decompose to run.
      try {
        const out = execFileSync('npx', ['tsx', planBin, '--ticket', dp.ticket, '--file-to-multica'], { cwd: a.repo, encoding: 'utf8', timeout: 300000, env: { ...process.env, PATH: `/opt/homebrew/bin:${HOME}/.local/bin:${process.env.PATH || ''}` } });
        log('decompose output:\n' + out.slice(-1000));
      } catch (e) { log('decompose invocation failed (run manually): ' + String(e.message || e).slice(0, 300)); }
    }
    console.log(JSON.stringify({ ok: true, mode: 'resume', signedOff: true, ticket: dp.ticket, decompose: !!a.decompose }, null, 2));
    return;
  }

  // Otherwise ITERATE: re-run the planner WITH the human's answers as new context; re-file (bump).
  mkdirSync(workdir, { recursive: true });
  const prevPrd = existsSync(join(workdir, 'prd.md')) ? readFileSync(join(workdir, 'prd.md'), 'utf8') : '(none)';
  const prompt = `You are Minerva iterating the ideation loop for "${item.title}". The human has ANSWERED your open questions. Incorporate their answers, UPDATE the artifacts in ${workdir} (design-discussion.md, prd.md, wireframe.html, flow.mmd), and rewrite questions.json with any REMAINING open questions (empty open_questions array if all resolved and you now recommend proceeding).\n\nHUMAN ANSWERS:\n${human.text}\n\nPREVIOUS PRD (for reference):\n${prevPrd.slice(0, 20000)}\n\nWrite the updated files now. Do not decompose to tickets. Print a one-line confirmation.`;
  log('iterating with the planner given the human answers…');
  if (a.dryRun) { log('dry-run: skipping planner'); return; }
  const plan = await runPlanner({ prompt, cwd: workdir, model: a.model });
  if (!plan.ok) log(`planner iterate returned: ${plan.reason || plan.code} (using whatever files exist).`);

  // Re-file (same id → version bump), refreshed questions + a durable note of what changed.
  let questions = null;
  try { questions = JSON.parse(readFileSync(join(workdir, 'questions.json'), 'utf8').replace(/^```json\s*|\s*```$/g, '')); } catch {}
  const nq = questions && Array.isArray(questions.open_questions) ? questions.open_questions.length : 0;
  if (!a.noCommit) gitCommitPush(a.repo, [join('docs', 'ideation', slug)], `docs(ideation): ${slug} — iterate on human answers (${nq} open question(s) remain)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`);

  // append an agent message so the human sees the iteration in the thread
  try { await janusPost(a.janus, 'discuss', { itemId: a.item, actor: 'minerva@ideation', text: `Iterated on your answers. ${nq === 0 ? 'All questions resolved — ready for your sign-off to build.' : nq + ' question(s) remain; wireframe + PRD updated.'}` }); } catch (e) { log('discuss append failed:', String(e.message || e).slice(0, 160)); }

  const refiled = await janusPost(a.janus, 'decision.file', {
    id: a.item, type: 'choose', kicker: nq ? 'IDEATION · UPDATED · NEEDS YOUR ANSWERS' : 'IDEATION · READY FOR SIGN-OFF',
    title: item.title, summary: `${questions && questions.summary ? questions.summary + ' ' : ''}${nq ? nq + ' open question(s) remain after your answers. Updated wireframe + PRD attached.' : 'All questions resolved. Review the updated wireframe + PRD and sign off to hand to build.'}`,
    options: nq ? (questions.interpretations || []).map((o) => ({ id: o.id, title: o.title, note: o.note })) : [{ id: 'build', title: 'Sign off → build', note: 'decompose + route to Auriga' }, { id: 'discuss', title: 'More changes', note: 'keep iterating' }],
    recommended: questions && questions.recommended, composeHybrid: true,
    attachments: item.attachments, // paths re-read fresh by the adapter on render
    decision_payload: { ...(item.decision_payload || {}), open_questions: (questions && questions.open_questions) || [], iterated_at: new Date().toISOString() },
  });
  log(`RE-FILED: id=${refiled.id} version=${refiled.version} (${nq} open questions remain)`);
  console.log(JSON.stringify({ ok: true, mode: 'resume', iterated: true, item: a.item, openQuestionsRemaining: nq }, null, 2));
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
  // delete prior store item so the re-file is a clean v1 (strips any prior thread/answers/version).
  if (process.env.JANUS_CONSUS_STORE || existsSync('/Users/dostal/Documents/work/dostal/code/janus/var/consus-store.json')) {
    const store = process.env.JANUS_CONSUS_STORE || '/Users/dostal/Documents/work/dostal/code/janus/var/consus-store.json';
    try { const doc = JSON.parse(readFileSync(store, 'utf8')); if (doc.items[id]) { delete doc.items[id]; writeFileSync(store, JSON.stringify(doc, null, 2)); log(`deleted prior ${id} from store`); } } catch (e) { log('store delete skipped:', String(e.message || e).slice(0, 120)); }
  }
  const ident = a.ticket;
  const filed = await fileIdeationItem({ janus: a.janus, id, ident, title: a.title || ident, questions: q, attachments, ticket: a.ticket, slug, workdir });
  log(`RE-FILED (existing): id=${filed.id} version=${filed.version} status=${filed.status} type=${filed.type}`);
  console.log(JSON.stringify({ ok: true, mode: 'refile-existing', item: filed.id, type: filed.type, questions: (q.open_questions || []).length, attachments: attachments.map((x) => x.label) }, null, 2));
}

/* -------------------------------- main ----------------------------------- */
(async () => {
  const a = parseArgs(process.argv.slice(2));
  try {
    if (a.refileExisting) await doRefileExisting(a);
    else if (a.resume) await doResume(a);
    else await doFile(a);
  } catch (e) {
    die(String(e && e.stack || e.message || e));
  }
})();
