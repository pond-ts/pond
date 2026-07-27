/**
 * RFC #543 — multi-source. Is "one graph per binding" enough?
 *
 * A.7 binds one graph per data source, which is right for independent
 * plans. The question is what happens to a spec whose inputs come from
 * TWO sources — a spread, a ratio, a beta against a benchmark. That is
 * ordinary finance, not a corner.
 *
 * Three things get tested here:
 *   1. Can separate graphs express a cross-source spec at all?
 *   2. If one graph holds several sources, does identity still work, and
 *      does invalidation finally beat a generation counter?
 *   3. What actually bites — which turns out to be alignment, not wiring.
 *
 * Throwaway. Not package API, not published.
 *     node scripts/rfc543-multisource.mjs
 */
import { TimeSeries } from '../../core/dist/index.js';
import { sma } from '../../financial/dist/index.js';
import { derive, source as makeSource, Graph } from '../dist/index.js';

const ok = (n, c, x = '') =>
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`);
const day = (t) => new Date(t).toISOString().slice(0, 10);
const r2 = (v) => (v === undefined ? undefined : Math.round(v * 100) / 100);

function keysOf(series) {
  const kc = series.keyColumn();
  const out = new Array(kc.length);
  for (let i = 0; i < kc.length; i += 1) out[i] = kc.at(i);
  return out;
}

function valuesOf(col) {
  const out = new Array(col.length).fill(undefined);
  col.scan(
    (v, i) => {
      out[i] = Number.isNaN(v) ? undefined : v;
    },
    { skipInvalid: true },
  );
  return out;
}

// ═══ two instruments that DO NOT share a time base ══════════
// AAPL trades every day in the window; MSFT is missing two sessions.
// This is the normal case — halts, holidays, differing venues.
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
];
const T0 = Date.UTC(2026, 0, 5);
const DAY = 86_400_000;

const aaplRows = [];
for (let i = 0; i < 12; i += 1) aaplRows.push([T0 + i * DAY, 100 + i]);
const msftRows = [];
for (let i = 0; i < 12; i += 1) {
  if (i === 3 || i === 7) continue; // two missing sessions
  msftRows.push([T0 + i * DAY, 200 + i * 2]);
}
const aapl = TimeSeries.fromJSON({ name: 'AAPL', schema, rows: aaplRows });
const msft = TimeSeries.fromJSON({ name: 'MSFT', schema, rows: msftRows });

console.log(
  `AAPL ${aapl.length} rows, MSFT ${msft.length} rows (2 sessions missing)\n`,
);

// ═══ 1. SEPARATE GRAPHS — where it stops ════════════════════
console.log('═══ 1. separate graphs, one per binding (A.7 as written) ═══');
{
  const srcA = makeSource({ initial: aapl, kind: 'AAPL' });
  const srcM = makeSource({ initial: msft, kind: 'MSFT' });
  const smaA = derive(
    { s: srcA.out.value },
    ({ s }) => sma(s, { column: 'close', period: 3, output: 'sma3' }),
    { kind: 'sma' },
  );
  const smaM = derive(
    { s: srcM.out.value },
    ({ s }) => sma(s, { column: 'close', period: 3, output: 'sma3' }),
    { kind: 'sma' },
  );

  ok(
    'each graph resolves its own studies',
    smaA.out.value.get().length === 12 && smaM.out.value.get().length === 10,
  );

  // Now: ratio of the two smoothings. Neither graph can hold this spec —
  // its inputs live in different graphs, so the plan layer has nowhere to
  // put it and the consumer combines by hand, outside the framework.
  const a = valuesOf(smaA.out.value.get().column('sma3'));
  const m = valuesOf(smaM.out.value.get().column('sma3'));
  const naive = a.map((x, i) =>
    x === undefined || m[i] === undefined ? undefined : x / m[i],
  );
  console.log(
    `  hand-combined ratio (index-wise): ${naive.slice(3, 7).map(r2).join(', ')}`,
  );
  ok(
    'index-wise combination is WRONG across misaligned sources',
    true,
    'row i of AAPL and row i of MSFT are different dates after the first gap',
  );
  console.log(
    `    AAPL[5] is ${day(aaplRows[5][0])}, MSFT[5] is ${day(msftRows[5][0])}`,
  );
  console.log(
    '  -> the combination has no specId, no cache, no explain, no units.',
  );
  console.log(
    '     That is exactly the consumer-side glue the RFC exists to delete.',
  );
}

// ═══ 2. ONE GRAPH, SEVERAL SOURCES ══════════════════════════
console.log('\n═══ 2. one graph, several sources, qualified refs ═══');
{
  // Column refs become `source:column`, so specId stays content-addressed
  // and a cross-source spec gets a real identity.
  const sources = {
    AAPL: makeSource({ initial: aapl, kind: 'AAPL' }),
    MSFT: makeSource({ initial: msft, kind: 'MSFT' }),
  };
  const nodes = new Map();
  let computes = { AAPL: 0, MSFT: 0, ratio: 0 };

  const smaNode = (sym, period) => {
    const id = `p1:sma(${sym}:close;period=${period})`;
    if (nodes.has(id)) return nodes.get(id);
    const n = derive(
      { s: sources[sym].out.value },
      ({ s }) => {
        computes[sym] += 1;
        return valuesOf(
          sma(s, { column: 'close', period, output: 'o' }).column('o'),
        );
      },
      { kind: `sma:${sym}` },
    );
    nodes.set(id, n);
    return n;
  };

  // The cross-source op. ALIGNMENT is the whole problem: the two legs
  // have different keys, so they must be put on a common base before any
  // arithmetic. pond has the primitive; the plan layer has to choose the
  // policy and record it in the id.
  const ratioNode = (symA, symB, period, how) => {
    const id = `p1:ratio(${symA}:close+${symB}:close;how=${how},period=${period})`;
    if (nodes.has(id)) return nodes.get(id);
    const n = derive(
      {
        a: smaNode(symA, period).out.value,
        b: smaNode(symB, period).out.value,
        sa: sources[symA].out.value,
        sb: sources[symB].out.value,
      },
      ({ a, b, sa, sb }) => {
        computes.ratio += 1;
        // Put both legs on AAPL's key base, joining by timestamp.
        // `keyColumn()` yields raw numbers; `toRows()` boxes each key as a
        // `Time` object, so map lookups against it silently never match —
        // the columnar accessor is both correct and the intended path.
        const keyA = keysOf(sa);
        const keyB = keysOf(sb);
        const byTime = new Map();
        for (let i = 0; i < keyB.length; i += 1) byTime.set(keyB[i], b[i]);
        let carried;
        return keyA.map((t, i) => {
          const raw = byTime.get(t);
          const bv =
            how === 'asof'
              ? raw !== undefined
                ? (carried = raw)
                : carried
              : raw;
          return a[i] === undefined || bv === undefined ? undefined : a[i] / bv;
        });
      },
      { kind: 'ratio' },
    );
    nodes.set(id, n);
    return n;
  };

  const inner = ratioNode('AAPL', 'MSFT', 3, 'inner');
  const asof = ratioNode('AAPL', 'MSFT', 3, 'asof');
  const vi = inner.out.value.get();
  const va = asof.out.value.get();

  ok(
    'cross-source spec has an identity',
    [...nodes.keys()].some((k) => k.startsWith('p1:ratio')),
    [...nodes.keys()].find((k) => k.startsWith('p1:ratio')),
  );
  ok(
    'one graph spans both sources',
    Graph.from(inner).nodes.length === 6,
    `${Graph.from(inner).nodes.length} nodes discovered`,
  );
  console.log(`  inner join: ${vi.map(r2).slice(2, 9).join(', ')}`);
  console.log(`  as-of     : ${va.map(r2).slice(2, 9).join(', ')}`);
  ok(
    'join policy changes the numbers, so it belongs in the id',
    JSON.stringify(vi) !== JSON.stringify(va),
    `${vi.filter((x) => x === undefined).length} vs ${va.filter((x) => x === undefined).length} undefined`,
  );

  // ── the invalidation property, which is the whole reason to co-locate
  const before = { ...computes };
  sources.MSFT.set(
    TimeSeries.fromJSON({
      name: 'MSFT',
      schema,
      rows: [...msftRows, [T0 + 12 * DAY, 226]],
    }),
  );
  inner.out.value.get();
  asof.out.value.get();
  const afterM = {
    AAPL: computes.AAPL - before.AAPL,
    MSFT: computes.MSFT - before.MSFT,
    ratio: computes.ratio - before.ratio,
  };
  console.log(
    `  after an MSFT tick: recomputed AAPL=${afterM.AAPL} MSFT=${afterM.MSFT} ratio=${afterM.ratio}`,
  );
  ok(
    "a tick in one source leaves the other source's node warm",
    afterM.AAPL === 0,
    'a generation counter would have cleared both',
  );

  const before2 = { ...computes };
  sources.AAPL.set(
    TimeSeries.fromJSON({
      name: 'AAPL',
      schema,
      rows: [...aaplRows, [T0 + 12 * DAY, 112]],
    }),
  );
  inner.out.value.get();
  const afterA = {
    AAPL: computes.AAPL - before2.AAPL,
    MSFT: computes.MSFT - before2.MSFT,
  };
  console.log(
    `  after an AAPL tick: recomputed AAPL=${afterA.AAPL} MSFT=${afterA.MSFT}`,
  );
  ok('and symmetrically', afterA.MSFT === 0);
}

// ═══ 3. how many sources before it pays? ════════════════════
console.log('\n═══ 3. scaling — one tick, N independent sources ═══');
{
  for (const N of [2, 5, 20]) {
    const srcs = [],
      leaves = [];
    for (let i = 0; i < N; i += 1) {
      const s = makeSource({ initial: aapl, kind: `S${i}` });
      srcs.push(s);
      leaves.push(
        derive(
          { s: s.out.value },
          ({ s }) =>
            valuesOf(
              sma(s, { column: 'close', period: 3, output: 'o' }).column('o'),
            ),
          { kind: 'sma' },
        ),
      );
    }
    for (const l of leaves) l.out.value.get();
    srcs[0].set(
      TimeSeries.fromJSON({
        name: 'AAPL',
        schema,
        rows: [...aaplRows, [T0 + 12 * DAY, 112]],
      }),
    );
    const dirty = leaves.filter((l) => l.dirty).length;
    console.log(
      `  ${String(N).padStart(2)} sources, 1 tick -> ${dirty}/${N} studies dirty` +
        `   (generation counter: ${N}/${N})`,
    );
  }
  console.log(
    "  -> the graph's invalidation advantage is exactly 1/N of the work,",
  );
  console.log(
    '     and it is zero at N=1 — which is why step 0 measured no benefit.',
  );
}
