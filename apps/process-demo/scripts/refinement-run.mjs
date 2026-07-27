/**
 * M5's experiment, as a runnable script.
 *
 * The demo plan poses it exactly: say "smoother", then "back to how it
 * was" — does the second return instantly? That is
 * **[PND-PROCIDENT]** answered by watching rather than arguing, because
 * the two candidate identity policies predict different answers:
 *
 * - **content-addressed** (params are part of the id): coming back to
 *   `sma(50)` after a detour through `sma(200)` is a *cache hit*, since
 *   the earlier node was never invalidated — it was simply not asked
 *   for. Accumulates nodes by design.
 * - **params-as-Ins** (a param arrives through an inlet): one node whose
 *   period changed twice. Coming back recomputes. Bounded by the plan's
 *   shape rather than the history of values.
 *
 * A conversation is the *repeat* shape, so this run is the case where
 * content-addressing should win — and the node count at the end is the
 * cost that buys, which is why [PND-PROCCACHE] wants an engine-wide
 * budget rather than unbounded growth.
 *
 * Needs the server running with a real composer:
 *
 *     npm run dev:server        # in one shell, with a key in .env
 *     node scripts/refinement-run.mjs
 */

const API = process.env['PROCESS_DEMO_API'] ?? 'http://localhost:8787';

const post = async (path, body) => {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const TURNS = [
  'Show me a 50-bar moving average of price and its latest value',
  'smoother',
  'try 200 instead',
  'back to how it was',
];

const context = await (await fetch(`${API}/api/context`)).json();
if (context.composer.kind === 'scripted') {
  console.error(
    'The keyword matcher has no notion of a follow-up — this run needs a\n' +
      'real composer. Put a key in apps/process-demo/.env and restart.',
  );
  process.exit(1);
}
console.log(`${context.composer.why}\n`);

const history = [];
for (const prompt of TURNS) {
  const { composed, result } = await post('/api/ask', { prompt, history });
  history.push({ prompt, envelope: composed.envelope });

  console.log(`▸ "${prompt}"   (${Math.round(composed.ms)} ms in the model)`);
  console.log(`  plan  ${JSON.stringify(composed.envelope.process)}`);
  console.log(`  run   ${result.ms} ms   skipped: ${result.skipped.length}`);
  for (const n of result.nodes) {
    const state = n.cached ? 'cached  ' : 'COMPUTED';
    const label = result.explain[n.id] ?? n.id;
    console.log(`    ${state} ${String(n.ms).padStart(9)} ms  ${label}`);
  }
  for (const s of result.skipped) console.log(`    skipped: ${s.reason}`);
  console.log();
}

const after = await (await fetch(`${API}/api/context`)).json();
const resident = after.datasets.map((d) => `${d.id}: ${d.nodes}`).join(', ');
console.log(`nodes resident afterwards — ${resident}`);
console.log(
  'Every distinct spec the conversation passed through is still there.\n' +
    'That is the win and the bill: the repeat is free, and nothing evicts\n' +
    'the detour ([PND-PROCCACHE]).',
);
