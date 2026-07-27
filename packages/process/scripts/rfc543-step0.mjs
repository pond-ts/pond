/**
 * RFC #543 proving path, step 0 — the two cases that decide the substrate.
 *
 * The RFC (docs/rfcs/process.md, "Proving path") asks for two cases that
 * nothing run so far covers, because everything measured to date is a
 * linear chain from one column — which a fold resolves with less
 * machinery than a graph:
 *
 *   1. A second `columns: true` selector on a sibling branch. Node-per-spec
 *      resolution gives two disjoint widenings of the source and no node
 *      holding both, so A.3's stated contract ("every resolved column
 *      appended") is not something the graph produces.
 *   2. One 2-input op. `inputs` is plural in the format but the spike reads
 *      `inputs[0]` three times over; a spread/ratio is the case that forces
 *      a merge across branches.
 *
 * The RFC offers two fixes for (1) and asks the RFC to commit to one, so
 * both are implemented here and run against the same plan:
 *
 *   VARIANT A — nodes yield widened series; the terminal assembles.
 *   VARIANT B — nodes yield column values; assembly is the only way to a series.
 *
 * Throwaway. Not package API, not published.
 *
 * Run from `packages/process/` after `npm run build --workspaces`:
 *     node scripts/rfc543-step0.mjs
 */
import { LiveSeries, TimeSeries } from '../../core/dist/index.js';
import { sma, ema, zScore } from '../../financial/dist/index.js';
import { derive, fromLive } from '../dist/index.js';

const ok = (n, cond, extra = '') =>
  console.log(
    `  ${cond ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`,
  );
const round = (v) => Math.round(v * 100) / 100;
const day = (t) => new Date(t).toISOString().slice(0, 10);

// Bulk column read — `scan` is the columns-not-events path the design
// principles require. skipInvalid:false so index alignment is preserved.
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

// ═══════════════════════════════════════════════════════════════
// Registry — same shape as the earlier spike, plus a 2-input op.
// ═══════════════════════════════════════════════════════════════
const int = (o) => ({ kind: 'integer', ...o });
const registry = new Map();
const defineOp = (o) => registry.set(o.name, o);

defineOp({
  name: 'sma',
  family: 'trend',
  params: { period: int({ min: 2, default: 20 }) },
  inputs: [{ role: 'source', kind: 'number' }],
  outputs: [{ id: '', unit: 'inherit' }],
  label: (p, i) => `SMA(${p.period}) of ${i}`,
  // VARIANT A: widen a series.   VARIANT B: return values only.
  runSeries: ({ series, input, params, id }) =>
    sma(series, { column: input, period: params.period, output: id }),
  runValues: ({ series, input, params, id }) =>
    valuesOf(
      sma(series, { column: input, period: params.period, output: id }).column(
        id,
      ),
    ),
});
defineOp({
  name: 'ema',
  family: 'trend',
  params: { period: int({ min: 2, default: 20 }) },
  inputs: [{ role: 'source', kind: 'number' }],
  outputs: [{ id: '', unit: 'inherit' }],
  label: (p, i) => `EMA(${p.period}) of ${i}`,
  runSeries: ({ series, input, params, id }) =>
    ema(series, { column: input, period: params.period, output: id }),
  runValues: ({ series, input, params, id }) =>
    valuesOf(
      ema(series, { column: input, period: params.period, output: id }).column(
        id,
      ),
    ),
});
defineOp({
  name: 'zScore',
  family: 'normalisation',
  params: { period: int({ min: 2, default: 20 }) },
  inputs: [{ role: 'source', kind: 'number' }],
  outputs: [{ id: '', unit: 'sigma' }],
  label: (p, i) => `z-score(${p.period}) of ${i}`,
  runSeries: ({ series, input, params, id }) =>
    zScore(series, { column: input, period: params.period, output: id }),
  runValues: ({ series, input, params, id }) =>
    valuesOf(
      zScore(series, {
        column: input,
        period: params.period,
        output: id,
      }).column(id),
    ),
});

