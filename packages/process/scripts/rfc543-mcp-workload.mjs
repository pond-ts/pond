/**
 * RFC #543 — the MCP workload, which step 0 failed to model.
 *
 * Step 0 measured "same plan, repeated, select everything", where a fold
 * and a graph tie by construction. The workload that actually motivates
 * the design is different in four ways:
 *
 *   - the source is EXPENSIVE and long-lived (1M 5m bars, years of data);
 *   - it changes only at the TAIL, every 5 minutes, by one bar;
 *   - an agent fires DOZENS of heterogeneous questions between changes;
 *   - those questions OVERLAP heavily — the same smoothing, the same
 *     extremes, reused across many different asks.
 *
 * Under that shape the interesting quantity is not "how long does one
 * resolve take" but "what fraction of a session's work is shared", and
 * whether the framework tax on the pull side is small enough to leave the
 * caching win intact.
 *
 * Throwaway. Not package API, not published.
 *     node scripts/rfc543-mcp-workload.mjs
 */
import { TimeSeries } from '../../core/dist/index.js';
import { sma, ema, zScore } from '../../financial/dist/index.js';
import { derive, source as makeSource } from '../dist/index.js';

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const now = () => process.hrtime.bigint();

// ── column values, the columns-not-events way ────────────────
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

// ═══ registry — value-returning ops (step 0 variant B) ═══════
const registry = new Map();
const defineOp = (o) => registry.set(o.name, o);
const single =
  (fn) =>
  ({ series, input, params, id }) =>
    valuesOf(fn(series, input, params, id).column(id));

defineOp({
  name: 'sma',
  params: { period: 20 },
  arity: 1,
  run: single((s, c, p, id) =>
    sma(s, { column: c, period: p.period, output: id }),
  ),
});
defineOp({
  name: 'ema',
  params: { period: 20 },
  arity: 1,
  run: single((s, c, p, id) =>
    ema(s, { column: c, period: p.period, output: id }),
  ),
});
defineOp({
  name: 'zScore',
  params: { period: 60 },
  arity: 1,
  run: single((s, c, p, id) =>
    zScore(s, { column: c, period: p.period, output: id }),
  ),
});
defineOp({
  name: 'spread',
  params: {},
  arity: 2,
  run: ({ inputs }) => {
    const [a, b] = inputs;
    const out = new Array(a.length);
    for (let i = 0; i < a.length; i += 1)
      out[i] =
        a[i] === undefined || b[i] === undefined ? undefined : a[i] - b[i];
    return out;
  },
});

const withDefaults = (spec) => ({
  ...registry.get(spec.op).params,
  ...spec.params,
});
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

// ═══ THE GRAPH ══════════════════════════════════════════════
function bindGraph(sourceOutlet) {
  return { sourceOutlet, nodes: new Map(), specs: new Map(), computes: 0 };
}
function compileNode(g, spec) {
  const id = specId(spec);
  if (g.nodes.has(id)) return g.nodes.get(id);
  const op = registry.get(spec.op);
  const params = withDefaults(spec);
  const bound = spec.inputs.map((raw) =>
    typeof raw === 'string'
      ? { outlet: g.sourceOutlet, column: raw, nested: false }
      : {
          outlet: compileNode(g, raw).out.value,
          column: specId(raw),
          nested: true,
        },
  );
  const inlets = Object.fromEntries(bound.map((b, i) => [`in${i}`, b.outlet]));
  const node = derive(
    { ...inlets, src: g.sourceOutlet },
    (vals) => {
      g.computes += 1;
      const src = vals.src;
      if (op.arity === 1) {
        const b = bound[0];
        const series = b.nested ? src.withColumn(b.column, vals.in0) : src;
        return op.run({ series, input: b.column, params, id });
      }
      const inputs = bound.map((b, i) =>
        b.nested ? vals[`in${i}`] : valuesOf(src.column(b.column)),
      );
      return op.run({ inputs, params, id });
    },
    { kind: spec.op },
  );
  g.nodes.set(id, node);
  g.specs.set(id, spec);
  return node;
}
/** One agent question: compile if new, pull the selected ids, assemble. */
function askGraph(g, specs) {
  for (const s of specs) compileNode(g, s);
  let assembled = g.sourceOutlet.get();
  for (const s of specs) {
    const id = specId(s);
    assembled = assembled.withColumn(id, g.nodes.get(id).out.value.get());
  }
  return assembled;
}

