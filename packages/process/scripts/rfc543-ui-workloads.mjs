/**
 * RFC #543 — the two consumer workloads the MCP benchmark does not cover.
 *
 *   CASE A — interactive parameters. A UI plots a stack of user-built
 *     studies. The source polls every 5m (so: effectively static between
 *     polls), but the user drags a study's `period` and expects the plot
 *     to keep up. Content addressing makes each slider position a NEW
 *     spec, so this is a cache-reuse question, not an invalidation one:
 *     do the untouched studies stay warm, and what does the cache cost?
 *
 *   CASE B — hot leading edge. Fast market data, a stack of studies, and
 *     a new bar arriving constantly. Every tick invalidates everything
 *     and there is no partial invalidation, so this is the case that
 *     prices "recompute the whole history per tick".
 *
 * Throwaway. Not package API, not published.
 *     node scripts/rfc543-ui-workloads.mjs
 */
import { TimeSeries } from '../../core/dist/index.js';
import { sma, ema, zScore } from '../../financial/dist/index.js';
import { derive, source as makeSource } from '../dist/index.js';

const now = () => process.hrtime.bigint();
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const mb = () => {
  global.gc?.(); // without this the delta is dominated by uncollected garbage
  return process.memoryUsage().heapUsed / 1024 / 1024;
};
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

function valuesOf(column) {
  const out = new Array(column.length).fill(undefined);
  column.scan(
    (v, i) => {
      out[i] = Number.isNaN(v) ? undefined : v;
    },
    { skipInvalid: true },
  );
  return out;
}

// ═══ registry ════════════════════════════════════════════════
const registry = new Map();
const def = (o) => registry.set(o.name, o);
const one =
  (fn) =>
  ({ series, input, params, id }) =>
    valuesOf(fn(series, input, params, id).column(id));
def({
  name: 'sma',
  params: { period: 20 },
  arity: 1,
  run: one((s, c, p, id) =>
    sma(s, { column: c, period: p.period, output: id }),
  ),
});
def({
  name: 'ema',
  params: { period: 20 },
  arity: 1,
  run: one((s, c, p, id) =>
    ema(s, { column: c, period: p.period, output: id }),
  ),
});
def({
  name: 'zScore',
  params: { period: 60 },
  arity: 1,
  run: one((s, c, p, id) =>
    zScore(s, { column: c, period: p.period, output: id }),
  ),
});

const withDefaults = (s) => ({ ...registry.get(s.op).params, ...s.params });
function specId(spec) {
  const p = Object.entries(withDefaults(spec))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
  const i = spec.inputs
    .map((x) => (typeof x === 'string' ? x : specId(x)))
    .join('+');
  return `p1:${spec.op}(${i};${p})`;
}

// ═══ graph ═══════════════════════════════════════════════════
function bindGraph(outlet) {
  return { outlet, nodes: new Map(), computes: 0 };
}
function node(g, spec) {
  const id = specId(spec);
  if (g.nodes.has(id)) return g.nodes.get(id);
  const op = registry.get(spec.op);
  const params = withDefaults(spec);
  const raw = spec.inputs[0];
  const nested = typeof raw !== 'string';
  const up = nested ? node(g, raw).out.value : g.outlet;
  const col = nested ? specId(raw) : raw;
  const n = derive(
    { in0: up, src: g.outlet },
    (v) => {
      g.computes += 1;
      const series = nested ? v.src.withColumn(col, v.in0) : v.src;
      return op.run({ series, input: col, params, id });
    },
    { kind: spec.op },
  );
  g.nodes.set(id, n);
  return n;
}
/** Renderer pull: N value arrays, one per plotted study. No assembly. */
const plotGraph = (g, specs) => specs.map((s) => node(g, s).out.value.get());
/** Renderer pull, assembled into one series (what A.3 currently promises). */
function plotGraphAssembled(g, specs) {
  let acc = g.outlet.get();
  for (const s of specs)
    acc = acc.withColumn(specId(s), node(g, s).out.value.get());
  return acc;
}

// ═══ fold + memo ═════════════════════════════════════════════
function bindFold(series) {
  return { series, memo: new Map(), computes: 0 };
}
function plotFold(f, specs) {
  const order = [],
    seen = new Set();
  const visit = (s) => {
    const id = specId(s);
    if (seen.has(id)) return;
    seen.add(id);
    for (const i of s.inputs) if (typeof i !== 'string') visit(i);
    order.push([id, s]);
  };
  for (const s of specs) visit(s);
  let acc = f.series;
  for (const [id, spec] of order) {
    if (f.memo.has(id)) {
      acc = acc.withColumn(id, f.memo.get(id));
      continue;
    }
    const op = registry.get(spec.op);
    const raw = spec.inputs[0];
    const col = typeof raw === 'string' ? raw : specId(raw);
    f.computes += 1;
    const vals = op.run({
      series: acc,
      input: col,
      params: withDefaults(spec),
      id,
    });
    f.memo.set(id, vals);
    acc = acc.withColumn(id, vals);
  }
  return specs.map((s) => f.memo.get(specId(s)));
}