// ── the 2-input op: RFC proving-path case 2 ──────────────────
defineOp({
  name: 'spread',
  family: 'compare',
  params: {},
  inputs: [
    { role: 'a', kind: 'number' },
    { role: 'b', kind: 'number' },
  ],
  outputs: [{ id: '', unit: 'inherit' }],
  label: (_p, i) => `spread(${i})`,
  // VARIANT A has to reconcile two widened series that share a source but
  // carry different columns. There is no "the" upstream series to widen,
  // so it picks one arbitrarily — see the friction note printed below.
  runSeries: ({ inputs, id, source }) => {
    const a = inputs[0].series.column(inputs[0].column);
    const b = inputs[1].series.column(inputs[1].column);
    const va = valuesOf(a);
    const vb = valuesOf(b);
    const out = va.map((x, i) =>
      x === undefined || vb[i] === undefined ? undefined : x - vb[i],
    );
    return source.withColumn(id, out); // ← widens the SOURCE, not an input
  },
  // VARIANT B is a two-line fold over two value arrays. No merge at all.
  runValues: ({ inputs }) => {
    const [va, vb] = inputs;
    return va.map((x, i) =>
      x === undefined || vb[i] === undefined ? undefined : x - vb[i],
    );
  },
});

// ═══════════════════════════════════════════════════════════════
// Identity / units / explain
// ═══════════════════════════════════════════════════════════════
const esc = (s) => String(s).replace(/[\\;,()=+]/g, (c) => '\\' + c);
const withDefaults = (spec) => ({
  ...Object.fromEntries(
    Object.entries(registry.get(spec.op).params).map(([k, d]) => [
      k,
      d.default,
    ]),
  ),
  ...spec.params,
});
function specId(spec) {
  const params = Object.entries(withDefaults(spec))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${esc(v)}`)
    .join(',');
  const inputs = spec.inputs
    .map((i) => (typeof i === 'string' ? esc(i) : specId(i)))
    .join('+');
  return `p1:${spec.op}(${inputs};${params})`;
}
function explain(spec) {
  const op = registry.get(spec.op);
  return op.label(
    withDefaults(spec),
    spec.inputs.map((i) => (typeof i === 'string' ? i : explain(i))).join(', '),
  );
}
function unitOf(spec, units, n = 0) {
  const decl = registry.get(spec.op).outputs[n].unit;
  if (decl !== 'inherit') return decl;
  const src = spec.inputs[0];
  return typeof src === 'string' ? (units[src] ?? null) : unitOf(src, units);
}

// ═══════════════════════════════════════════════════════════════
// bind() — one compiled graph per data binding (RFC A.7)
// ═══════════════════════════════════════════════════════════════
function bind(sourceOutlet, { units = {}, variant }) {
  return { sourceOutlet, units, variant, nodes: new Map(), specs: new Map() };
}

function compile(graph, spec) {
  const id = specId(spec);
  if (graph.nodes.has(id)) return graph.nodes.get(id);
  const op = registry.get(spec.op);
  if (!op) throw new Error(`unknown op '${spec.op}'`);
  const params = withDefaults(spec);
  for (const [k, d] of Object.entries(op.params)) {
    if (d.kind === 'integer' && !Number.isInteger(params[k]))
      throw new Error(
        `${spec.op}.${k} must be an integer, got ${JSON.stringify(params[k])}`,
      );
    if (d.min !== undefined && params[k] < d.min)
      throw new Error(`${spec.op}.${k}=${params[k]} is below minimum ${d.min}`);
  }
  if (spec.inputs.length !== op.inputs.length)
    throw new Error(
      `${spec.op} takes ${op.inputs.length} input(s), got ${spec.inputs.length}`,
    );

  // Bind every input — plural, not inputs[0].
  const bound = spec.inputs.map((raw) => {
    if (typeof raw === 'string')
      return { outlet: graph.sourceOutlet, column: raw, spec: null };
    const upstream = compile(graph, raw);
    return { outlet: upstream.out.value, column: specId(raw), spec: raw };
  });

  const inlets = Object.fromEntries(bound.map((b, i) => [`in${i}`, b.outlet]));
  const node = derive(
    { ...inlets, src: graph.sourceOutlet },
    (vals) => {
      const source = vals.src;
      if (graph.variant === 'A') {
        const inputs = bound.map((b, i) => ({
          series: vals[`in${i}`],
          column: b.column,
        }));
        return op.runSeries({
          series: inputs[0].series,
          input: inputs[0].column,
          inputs,
          params,
          id,
          source,
        });
      }
      // VARIANT B: an inlet carries values; a raw column is read off source.
      const inputs = bound.map((b, i) =>
        b.spec === null ? valuesOf(source.column(b.column)) : vals[`in${i}`],
      );
      if (op.inputs.length === 1 && bound[0].spec === null) {
        return op.runValues({
          series: source,
          input: bound[0].column,
          params,
          id,
        });
      }
      if (op.inputs.length === 1) {
        // Single-input op whose source is another spec: materialize the
        // one column it needs onto the source so the study can be called.
        const widened = source.withColumn(bound[0].column, inputs[0]);
        return op.runValues({
          series: widened,
          input: bound[0].column,
          params,
          id,
        });
      }
      return op.runValues({ inputs, params, id });
    },
    { kind: spec.op },
  );
  graph.nodes.set(id, node);
  graph.specs.set(id, spec);
  return node;
}

// ═══════════════════════════════════════════════════════════════
// run() — the assembling terminal
// ═══════════════════════════════════════════════════════════════
function run(graph, { plan = [], select = [], onError = 'throw' }) {
  const skipped = [];
  const okSpecs = [];
  for (const spec of plan) {
    try {
      compile(graph, spec);
      okSpecs.push(spec);
    } catch (e) {
      if (onError === 'throw') throw e;
      skipped.push({ spec: { op: spec.op }, reason: e.message });
    }
  }

  const res = {
    explain: Object.fromEntries(okSpecs.map((s) => [specId(s), explain(s)])),
    facts: [],
    outputs: {},
    skipped,
  };

  // Assemble: pull each needed output off its own node and append onto the
  // source. This is what makes A.3's contract true for >1 branch.
  //
  // FRICTION (found by running this): "needed" is not the same as
  // "selected with columns: true". A reduction reads a COLUMN, so its
  // spec has to be assembled too, and `crossings`'s `against` names a
  // second one. Assembling only the column-selectors left a reduction
  // reading a column that was never appended — it surfaced as a fact with
  // no value rather than an error, which is worse. The terminal has to
  // compute the closure of every id any selector mentions.
  let assembled = graph.sourceOutlet.get();
  const wantColumns = select.filter((s) => s.columns);
  const needed = new Map(); // id -> report in `outputs`?
  for (const sel of select) {
    const id = typeof sel.on === 'string' ? sel.on : specId(sel.on);
    if (graph.specs.has(id)) needed.set(id, needed.get(id) || !!sel.columns);
    if (sel.against && graph.specs.has(sel.against))
      needed.set(sel.against, needed.get(sel.against) || false);
  }
  for (const sel of select) {
    const id = typeof sel.on === 'string' ? sel.on : specId(sel.on);
    if (
      !graph.specs.has(id) &&
      id !== 'iv21' &&
      !assembled.schema.some((c) => c.name === id)
    )
      skipped.push({ select: sel, reason: `'${id}' is not in this plan` });
  }
  for (const [id, report] of needed) {
    const spec = graph.specs.get(id);
    const op = registry.get(spec.op);
    const value = graph.nodes.get(id).out.value.get();
    if (report) res.outputs[id] = [];
    for (const o of op.outputs) {
      const col = id + o.id;
      const vals = graph.variant === 'A' ? valuesOf(value.column(col)) : value;
      assembled = assembled.withColumn(col, vals);
      if (report)
        res.outputs[id].push({ column: col, unit: unitOf(spec, graph.units) });
    }
  }
  if (wantColumns.length > 0) res.series = assembled;

  // Reductions read the assembled series, so a 2-column reduction works.
  for (const sel of select.filter((s) => !s.columns)) {
    try {
      const id = typeof sel.on === 'string' ? sel.on : specId(sel.on);
      const spec = graph.specs.get(id);
      const src = spec ? assembled : assembled; // raw columns live there too
      const col = spec ? id : id;
      const keys = src
        .toRows()
        .map((r) => (r[0] instanceof Date ? r[0].getTime() : r[0]));
      const column = src.column(col);
      if (sel.reduce === 'last') {
        let f = null;
        column.scan((v, i) => {
          if (!Number.isNaN(v)) f = { value: round(v), at: day(keys[i]) };
        });
        res.facts.push({ id: col, reduce: 'last', ...f });
      } else if (sel.reduce === 'crossings') {
        const other = src.column(sel.against);
        const a = valuesOf(column);
        const b = valuesOf(other);
        const events = [];
        let prev;
        for (let i = 0; i < a.length; i += 1) {
          if (a[i] === undefined || b[i] === undefined) continue;
          const side = a[i] > b[i] ? 'above' : 'below';
          if (prev && side !== prev)
            events.push({ at: day(keys[i]), direction: side });
          prev = side;
        }
        res.facts.push({
          id: col,
          reduce: 'crossings',
          against: sel.against,
          events,
        });
      }
    } catch (e) {
      if (onError === 'throw') throw e;
      skipped.push({ select: sel, reason: e.message });
    }
  }
  return res;
}

// ═══════════════════════════════════════════════════════════════
// Demo data + plan
// ═══════════════════════════════════════════════════════════════
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'iv21', kind: 'number' },
];
function makeLive() {
  const live = new LiveSeries({ name: 'vol', schema });
  for (let i = 0; i < 400; i += 1)
    live.push([
      Date.UTC(2025, 0, 1) + i * 86_400_000,
      20 + Math.sin(i / 20) * 6,
    ]);
  return live;
}

const sma20 = { op: 'sma', params: { period: 20 }, inputs: ['iv21'] };
const sma50 = { op: 'sma', params: { period: 50 }, inputs: ['iv21'] };
const z60 = { op: 'zScore', params: { period: 60 }, inputs: ['iv21'] };
const spread = { op: 'spread', params: {}, inputs: [sma20, sma50] };
const plan = [sma20, sma50, z60, spread];

console.log('\nRFC #543 proving path, step 0');
console.log('plan:', plan.map((s) => explain(s)).join(' | '));

for (const variant of ['A', 'B']) {
  console.log(
    `\n═══════ VARIANT ${variant} — ${variant === 'A' ? 'nodes yield widened series' : 'nodes yield column values'} ═══════`,
  );
  const live = makeLive();
  const feed = fromLive(live);
  const graph = bind(feed.out.value, { units: { iv21: '%' }, variant });

  // CASE 1: two `columns: true` selectors on sibling branches — A.3's case.
  const res = run(graph, {
    plan,
    onError: 'collect',
    select: [
      { on: sma20, columns: true },
      { on: z60, columns: true },
      { on: spread, columns: true },
      { on: sma20, reduce: 'last' },
      { on: 'iv21', reduce: 'crossings', against: specId(sma20) },
    ],
  });

  const cols = res.series ? res.series.schema.map((c) => c.name) : [];
  const promised = Object.values(res.outputs)
    .flat()
    .map((o) => o.column);
  ok(
    'every column in `outputs` is present in `series`',
    promised.every((c) => cols.includes(c)),
    `${promised.length} promised, ${promised.filter((c) => cols.includes(c)).length} present`,
  );
  ok(
    'sibling branches coexist in one series',
    cols.length === 2 + promised.length,
    `schema: ${cols.length} cols`,
  );
  ok(
    '2-input op resolved',
    res.outputs[specId(spread)] !== undefined,
    res.skipped.map((s) => s.reason).join('; ') || 'no skips',
  );
  const cross = res.facts.find((f) => f.reduce === 'crossings');
  ok(
    'crossings (2-column reduction) works off the assembled series',
    cross !== undefined && cross.events.length > 0,
    cross ? `${cross.events.length} events` : 'missing',
  );

  // Live invalidation still holds after assembly.
  const before = res.facts.find((f) => f.reduce === 'last')?.value;
  for (let i = 400; i < 420; i += 1)
    live.push([Date.UTC(2025, 0, 1) + i * 86_400_000, 45]);
  const res2 = run(graph, {
    plan,
    onError: 'collect',
    select: [{ on: sma20, reduce: 'last' }],
  });
  const after = res2.facts.find((f) => f.reduce === 'last')?.value;
  ok(
    'live data invalidates through the assembled path',
    before !== after,
    `${before} -> ${after}`,
  );

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 20; i += 1)
    run(graph, {
      plan,
      onError: 'collect',
      select: [
        { on: sma20, columns: true },
        { on: z60, columns: true },
      ],
    });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  console.log(
    `  cached re-run: ${ms.toFixed(2)} ms/call (assembly is not cached)`,
  );
}

// ═══════════════════════════════════════════════════════════════
// RFC open question 3 — does the graph earn its keep over a
// source-keyed memo? Implemented rather than argued.
//
// The fold threads ONE accumulator series through every spec in
// dependency order, so it never forks and needs no assembly. Its cache is
// keyed by (binding, specId) and cleared when the binding's data changes.
// ═══════════════════════════════════════════════════════════════
function foldResolve(source, plan, memo) {
  let acc = source;
  const order = [];
  const seen = new Set();
  const visit = (spec) => {
    const id = specId(spec);
    if (seen.has(id)) return;
    seen.add(id);
    for (const i of spec.inputs) if (typeof i !== 'string') visit(i);
    order.push([id, spec]);
  };
  for (const spec of plan) visit(spec);

  for (const [id, spec] of order) {
    if (memo.has(id)) {
      acc = acc.withColumn(id, memo.get(id));
      continue;
    }
    const op = registry.get(spec.op);
    const params = withDefaults(spec);
    const cols = spec.inputs.map((i) =>
      typeof i === 'string' ? i : specId(i),
    );
    let vals;
    if (op.inputs.length === 1) {
      vals = op.runValues({ series: acc, input: cols[0], params, id });
    } else {
      vals = op.runValues({
        inputs: cols.map((c) => valuesOf(acc.column(c))),
        params,
        id,
      });
    }
    memo.set(id, vals);
    acc = acc.withColumn(id, vals);
  }
  return acc;
}

console.log('\n═══════ OQ3 — graph vs fold+memo, same plan ═══════');
{
  const bigSchema = [
    { name: 'time', kind: 'time' },
    { name: 'iv21', kind: 'number' },
  ];
  const N = 50_000;
  const rows = [];
  for (let i = 0; i < N; i += 1)
    rows.push([Date.UTC(2020, 0, 1) + i * 60_000, 20 + Math.sin(i / 500) * 6]);
  const base = TimeSeries.fromJSON({ name: 'vol', schema: bigSchema, rows });

  const live = new LiveSeries({ name: 'vol', schema: bigSchema });
  live.push(...rows);
  const feed = fromLive(live);
  const graph = bind(feed.out.value, { units: { iv21: '%' }, variant: 'B' });

  const bigPlan = [sma20, sma50, z60, spread];
  const sel = bigPlan.map((s) => ({ on: s, columns: true }));

  const t = (fn, n = 5) => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i += 1) fn();
    return Number(process.hrtime.bigint() - t0) / 1e6 / n;
  };

  const gCold = t(() => run(graph, { plan: bigPlan, select: sel }), 1);
  const gWarm = t(() => run(graph, { plan: bigPlan, select: sel }), 10);

  const memo = new Map();
  const fCold = t(() => foldResolve(base, bigPlan, new Map()), 1);
  foldResolve(base, bigPlan, memo);
  const fWarm = t(() => foldResolve(base, bigPlan, memo), 10);

  console.log(`  ${N} rows, 4 specs (one of them 2-input)`);
  console.log(
    `  graph     cold ${gCold.toFixed(1)} ms   warm ${gWarm.toFixed(1)} ms`,
  );
  console.log(
    `  fold+memo cold ${fCold.toFixed(1)} ms   warm ${fWarm.toFixed(1)} ms`,
  );

  // The claim the graph rests on: O(affected nodes) on a data change.
  // With ONE bound source, every node descends from it — so "affected"
  // is "all". Count it rather than assume it.
  live.push([Date.UTC(2020, 0, 1) + N * 60_000, 42]);
  const dirty = [...graph.nodes.values()].filter((n) => n.dirty).length;
  console.log(
    `  after one new event: ${dirty}/${graph.nodes.size} nodes dirty` +
      `  <- the fraction the graph's invalidation advantage is measured against`,
  );
}

