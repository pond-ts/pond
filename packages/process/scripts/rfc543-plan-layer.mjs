/**
 * THROWAWAY INVESTIGATION — not package API, not published.
 *
 * A prototype plan/registry layer built on top of @pond-ts/process, to
 * test whether the engine in this package can carry the design in
 * RFC #543 (`docs/rfcs/process.md`): plans that arrive as data, a
 * registry that is the schema, content-addressed identity, units as a
 * resolution input, and one request that serves both a renderer and an
 * LLM tool caller.
 *
 * Everything below the engine imports is a sketch. It exists so the
 * findings in the RFC discussion are reproducible rather than asserted.
 * Sections 5 and 6 are the load-bearing ones: they demonstrate two
 * defects in the RFC's proposed cache (A.7).
 *
 * Run from `packages/process/` after `npm run build --workspaces`:
 *     node scripts/rfc543-plan-layer.mjs
 */
import { LiveSeries } from '../../core/dist/index.js';
import {
  sma,
  ema,
  bollinger,
  zScore,
  percentChange,
} from '../../financial/dist/index.js';
import { derive, fromLive } from '../dist/index.js';

// ═══ param helpers (the registry's vocabulary) ═══════════════
const int = (o) => ({ kind: 'integer', ...o });
const num = (o) => ({ kind: 'number', ...o });

// ═══ registry ════════════════════════════════════════════════
class Registry {
  #ops = new Map();
  define(op) {
    this.#ops.set(op.name, op);
    return this;
  }
  get(name) {
    return this.#ops.get(name);
  }
  has(name) {
    return this.#ops.has(name);
  }
  byFamily() {
    const out = new Map();
    for (const op of this.#ops.values()) {
      if (!out.has(op.family)) out.set(op.family, []);
      out
        .get(op.family)
        .push({
          name: op.name,
          summary: op.summary,
          outputs: op.outputs.length,
        });
    }
    return out;
  }
  describe() {
    return [...this.#ops.values()].map((op) => ({
      name: op.name,
      family: op.family,
      summary: op.summary,
      params: Object.fromEntries(
        Object.entries(op.params).map(([k, d]) => [
          k,
          {
            type: d.kind,
            default: d.default,
            ...(d.min !== undefined && { minimum: d.min }),
            ...(d.max !== undefined && { maximum: d.max }),
          },
        ]),
      ),
      inputs: op.inputs,
      outputs: op.outputs.map((o) => ({ suffix: o.id, unit: o.unit })),
    }));
  }
  /** One declaration, emitted as the tool contract. No parallel schema. */
  toJsonSchema() {
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Plan',
      type: 'array',
      items: {
        oneOf: [...this.#ops.values()].map((op) => ({
          title: op.name,
          type: 'object',
          required: ['op', 'inputs'],
          properties: {
            op: { const: op.name },
            inputs: {
              type: 'array',
              minItems: op.inputs.length,
              maxItems: op.inputs.length,
              items: { oneOf: [{ type: 'string' }, { $ref: '#/items' }] },
            },
            params: {
              type: 'object',
              additionalProperties: false,
              properties: Object.fromEntries(
                Object.entries(op.params).map(([k, d]) => [
                  k,
                  {
                    type: d.kind,
                    default: d.default,
                    ...(d.min !== undefined && { minimum: d.min }),
                    ...(d.max !== undefined && { maximum: d.max }),
                  },
                ]),
              ),
            },
          },
        })),
      },
    };
  }
}