// ═══ THE FOLD + (binding, specId) MEMO ══════════════════════
// Implemented as favourably as possible: it resolves only the closure a
// question needs, not the whole catalog, and memoizes values by id.
function bindFold(series) {
  return { series, memo: new Map(), computes: 0 };
}
function askFold(f, specs) {
  const order = [];
  const seen = new Set();
  const visit = (spec) => {
    const id = specId(spec);
    if (seen.has(id)) return;
    seen.add(id);
    for (const i of spec.inputs) if (typeof i !== 'string') visit(i);
    order.push([id, spec]);
  };
  for (const s of specs) visit(s);

  let acc = f.series;
  for (const [id, spec] of order) {
    if (f.memo.has(id)) {
      acc = acc.withColumn(id, f.memo.get(id));
      continue;
    }
    const op = registry.get(spec.op);
    const params = withDefaults(spec);
    const cols = spec.inputs.map((i) =>
      typeof i === 'string' ? i : specId(i),
    );
    f.computes += 1;
    const vals =
      op.arity === 1
        ? op.run({ series: acc, input: cols[0], params, id })
        : op.run({
            inputs: cols.map((c) => valuesOf(acc.column(c))),
            params,
            id,
          });
    f.memo.set(id, vals);
    acc = acc.withColumn(id, vals);
  }
  return acc;
}

// ═══ data: 1M 5-minute bars ═════════════════════════════════
const N = Number(process.env.ROWS ?? 1_000_000);
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'px', kind: 'number' },
];
console.log(`building ${N.toLocaleString()} 5m bars…`);
let t0 = now();
const rows = new Array(N);
const T0 = Date.UTC(2016, 0, 1);
for (let i = 0; i < N; i += 1)
  rows[i] = [
    T0 + i * 300_000,
    100 + Math.sin(i / 900) * 12 + Math.sin(i / 97) * 2,
  ];
const base = TimeSeries.fromJSON({ name: 'px', schema, rows });
console.log(
  `  source acquisition: ${ms(t0).toFixed(0)} ms  (the thing you don't redo)\n`,
);

// ═══ a catalog an agent draws from ══════════════════════════
const catalog = [];
for (const p of [10, 20, 50, 100, 200])
  catalog.push({ op: 'sma', params: { period: p }, inputs: ['px'] });
for (const p of [12, 26, 50])
  catalog.push({ op: 'ema', params: { period: p }, inputs: ['px'] });
for (const p of [30, 60, 120])
  catalog.push({ op: 'zScore', params: { period: p }, inputs: ['px'] });
catalog.push({
  op: 'spread',
  params: {},
  inputs: [
    { op: 'sma', params: { period: 20 }, inputs: ['px'] },
    { op: 'sma', params: { period: 50 }, inputs: ['px'] },
  ],
});
catalog.push({
  op: 'zScore',
  params: { period: 60 },
  inputs: [{ op: 'ema', params: { period: 12 }, inputs: ['px'] }],
});