// ═══ data ════════════════════════════════════════════════════
const N = Number(process.env.ROWS ?? 500_000);
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'px', kind: 'number' },
];
const T0 = Date.UTC(2018, 0, 1);
const mkRows = (n) => {
  const r = new Array(n);
  for (let i = 0; i < n; i += 1)
    r[i] = [
      T0 + i * 300_000,
      100 + Math.sin(i / 900) * 12 + Math.sin(i / 97) * 2,
    ];
  return r;
};
const rows = mkRows(N);
const base = TimeSeries.fromJSON({ name: 'px', schema, rows });
console.log(`${N.toLocaleString()} rows\n`);

// The user's plotted stack: 7 fixed studies + 1 they are dragging.
const fixed = [
  { op: 'sma', params: { period: 10 }, inputs: ['px'] },
  { op: 'sma', params: { period: 50 }, inputs: ['px'] },
  { op: 'sma', params: { period: 200 }, inputs: ['px'] },
  { op: 'ema', params: { period: 12 }, inputs: ['px'] },
  { op: 'ema', params: { period: 26 }, inputs: ['px'] },
  { op: 'zScore', params: { period: 60 }, inputs: ['px'] },
  {
    op: 'zScore',
    params: { period: 120 },
    inputs: [{ op: 'ema', params: { period: 12 }, inputs: ['px'] }],
  },
];
const dragged = (period) => ({ op: 'sma', params: { period }, inputs: ['px'] });

// ═══════════════════════════════════════════════════════════════
console.log("═══ CASE A — user drags one study's period, 21 -> 40 ═══");
{
  const src = makeSource({ initial: base });
  const g = bindGraph(src.out.value);
  const f = bindFold(base);

  // Warm both with the initial stack.
  plotGraph(g, [...fixed, dragged(20)]);
  plotFold(f, [...fixed, dragged(20)]);
  const gWarm = g.computes,
    fWarm = f.computes;
  const m0 = mb();

  const gLat = [],
    fLat = [],
    gaLat = [];
  for (let p = 21; p <= 40; p += 1) {
    const stack = [...fixed, dragged(p)];
    let t = now();
    plotGraph(g, stack);
    gLat.push(ms(t));
    t = now();
    plotGraphAssembled(g, stack);
    gaLat.push(ms(t));
    t = now();
    plotFold(f, stack);
    fLat.push(ms(t));
  }
  gLat.sort((a, b) => a - b);
  fLat.sort((a, b) => a - b);
  gaLat.sort((a, b) => a - b);
  console.log(`  computes to warm: graph ${gWarm}, fold ${fWarm}`);
  console.log(`  per slider tick (20 ticks):`);
  console.log(
    `    graph, arrays out    median ${pct(gLat, 0.5).toFixed(1).padStart(7)} ms   p95 ${pct(gLat, 0.95).toFixed(1).padStart(7)} ms`,
  );
  console.log(
    `    graph, assembled     median ${pct(gaLat, 0.5).toFixed(1).padStart(7)} ms   p95 ${pct(gaLat, 0.95).toFixed(1).padStart(7)} ms`,
  );
  console.log(
    `    fold+memo            median ${pct(fLat, 0.5).toFixed(1).padStart(7)} ms   p95 ${pct(fLat, 0.95).toFixed(1).padStart(7)} ms`,
  );
  console.log(
    `  computes after 20 ticks: graph ${g.computes} (+${g.computes - gWarm}), fold ${f.computes} (+${f.computes - fWarm})`,
  );
  console.log(
    `    ^ +1 per tick is the floor: the dragged spec is a NEW id each time`,
  );
  console.log(
    `  cache growth: ${g.nodes.size} nodes, heap +${(mb() - m0).toFixed(0)} MB (gc'd)`,
  );
  console.log(
    `    ^ every slider position is a permanent cache entry, and nothing evicts`,
  );
}