const registry = new Registry()
  .define({
    name: 'sma',
    family: 'trend',
    summary: 'Simple moving average over a bar-count window.',
    params: { period: int({ min: 2, default: 20, label: 'Period (bars)' }) },
    inputs: [{ role: 'source', kind: 'number' }],
    outputs: [{ id: '', unit: 'inherit' }],
    label: (p, i) => `SMA(${p.period}) of ${i}`,
    run: ({ series, input, params, id }) =>
      sma(series, { column: input, period: params.period, output: id }),
  })
  .define({
    name: 'ema',
    family: 'trend',
    summary: 'Exponential moving average.',
    params: { period: int({ min: 2, default: 20 }) },
    inputs: [{ role: 'source', kind: 'number' }],
    outputs: [{ id: '', unit: 'inherit' }],
    label: (p, i) => `EMA(${p.period}) of ${i}`,
    run: ({ series, input, params, id }) =>
      ema(series, { column: input, period: params.period, output: id }),
  })
  .define({
    name: 'bollinger',
    family: 'bands',
    summary: 'Moving average with ±stdDev bands.',
    params: {
      period: int({ min: 2, default: 20 }),
      stdDev: num({ min: 0.1, max: 5, default: 2 }),
    },
    inputs: [{ role: 'source', kind: 'number' }],
    outputs: [
      { id: 'Upper', unit: 'inherit' },
      { id: 'Middle', unit: 'inherit' },
      { id: 'Lower', unit: 'inherit' },
    ],
    label: (p, i) => `Bollinger(${p.period}, ${p.stdDev}σ) of ${i}`,
    run: ({ series, input, params, id }) =>
      bollinger(series, {
        column: input,
        period: params.period,
        stdDev: params.stdDev,
        prefix: id,
      }),
  })
  .define({
    name: 'zScore',
    family: 'normalisation',
    summary: 'Standard deviations from the rolling mean.',
    params: { period: int({ min: 2, default: 20 }) },
    inputs: [{ role: 'source', kind: 'number' }],
    outputs: [{ id: '', unit: 'sigma' }], // ← NOT inherit. Wall 3.
    label: (p, i) => `z-score(${p.period}) of ${i}`,
    run: ({ series, input, params, id }) =>
      zScore(series, { column: input, period: params.period, output: id }),
  })
  .define({
    name: 'percentChange',
    family: 'normalisation',
    summary: 'Percent change over N bars.',
    params: { periods: int({ min: 1, default: 1 }) },
    inputs: [{ role: 'source', kind: 'number' }],
    outputs: [{ id: '', unit: '%' }], // ← NOT inherit. Wall 3.
    label: (p, i) => `% change(${p.periods}) of ${i}`,
    run: ({ series, input, params, id }) =>
      percentChange(series, {
        column: input,
        periods: params.periods,
        output: id,
      }),
  })
  // A consumer-local op: registered, not forked. Demands a variance input.
  .define({
    name: 'annualisedVol',
    family: 'volatility',
    summary: 'Annualise a variance column.',
    params: { periodsPerYear: int({ min: 1, default: 252 }) },
    inputs: [{ role: 'source', kind: 'number', unit: 'variance' }], // ← typed input
    outputs: [{ id: '', unit: '%' }],
    label: (p, i) => `annualised vol(${p.periodsPerYear}) of ${i}`,
    // Reads the column, builds a column — no per-event walk.
    run: ({ series, input, params, id }) => {
      const src = series.column(input);
      const out = new Array(src.length);
      for (let i = 0; i < src.length; i += 1) {
        const v = src.at(i);
        out[i] =
          v === undefined || v === null || Number.isNaN(v)
            ? undefined
            : Math.sqrt(v * params.periodsPerYear) * 100;
      }
      return series.withColumn(id, out);
    },
  });

// ═══ identity, units, explain ════════════════════════════════
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
/** Unit of a spec's output N — declared, or folded from its input. */
function unitOf(spec, units, outputIndex = 0) {
  const decl = registry.get(spec.op).outputs[outputIndex].unit;
  if (decl !== 'inherit') return decl;
  const src = spec.inputs[0];
  return typeof src === 'string' ? (units[src] ?? null) : unitOf(src, units);
}

// ═══ reductions ══════════════════════════════════════════════
const round = (v) => Math.round(v * 100) / 100;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const defined = (v) => v !== undefined && v !== null && !Number.isNaN(v);
const reductions = {
  last: (col, keys) => {
    for (let i = col.length - 1; i >= 0; i -= 1)
      if (defined(col.at(i)))
        return { value: round(col.at(i)), at: day(keys[i]) };
    return { value: null };
  },
  extremes: (col, keys) => {
    let lo = Infinity,
      hi = -Infinity,
      loAt,
      hiAt;
    for (let i = 0; i < col.length; i += 1) {
      const v = col.at(i);
      if (!defined(v)) continue;
      if (v < lo) {
        lo = v;
        loAt = keys[i];
      }
      if (v > hi) {
        hi = v;
        hiAt = keys[i];
      }
    }
    return {
      min: { value: round(lo), at: day(loAt) },
      max: { value: round(hi), at: day(hiAt) },
    };
  },
  percentileRank: (col) => {
    const vals = [];
    let last;
    for (let i = 0; i < col.length; i += 1)
      if (defined(col.at(i))) {
        vals.push(col.at(i));
        last = col.at(i);
      }
    const below = vals.filter((v) => v < last).length;
    return {
      value: round((below / vals.length) * 100) / 100,
      note: `${Math.round((below / vals.length) * 100)}th percentile of ${vals.length} observations`,
    };
  },
  crossings: (col, keys, sel, ctx) => {
    const other = ctx.series.column(sel.against);
    const events = [];
    let prev;
    for (let i = 0; i < col.length; i += 1) {
      const a = col.at(i),
        b = other.at(i);
      if (!defined(a) || !defined(b)) continue;
      const side = a > b ? 'above' : 'below';
      if (prev && side !== prev)
        events.push({ at: day(keys[i]), direction: side });
      prev = side;
    }
    return { events };
  },
  shape: (col, keys, sel) => {
    const step = Math.max(1, Math.floor(col.length / (sel.points ?? 40)));
    const out = [];
    for (let i = 0; i < col.length; i += step)
      if (defined(col.at(i))) out.push([day(keys[i]), round(col.at(i))]);
    return { series: out };
  },
};