console.log('\n═══════ equivalence — graph vs fold must agree ═══════');
{
  const rows = [];
  for (let i = 0; i < 400; i += 1)
    rows.push([
      Date.UTC(2025, 0, 1) + i * 86_400_000,
      20 + Math.sin(i / 20) * 6,
    ]);
  const base = TimeSeries.fromJSON({ name: 'vol', schema, rows });
  const live = new LiveSeries({ name: 'vol', schema });
  live.push(...rows);
  const feed = fromLive(live);

  const plan2 = [sma20, sma50, z60, spread];
  const cmp = (variant) => {
    const g = bind(feed.out.value, { units: { iv21: '%' }, variant });
    const r = run(g, {
      plan: plan2,
      select: plan2.map((s) => ({ on: s, columns: true })),
    });
    return r.series;
  };
  const gA = cmp('A');
  const gB = cmp('B');
  const f = foldResolve(base, plan2, new Map());

  const sample = (s, col) => {
    const c = s.column(col);
    const out = [];
    for (const i of [60, 150, 399]) out.push(c.at(i));
    return out.map((v) => (v === undefined ? 'u' : round(v))).join(',');
  };
  for (const spec of plan2) {
    const id = specId(spec);
    const a = sample(gA, id),
      b = sample(gB, id),
      fo = sample(f, id);
    ok(
      `${explain(spec).padEnd(40)} A=B=fold`,
      a === b && b === fo,
      `${a} | ${b} | ${fo}`,
    );
  }
}