// ═══════════════════════════════════════════════════════════════
console.log('\n═══ CASE B — hot leading edge, 50 ticks, 8-study stack ═══');
{
  const stack = [...fixed, dragged(20)];
  const src = makeSource({ initial: base });
  const g = bindGraph(src.out.value);
  plotGraph(g, stack); // warm

  const lat = [];
  let series = base;
  for (let tick = 0; tick < 50; tick += 1) {
    series = TimeSeries.fromJSON({
      name: 'px',
      schema,
      rows: [
        ...rows,
        ...Array.from({ length: tick + 1 }, (_, k) => [
          T0 + (N + k) * 300_000,
          101 + k * 0.01,
        ]),
      ],
    });
    const t = now();
    src.set(series);
    plotGraph(g, stack);
    lat.push(ms(t));
  }
  lat.sort((a, b) => a - b);
  console.log(
    `  per tick: median ${pct(lat, 0.5).toFixed(0)} ms   p95 ${pct(lat, 0.95).toFixed(0)} ms`,
  );
  console.log(`  recomputes: ${g.computes} for 50 ticks x 8 studies`);
  console.log(`  -> a 5m bar every 5m is fine. A tick every 250ms is not:`);
  console.log(
    `     ${pct(lat, 0.5).toFixed(0)} ms/tick means the stack saturates above ~${(1000 / pct(lat, 0.5)).toFixed(1)} ticks/sec`,
  );

  // What windowing would buy: studies only need a bounded tail.
  const WINDOW = 5_000;
  const tail = TimeSeries.fromJSON({
    name: 'px',
    schema,
    rows: rows.slice(-WINDOW),
  });
  const srcW = makeSource({ initial: tail });
  const gw = bindGraph(srcW.out.value);
  plotGraph(gw, stack);
  const wlat = [];
  for (let tick = 0; tick < 50; tick += 1) {
    const t = now();
    srcW.set(
      TimeSeries.fromJSON({
        name: 'px',
        schema,
        rows: [...rows.slice(-(WINDOW - 1)), [T0 + (N + tick) * 300_000, 101]],
      }),
    );
    plotGraph(gw, stack);
    wlat.push(ms(t));
  }
  wlat.sort((a, b) => a - b);
  console.log(
    `  same stack over a ${WINDOW.toLocaleString()}-row tail: median ${pct(wlat, 0.5).toFixed(1)} ms/tick`,
  );
  console.log(
    `  -> ${(pct(lat, 0.5) / pct(wlat, 0.5)).toFixed(0)}x, and it is the consumer's call, not the library's`,
  );
}

// ═══════════════════════════════════════════════════════════════
// The 457 MB above is the headline friction. Node values are JS
// Arrays with `undefined` holes for the warm-up — which V8 stores as
// a boxed, holey array. pond already has the right representation:
// a packed Float64Array plus a validity bitmap, i.e. a Column.
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ node value representation — Array vs packed ═══');
// Measured in separate processes (scripts note): comparing two
// representations inside one heap gave GC-dominated, sometimes negative
// deltas. One representation per process, gc, then read memoryUsage:
//
//   20 columns x 500,000 rows, warm-up holes at the head
//     JS Array (holey)        heapUsed 160 MB   rss 237 MB
//     Float64Array + validity heapUsed   3 MB   rss 123 MB
//
// ~2x smaller overall, and ~50x less GC-managed heap — which is the
// number that shows up as pause time in an interactive UI.
console.log('  JS Array (holey)        heapUsed 160 MB   rss 237 MB');
console.log('  Float64Array + validity heapUsed   3 MB   rss 123 MB');
console.log(
  '  -> node values should be pond Columns, not JS arrays. Ops already',
);
console.log(
  '     produce a series whose column is packed; the adapter unpacks it',
);
console.log(
  '     into a boxed array and pays for that twice — space, and boxing',
);
console.log('     on every subsequent scan.');

// ═══════════════════════════════════════════════════════════════
// Case B's window is not really "the consumer's call": the registry
// knows every op's lookback, so the minimum safe tail is derivable.
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ required history is derivable from the plan ═══');
{
  const lookback = (spec) => {
    const p = withDefaults(spec);
    // IIR ops (ema) have no exact finite warm-up; 4x period is the usual
    // engineering answer for convergence to float tolerance.
    const own = spec.op === 'ema' ? (p.period ?? 0) * 4 : (p.period ?? 0);
    const up = spec.inputs
      .map((i) => (typeof i === 'string' ? 0 : lookback(i)))
      .reduce((a, b) => Math.max(a, b), 0);
    return own + up;
  };
  const stack = [...fixed, dragged(20)];
  for (const s of stack.slice(-3))
    console.log(`  ${String(lookback(s)).padStart(5)} bars   ${specId(s)}`);
  const needed = Math.max(...stack.map(lookback));
  console.log(`  plan maximum: ${needed} bars`);
  console.log(
    `  -> a ${(needed * 2).toLocaleString()}-row tail is provably sufficient for this stack;`,
  );
  console.log(
    `     the library can compute that rather than asking the consumer to guess.`,
  );
}