// ═══ ONE entry point ═════════════════════════════════════════
function run(seriesOutlet, request, cache) {
  const { plan = [], select = [], units = {}, onError = 'throw' } = request;
  const skipped = [],
    computed = [],
    built = new Map();

  const build = (spec) => {
    const id = specId(spec);
    if (built.has(id)) return built.get(id);
    const op = registry.get(spec.op);
    if (!op) throw new Error(`unknown op '${spec.op}'`);
    const params = withDefaults(spec);
    for (const [k, d] of Object.entries(op.params)) {
      const v = params[k];
      if (d.kind === 'integer' && !Number.isInteger(v))
        throw new Error(`${spec.op}.${k} must be an integer, got ${v}`);
      if (d.min !== undefined && v < d.min)
        throw new Error(`${spec.op}.${k}=${v} is below minimum ${d.min}`);
      if (d.max !== undefined && v > d.max)
        throw new Error(`${spec.op}.${k}=${v} is above maximum ${d.max}`);
    }
    // Typed input: an op may demand a unit its source must already carry.
    const want = op.inputs[0].unit;
    if (want) {
      const got =
        typeof spec.inputs[0] === 'string'
          ? units[spec.inputs[0]]
          : unitOf(spec.inputs[0], units);
      if (got !== want)
        throw new Error(
          `${spec.op} needs a '${want}' input, but '${typeof spec.inputs[0] === 'string' ? spec.inputs[0] : specId(spec.inputs[0])}' is '${got ?? 'unitless'}'`,
        );
    }
    if (cache.has(id)) {
      built.set(id, cache.get(id));
      return cache.get(id);
    }

    const src = spec.inputs[0];
    const upstream =
      typeof src === 'string' ? seriesOutlet : build(src).out.value;
    const inputColumn = typeof src === 'string' ? src : specId(src);
    const node = derive(
      { series: upstream },
      ({ series }) => op.run({ series, input: inputColumn, params, id }),
      { kind: spec.op },
    );
    built.set(id, node);
    cache.set(id, node);
    computed.push(id);
    return node;
  };

  const ok = [];
  for (const spec of plan) {
    try {
      build(spec);
      ok.push(spec);
    } catch (e) {
      if (onError === 'throw') throw e;
      skipped.push({
        spec: { op: spec.op, params: withDefaults(spec) },
        reason: e.message,
      });
    }
  }

  const response = {
    asOf: new Date(Date.UTC(2026, 6, 26)).toISOString(),
    explain: Object.fromEntries(ok.map((s) => [specId(s), explain(s)])),
    facts: [],
    computed,
    skipped,
  };

  for (const sel of select) {
    const node = built.get(specId(sel.on));
    if (!node) continue;
    const series = node.out.value.get();
    if (sel.columns) {
      response.series = series;
      (response.outputs ??= {})[specId(sel.on)] = registry
        .get(sel.on.op)
        .outputs.map((o, n) => ({
          column: specId(sel.on) + o.id,
          unit: unitOf(sel.on, units, n),
        }));
      continue;
    }
    const idx = registry
      .get(sel.on.op)
      .outputs.findIndex((o) => o.id === (sel.output ?? ''));
    const column = specId(sel.on) + (sel.output ?? '');
    const keys = series
      .toRows()
      .map((r) => (r[0] instanceof Date ? r[0].getTime() : r[0]));
    response.facts.push({
      id: column,
      reduce: sel.reduce,
      ...(sel.against && { against: sel.against }),
      unit: unitOf(sel.on, units, Math.max(0, idx)),
      ...reductions[sel.reduce](series.column(column), keys, sel, { series }),
    });
  }
  return response;
}

// ═══ demo ════════════════════════════════════════════════════
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'iv21', kind: 'number' },
  { name: 'ccVar', kind: 'number' },
];
const live = new LiveSeries({ name: 'vol', schema });
for (let i = 0; i < 400; i += 1) {
  const iv = 20 + Math.sin(i / 20) * 6;
  live.push([Date.UTC(2025, 0, 1) + i * 86_400_000, iv, (iv / 100) ** 2 / 252]);
}
const feed = fromLive(live);
const cache = new Map();
const units = { iv21: '%', ccVar: 'variance' };

console.log('\n══════ 1. DISCOVERY — what an agent reads first ══════');
console.log('families:');
for (const [family, ops] of registry.byFamily())
  console.log(
    `  ${family.padEnd(15)} ${ops.map((o) => o.name + (o.outputs > 1 ? `(${o.outputs} outputs)` : '')).join(', ')}`,
  );