// Zipf-ish: an agent reuses a few favourites far more than the tail.
function question(rng) {
  const pick = () => {
    const r = rng();
    return catalog[
      Math.min(catalog.length - 1, Math.floor(catalog.length * r * r))
    ];
  };
  const k = 1 + Math.floor(rng() * 3);
  const out = new Set();
  for (let i = 0; i < k; i += 1) out.add(pick());
  return [...out];
}
let seed = 12345;
const rng = () =>
  (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

const QUESTIONS = 60;
const session = [];
for (let i = 0; i < QUESTIONS; i += 1) session.push(question(rng));

// ═══ run the session ════════════════════════════════════════
function runSession(label, ask, ctx, ctxComputes) {
  const lat = [];
  t0 = now();
  for (const specs of session) {
    const q = now();
    ask(ctx, specs);
    lat.push(ms(q));
  }
  const total = ms(t0);
  lat.sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(11)} total ${total.toFixed(0).padStart(6)} ms   ` +
      `median ${lat[Math.floor(lat.length / 2)].toFixed(1).padStart(6)} ms   ` +
      `p95 ${lat[Math.floor(lat.length * 0.95)].toFixed(1).padStart(6)} ms   ` +
      `computes ${ctxComputes()}`,
  );
  return { total, lat };
}

console.log(
  `agent session: ${QUESTIONS} questions over a ${catalog.length}-spec catalog`,
);
const src = makeSource({ initial: base });
const g = bindGraph(src.out.value);
const f = bindFold(base);
const G = runSession('graph', askGraph, g, () => g.computes);
const F = runSession('fold+memo', askFold, f, () => f.computes);
console.log(
  `  -> graph is ${(F.total / G.total).toFixed(2)}x ${F.total > G.total ? 'faster' : 'slower'} over the session\n`,
);

// ═══ a new bar lands, then another flurry ═══════════════════
console.log('a new 5m bar arrives, then 20 more questions:');
const grown = TimeSeries.fromJSON({
  name: 'px',
  schema,
  rows: [...rows, [T0 + N * 300_000, 101]],
});
const flurry = session.slice(0, 20);

t0 = now();
src.set(grown);
for (const specs of flurry) askGraph(g, specs);
const gAfter = ms(t0);

t0 = now();
f.series = grown;
f.memo.clear(); // a value memo keyed by specId is stale-blind; must clear
for (const specs of flurry) askFold(f, specs);
const fAfter = ms(t0);
console.log(
  `  graph     ${gAfter.toFixed(0)} ms   (recomputes: ${g.computes} cumulative)`,
);
console.log(
  `  fold+memo ${fAfter.toFixed(0)} ms   (recomputes: ${f.computes} cumulative)`,
);

// ═══════════════════════════════════════════════════════════════
// BRIDGING THE FRAMEWORK TAX
//
// The median cache-hit question above costs ~O(rows) even though every
// node value was already computed. That cost is ASSEMBLY: rebuilding a
// TimeSeries by appending the selected columns onto a 1M-row source, so a
// reduction has a column to read.
//
// But an agent almost never wants columns — it wants facts. And a fact is
// a fold over an array the node is ALREADY holding. Assembly is pure
// overhead on that path: the values are right there.
// ═══════════════════════════════════════════════════════════════
const reduce = {
  last: (v) => {
    for (let i = v.length - 1; i >= 0; i -= 1)
      if (v[i] !== undefined) return v[i];
    return null;
  },
  max: (v) => {
    let m = -Infinity;
    for (let i = 0; i < v.length; i += 1)
      if (v[i] !== undefined && v[i] > m) m = v[i];
    return m;
  },
  min: (v) => {
    let m = Infinity;
    for (let i = 0; i < v.length; i += 1)
      if (v[i] !== undefined && v[i] < m) m = v[i];
    return m;
  },
};

/** Naive: assemble a series, then read the column back out of it. */
function askFactsViaAssembly(g, specs, kind) {
  for (const s of specs) compileNode(g, s);
  let assembled = g.sourceOutlet.get();
  for (const s of specs)
    assembled = assembled.withColumn(
      specId(s),
      g.nodes.get(specId(s)).out.value.get(),
    );
  return specs.map((s) => reduce[kind](valuesOf(assembled.column(specId(s)))));
}

/** Bridged: the node already holds the array. Skip the series entirely. */
function askFactsDirect(g, specs, kind) {
  for (const s of specs) compileNode(g, s);
  return specs.map((s) => reduce[kind](g.nodes.get(specId(s)).out.value.get()));
}

/** Bridged + memoized: a fact is pure in (node version, reduction). */
const factCache = new Map();
function askFactsMemo(g, specs, kind) {
  for (const s of specs) compileNode(g, s);
  return specs.map((s) => {
    const id = specId(s);
    const node = g.nodes.get(id);
    const vals = node.out.value.get(); // O(1) when clean
    const key = `${id}|${kind}|${node.out.value.version}`;
    let hit = factCache.get(key);
    if (hit === undefined) {
      hit = reduce[kind](vals);
      factCache.set(key, hit);
    }
    return hit;
  });
}

function timeSession(label, fn) {
  const lat = [];
  const t = now();
  for (const specs of session) {
    const q = now();
    fn(specs, 'max');
    lat.push(ms(q));
  }
  const total = ms(t);
  lat.sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(26)} total ${total.toFixed(0).padStart(6)} ms   ` +
      `median ${lat[Math.floor(lat.length / 2)].toFixed(3).padStart(8)} ms`,
  );
  return total;
}

console.log('\nthe same 60 questions, but asking for FACTS (the agent shape):');
const warm = bindGraph(makeSource({ initial: base }).out.value);
for (const specs of session) askFactsDirect(warm, specs, 'max'); // warm the nodes
const viaAsm = timeSession('assemble, then reduce', (s, k) =>
  askFactsViaAssembly(warm, s, k),
);
const direct = timeSession('reduce off cached values', (s, k) =>
  askFactsDirect(warm, s, k),
);
const memoed = timeSession('+ memoize by node version', (s, k) =>
  askFactsMemo(warm, s, k),
);
console.log(
  `  -> skipping assembly: ${(viaAsm / direct).toFixed(0)}x   ` +
    `memoizing facts: ${(viaAsm / memoed).toFixed(0)}x`,
);

// Correctness: the bridge must not change an answer.
const a = askFactsViaAssembly(warm, session[0], 'max');
const b = askFactsDirect(warm, session[0], 'max');
const c = askFactsMemo(warm, session[0], 'max');
console.log(
  `  answers agree: ${JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c)}`,
);

// And the fact cache must not survive a data change.
const src2 = makeSource({ initial: base });
const g2 = bindGraph(src2.out.value);
const before = askFactsMemo(g2, [catalog[1]], 'max')[0];
src2.set(
  TimeSeries.fromJSON({
    name: 'px',
    schema,
    rows: [...rows.slice(0, 1000), [T0 + 1000 * 300_000, 9999]],
  }),
);
const after = askFactsMemo(g2, [catalog[1]], 'max')[0];
console.log(
  `  fact cache invalidates on data change: ${before !== after}  (${before?.toFixed?.(2)} -> ${after?.toFixed?.(2)})`,
);
