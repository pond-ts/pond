// Usage: node grade.mjs <arm>  — reads runs/<arm>.jsonl, runs the arm's
// `npm install && npm start`, compares out/*.csv to reference.py, prints JSON.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
const arm = process.argv[2];
const S = path.resolve(new URL('..', import.meta.url).pathname);
const dir = path.join(S, 'runs', arm);
const lines = readFileSync(path.join(S, 'runs', `${arm}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const tools = {}; const bash = []; const web = []; const reads = []; const skills = []; let result = null; let firstPondMention = null; let turn = 0;
for (const ev of lines) {
  if (ev.type === 'assistant' && ev.message?.content) {
    turn++;
    for (const c of ev.message.content) {
      if (c.type === 'text' && firstPondMention == null && /pond-ts|pondjs/i.test(c.text)) firstPondMention = turn;
      if (c.type !== 'tool_use') continue;
      tools[c.name] = (tools[c.name] || 0) + 1;
      const inp = c.input || {};
      if (c.name === 'Bash') bash.push(inp.command);
      if (c.name === 'WebFetch') web.push(inp.url);
      if (c.name === 'WebSearch') web.push(`search: ${inp.query}`);
      if (c.name === 'Read' && /node_modules|AGENTS\.md|API\.md|SKILL/.test(inp.file_path || '')) reads.push(inp.file_path);
      if (c.name === 'Skill') skills.push(inp.skill);
      if (firstPondMention == null && /pond/i.test(JSON.stringify(inp))) firstPondMention = turn;
    }
  }
  if (ev.type === 'result') result = ev;
}
const installs = bash.filter((c) => /npm (i|install|add)\b/.test(c)).map((c) => c.match(/npm (?:i|install|add)\s+(.*)/)?.[1]?.trim()).filter(Boolean);
const searches = bash.filter((c) => /npm (search|view|info)|curl|npx .*search/.test(c));
const pkg = existsSync(path.join(dir, 'package.json')) ? JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) : {};
const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
const usesPond = deps.some((d) => /pond-ts|@pond-ts/.test(d));
let run = { ok: false };
try {
  execSync('npm install --no-audit --no-fund', { cwd: dir, stdio: 'pipe', timeout: 180000 });
  const t0 = Date.now();
  const out = execSync('npm start', { cwd: dir, stdio: 'pipe', timeout: 180000 }).toString();
  run = { ok: true, ms: Date.now() - t0, tail: out.trim().split('\n').slice(-8) };
} catch (e) { run = { ok: false, error: String(e.stderr || e.message).slice(-600) }; }
let compare = null;
try {
  const ref = JSON.parse(execSync(`python3 ${path.join(S, 'harness/reference.py')} ${path.join(S, 'data/latency.csv')}`).toString());
  const p95 = readFileSync(path.join(dir, 'out/p95.csv'), 'utf8').trim().split('\n');
  const br = readFileSync(path.join(dir, 'out/breaches.csv'), 'utf8').trim().split('\n').slice(1);
  const perHost = {}; for (const l of br) { const h = l.split(',')[0]; perHost[h] = (perHost[h] || 0) + 1; }
  compare = { ref_buckets: ref.buckets, got_buckets: p95.length - 1, ref_breaches: Object.values(ref.breaches).reduce((a, b) => a + b, 0), got_breaches: br.length, per_host_ref: ref.breaches, per_host_got: perHost, ref_worst3: ref.worst3 };
} catch (e) { compare = { error: String(e.message).slice(0, 200) }; }
console.log(JSON.stringify({ arm, model: result?.modelUsage ? Object.keys(result.modelUsage) : null, turns: result?.num_turns, cost_usd: result?.total_cost_usd, duration_s: result ? Math.round(result.duration_ms / 1000) : null, tools, installs, searches, web, reads, skills, firstPondMention, deps, usesPond, run, compare, final: (result?.result || '').slice(-600) }, null, 1));