console.log('\none op, fully described:');
console.log(
  JSON.stringify(
    registry.describe().find((o) => o.name === 'bollinger'),
    null,
    2,
  ),
);
console.log('\nplan schema the tool advertises (truncated):');
console.log(JSON.stringify(registry.toJsonSchema().items.oneOf[3], null, 2));

const smaSpec = { op: 'sma', params: { period: 20 }, inputs: ['iv21'] };
const bbSpec = {
  op: 'bollinger',
  params: { period: 20, stdDev: 2 },
  inputs: ['iv21'],
};
const zSpec = { op: 'zScore', params: { period: 60 }, inputs: ['iv21'] };
const volSpec = { op: 'annualisedVol', params: {}, inputs: ['ccVar'] };
const emaOfSma = { op: 'ema', params: { period: 10 }, inputs: [smaSpec] };
const badUnit = { op: 'annualisedVol', params: {}, inputs: ['iv21'] }; // % is not variance
const badParam = {
  op: 'bollinger',
  params: { period: 20, stdDev: 9 },
  inputs: ['iv21'],
};

const plan = [bbSpec, emaOfSma, smaSpec, zSpec, volSpec, badUnit, badParam];

console.log('\n══════ 2. UNIT PROPAGATION ══════');
for (const s of [smaSpec, emaOfSma, bbSpec, zSpec, volSpec])
  console.log(`  ${String(unitOf(s, units)).padEnd(9)} ${explain(s)}`);

console.log('\n══════ 3. FULL RESPONSE — agent asks for facts ══════');
const agent = run(
  feed.out.value,
  {
    plan,
    units,
    onError: 'collect',
    select: [
      { on: smaSpec, reduce: 'last' },
      { on: zSpec, reduce: 'last' },
      { on: volSpec, reduce: 'last' },
      { on: bbSpec, output: 'Upper', reduce: 'extremes' },
      { on: smaSpec, reduce: 'percentileRank' },
      { on: emaOfSma, reduce: 'shape', points: 5 },
    ],
  },
  cache,
);
console.log(JSON.stringify(agent, null, 2));

console.log('\n══════ 4. SAME PLAN, Tidal asks for columns ══════');
const tidal = run(
  feed.out.value,
  {
    plan,
    units,
    onError: 'skip',
    select: [
      { on: bbSpec, columns: true },
      { on: zSpec, reduce: 'last' },
    ],
  },
  cache,
);
console.log(
  'series      :',
  tidal.series.constructor.name,
  `${tidal.series.length} rows`,
);
console.log('outputs     :', JSON.stringify(tidal.outputs));
console.log('legend fact :', JSON.stringify(tidal.facts[0]));
console.log(
  'newly computed this call:',
  tidal.computed.length,
  '(cache hits on the rest)',
);
console.log(
  'json-safe   :',
  tidal.series === undefined ? 'yes' : 'no — carries columns, by design',
);
console.log('cache size  :', cache.size);

console.log('\n══════ 5. CACHE KEY vs SOURCE IDENTITY ══════');
// A second, different underlying — same plan, same specIds.
const live2 = new LiveSeries({ name: 'vol2', schema });
for (let i = 0; i < 400; i += 1) {
  const iv = 60 + Math.sin(i / 20) * 6; // clearly different level
  live2.push([
    Date.UTC(2025, 0, 1) + i * 86_400_000,
    iv,
    (iv / 100) ** 2 / 252,
  ]);
}
const feed2 = fromLive(live2);
const other = run(
  feed2.out.value,
  {
    plan: [smaSpec],
    units,
    select: [{ on: smaSpec, reduce: 'last' }],
  },
  cache,
); // ← same host cache, per RFC A.7
console.log('series A last SMA(20):', agent.facts[0].value);
console.log(
  'series B last SMA(20):',
  other.facts[0].value,
  '  <- should be ~60, not ~23',
);
console.log('specId is identical  :', specId(smaSpec));

console.log('\n══════ 6. LIVE DATA vs A VALUE CACHE ══════');
for (let i = 400; i < 420; i += 1) {
  const iv = 45 + Math.sin(i / 20) * 6;
  live.push([Date.UTC(2025, 0, 1) + i * 86_400_000, iv, (iv / 100) ** 2 / 252]);
}
const after = run(
  feed.out.value,
  {
    plan: [smaSpec],
    units,
    select: [{ on: smaSpec, reduce: 'last' }],
  },
  cache,
);
console.log(
  'after 20 new events  :',
  after.facts[0].value,
  `(was ${agent.facts[0].value})`,
);
console.log(
  'newly computed       :',
  after.computed.length,
  '- node was cached but not stale-blind',
);
