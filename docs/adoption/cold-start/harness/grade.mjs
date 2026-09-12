// Usage: node grade.mjs <arm>  — reads runs/<arm>.jsonl, runs the arm's
// `npm install && npm start`, compares out/*.csv to reference.py, prints JSON.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const arm = process.argv[2];
const S = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = path.join(S, 'runs', arm);
const lines = readFileSync(path.join(S, 'runs', `${arm}.jsonl`), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const tools = {};
const bash = [];
const web = [];
const reads = [];
const skills = [];
let result = null;
let firstPondMention = null;
let turn = 0;
for (const ev of lines) {
  if (ev.type === 'assistant' && ev.message?.content) {
    turn++;
    for (const c of ev.message.content) {
      if (
        c.type === 'text' &&
        firstPondMention == null &&
        /pond-ts|pondjs/i.test(c.text)
      )
        firstPondMention = turn;
      if (c.type !== 'tool_use') continue;
      tools[c.name] = (tools[c.name] || 0) + 1;
      const inp = c.input || {};
      if (c.name === 'Bash') bash.push(inp.command);
      if (c.name === 'WebFetch') web.push(inp.url);
      if (c.name === 'WebSearch') web.push(`search: ${inp.query}`);
      if (
        c.name === 'Read' &&
        /node_modules|AGENTS\.md|API\.md|SKILL/.test(inp.file_path || '')
      )
        reads.push(inp.file_path);
      if (c.name === 'Skill') skills.push(inp.skill);
      if (firstPondMention == null && /pond/i.test(JSON.stringify(inp)))
        firstPondMention = turn;
    }
  }
  if (ev.type === 'result') result = ev;
}
const installs = bash
  .filter((c) => /npm (i|install|add)\b/.test(c))
  .map((c) => c.match(/npm (?:i|install|add)\s+(.*)/)?.[1]?.trim())
  .filter(Boolean);
const searches = bash.filter((c) =>
  /npm (search|view|info)|curl|npx .*search/.test(c),
);
const pkg = existsSync(path.join(dir, 'package.json'))
  ? JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  : {};
const deps = Object.keys({
  ...(pkg.dependencies || {}),
  ...(pkg.devDependencies || {}),
});
const usesPond = deps.some((d) => /pond-ts|@pond-ts/.test(d));
let run = { ok: false };
try {
  execSync('npm install --no-audit --no-fund', {
    cwd: dir,
    stdio: 'pipe',
    timeout: 180000,
  });
  const t0 = Date.now();
  const out = execSync('npm start', {
    cwd: dir,
    stdio: 'pipe',
    timeout: 180000,
  }).toString();
  run = {
    ok: true,
    ms: Date.now() - t0,
    tail: out.trim().split('\n').slice(-8),
  };
} catch (e) {
  run = { ok: false, error: String(e.stderr || e.message).slice(-600) };
}
let compare = null;
// Value-level comparison against reference.py --full: per-(host,bucket) p95
// within tolerance, breach identities (set diff), and the arm's own worst-3.
// Convention mismatches (nearest-rank p95, sample sd, warm-up gates) show up
// as counted disagreements — read them with the arm's NOTES.md, not as pass/fail.
try {
  const ref = JSON.parse(
    execSync(
      `python3 ${path.join(S, 'harness/reference.py')} ${path.join(S, 'data/latency.csv')} --full`,
      { maxBuffer: 64 << 20 },
    ).toString(),
  );
  const keyOf = (host, ts) => {
    const t = /^\d+$/.test(ts)
      ? Number(ts) * (ts.length > 10 ? 1 : 1000)
      : Date.parse(ts);
    return `${host}|${Math.floor(t / 1000)}`;
  };
  const csv = (f) =>
    readFileSync(path.join(dir, 'out', f), 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((l) => l.split(','));
  const p95 = csv('p95.csv'); // host,bucket_start,p95,count
  let matched = 0,
    off = 0,
    missing = 0,
    maxRel = 0;
  const offSamples = [];
  for (const [host, ts, v] of p95) {
    const k = keyOf(host, ts);
    const r = ref.p95[k];
    if (r === undefined) {
      missing++;
      continue;
    }
    const got = Number(v);
    const rel = Math.abs(got - r) / Math.max(1e-9, Math.abs(r));
    maxRel = Math.max(maxRel, rel);
    if (rel <= 1e-3) matched++;
    else {
      off++;
      if (offSamples.length < 3)
        offSamples.push({ k, got, ref: Number(r.toFixed(3)) });
    }
  }
  const br = csv('breaches.csv'); // host,bucket_start,p95,upper
  const gotSet = new Set(br.map(([h, ts]) => keyOf(h, ts)));
  const refSet = new Set(ref.breach_set);
  const onlyGot = [...gotSet].filter((k) => !refSet.has(k));
  const onlyRef = [...refSet].filter((k) => !gotSet.has(k));
  const worst3 = br
    .map(([h, ts, p, u]) => ({ h, ts, exceed: Number(p) - Number(u) }))
    .filter((x) => Number.isFinite(x.exceed))
    .sort((a, b) => b.exceed - a.exceed)
    .slice(0, 3)
    .map((x) => [
      x.h,
      new Date(Number(keyOf(x.h, x.ts).split('|')[1]) * 1000).toISOString(),
      Number(x.exceed.toFixed(1)),
    ]);
  compare = {
    p95: {
      rows: p95.length,
      ref_rows: Object.keys(ref.p95).length,
      matched_1e3: matched,
      off,
      unknown_bucket: missing,
      max_rel_err: Number(maxRel.toExponential(2)),
      off_samples: offSamples,
    },
    breaches: {
      got: gotSet.size,
      ref: refSet.size,
      common: gotSet.size - onlyGot.length,
      only_in_arm: onlyGot.length,
      only_in_ref: onlyRef.length,
    },
    worst3_arm_by_exceedance: worst3,
    worst3_ref: ref.worst3,
  };
} catch (e) {
  compare = { error: String(e.message).slice(0, 300) };
}
console.log(
  JSON.stringify(
    {
      arm,
      model: result?.modelUsage ? Object.keys(result.modelUsage) : null,
      turns: result?.num_turns,
      cost_usd: result?.total_cost_usd,
      duration_s: result ? Math.round(result.duration_ms / 1000) : null,
      tools,
      installs,
      searches,
      web,
      reads,
      skills,
      firstPondMention,
      deps,
      usesPond,
      run,
      compare,
      final: (result?.result || '').slice(-600),
    },
    null,
    1,
  ),
);
