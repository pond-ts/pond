/**
 * RFC #543 — params as Ins, and selective Out invalidation.
 *
 * Reviewer correction to [PND-PROCEVICT]: the +457 MB measured under a
 * parameter sweep is not inherent to the graph. It came from the PLAN
 * layer keeping a global `specId -> node` map, where every slider
 * position is a new id and nothing is ever dropped. In the node-graph
 * systems this design descends from:
 *
 *   1. Outs ARE the cache stores — caching is localized to a node's
 *      products, so there is no global map to leak. (The engine in this
 *      package already works this way: `Outlet` holds its own `#value` /
 *      `#version` and `produce()` bumps only on change.)
 *   2. A param is an In. Changing it invalidates the node's Outs; it does
 *      not mint a new node. Node count tracks the plan's shape, not the
 *      history of values the user has passed through.
 *   3. The node decides invalidation SELECTIVELY — a change may touch one
 *      Out and not another.
 *
 * (2) and (3) are tested here against the real engine.
 *
 * Run one mode per process; comparing heaps inside one process gives
 * GC-dominated, sometimes negative deltas.
 *
 *     node --expose-gc scripts/rfc543-param-ins.mjs addressed 200
 *     node --expose-gc scripts/rfc543-param-ins.mjs paramin   200
 *     node scripts/rfc543-param-ins.mjs selective
 */
import { TimeSeries } from '../../core/dist/index.js';
import { defineNode, derive, port, source } from '../dist/index.js';

const mode = process.argv[2] ?? 'selective';
const SWEEP = Number(process.argv[3] ?? 200);
const N = 200_000;

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'px', kind: 'number' },
];
const rows = new Array(N);
for (let i = 0; i < N; i += 1)
  rows[i] = [Date.UTC(2020, 0, 1) + i * 300_000, 100 + Math.sin(i / 900) * 12];
const base = TimeSeries.fromJSON({ name: 'px', schema, rows });
const pxValues = (() => {
  const c = base.column('px');
  const out = new Float64Array(c.length);
  c.scan((v, i) => {
    out[i] = v;
  });
  return out;
})();

/** Rolling mean over a Float64Array, NaN for the warm-up. */
function smaInto(src, period, out) {
  let sum = 0;
  for (let i = 0; i < src.length; i += 1) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    out[i] = i >= period - 1 ? sum / period : NaN;
  }
  return out;
}

// Float64Array backing stores are NOT in heapUsed — they land in
// `external` / `arrayBuffers`. Measuring heapUsed alone reported 21 MB
// for both modes and hid a 300 MB difference.
const mem = () => {
  global.gc?.();
  const m = process.memoryUsage();
  return {
    heap: m.heapUsed / 1048576,
    buffers: m.arrayBuffers / 1048576,
    rss: m.rss / 1048576,
  };
};
const fmt = (m) =>
  `heap ${m.heap.toFixed(0).padStart(4)} MB  buffers ${m.buffers.toFixed(0).padStart(5)} MB  rss ${m.rss.toFixed(0).padStart(5)} MB`;

// ═══════════════════════════════════════════════════════════════
// MODE 1 — content-addressed: each slider position is a new spec, so a
// new node, and the plan layer's map keeps every one of them.
// ═══════════════════════════════════════════════════════════════
if (mode === 'addressed') {
  const src = source({ initial: base });
  const nodes = new Map(); // the leak: a global specId -> node map
  for (let p = 20; p < 20 + SWEEP; p += 1) {
    const id = `p1:sma(px;period=${p})`;
    const n = derive(
      { s: src.out.value },
      () => smaInto(pxValues, p, new Float64Array(N)),
      { kind: 'sma' },
    );
    nodes.set(id, n);
    n.out.value.get();
  }
  console.log(`addressed  sweep=${SWEEP}  nodes=${nodes.size}  ${fmt(mem())}`);
}

// ═══════════════════════════════════════════════════════════════
// MODE 2 — param as an In: ONE node. The period arrives through an
// inlet, so a sweep overwrites the Out's cache instead of minting nodes.
// ═══════════════════════════════════════════════════════════════
if (mode === 'paramin') {
  const src = source({ initial: base });
  const period = source({ initial: 20 }); // <- the param, as an In
  const smaNode = derive(
    { s: src.out.value, period: period.out.value },
    ({ period: p }) => smaInto(pxValues, p, new Float64Array(N)),
    { kind: 'sma' },
  );
  for (let p = 20; p < 20 + SWEEP; p += 1) {
    period.set(p);
    smaNode.out.value.get();
  }
  console.log(`paramin    sweep=${SWEEP}  nodes=1  ${fmt(mem())}`);
}

// ═══════════════════════════════════════════════════════════════
// MODE 3 — selective Out invalidation.
//
// A bollinger-shaped node: Middle is the SMA, Upper/Lower are Middle
// +/- stdDev * sigma. A change to `stdDev` moves Upper and Lower and
// leaves Middle ALONE. If the op returns the SAME array instance for
// Middle, `produce()`'s Object.is check declines to bump its version and
// everything downstream of Middle skips — the node deciding, per-Out,
// what a change touched.
// ═══════════════════════════════════════════════════════════════
if (mode === 'selective') {
  const ran = { band: 0, offMiddle: 0, offUpper: 0 };

  let cachedMiddle = null;
  let cachedForPeriod = null;
  let cachedSigma = null;

  const Band = defineNode({
    kind: 'bollinger',
    inputs: { period: port(), stdDev: port() },
    outputs: {
      middle: port(),
      upper: port(),
      lower: port(),
    },
    compute: ({ period, stdDev }) => {
      ran.band += 1;
      // Middle and sigma depend only on `period`. Recompute them only
      // when `period` actually moved, and hand back the SAME array
      // otherwise so the outlet can see it is unchanged.
      if (cachedForPeriod !== period) {
        cachedMiddle = smaInto(pxValues, period, new Float64Array(N));
        const sig = new Float64Array(N);
        for (let i = 0; i < N; i += 1) {
          if (i < period - 1) {
            sig[i] = NaN;
            continue;
          }
          let acc = 0;
          for (let k = i - period + 1; k <= i; k += 1) {
            const d = pxValues[k] - cachedMiddle[i];
            acc += d * d;
          }
          sig[i] = Math.sqrt(acc / period);
        }
        cachedSigma = sig;
        cachedForPeriod = period;
      }
      const upper = new Float64Array(N);
      const lower = new Float64Array(N);
      for (let i = 0; i < N; i += 1) {
        upper[i] = cachedMiddle[i] + stdDev * cachedSigma[i];
        lower[i] = cachedMiddle[i] - stdDev * cachedSigma[i];
      }
      return { middle: cachedMiddle, upper, lower };
    },
  });

  const period = source({ initial: 20 });
  const stdDev = source({ initial: 2 });
  const band = Band();
  period.out.value.connect(band.in.period);
  stdDev.out.value.connect(band.in.stdDev);

  // Two consumers, one per Out — these stand in for chart layers.
  const offMiddle = derive({ m: band.out.middle }, ({ m }) => {
    ran.offMiddle += 1;
    return m.length;
  });
  const offUpper = derive({ u: band.out.upper }, ({ u }) => {
    ran.offUpper += 1;
    return u.length;
  });

  offMiddle.out.value.get();
  offUpper.out.value.get();
  const v0 = {
    m: band.out.middle.version,
    u: band.out.upper.version,
  };
  console.log(
    `  initial: band=${ran.band} middleConsumer=${ran.offMiddle} upperConsumer=${ran.offUpper}`,
  );

  // ── change stdDev only ──────────────────────────────────────
  stdDev.set(2.5);
  offMiddle.out.value.get();
  offUpper.out.value.get();
  console.log(
    `  after stdDev 2 -> 2.5: band recomputed=${ran.band}, ` +
      `middle version ${v0.m} -> ${band.out.middle.version}, ` +
      `upper version ${v0.u} -> ${band.out.upper.version}`,
  );
  console.log(
    `    middleConsumer ran=${ran.offMiddle} (want 1 — stdDev does not move Middle)`,
  );
  console.log(`    upperConsumer  ran=${ran.offUpper} (want 2)`);
  const selectiveWorks =
    ran.offMiddle === 1 &&
    ran.offUpper === 2 &&
    band.out.middle.version === v0.m &&
    band.out.upper.version > v0.u;
  console.log(
    `  SELECTIVE OUT INVALIDATION: ${selectiveWorks ? 'WORKS' : 'DOES NOT WORK'}`,
  );

  // ── change period: both must move ───────────────────────────
  const before = { m: ran.offMiddle, u: ran.offUpper };
  period.set(30);
  offMiddle.out.value.get();
  offUpper.out.value.get();
  console.log(
    `  after period 20 -> 30: middleConsumer +${ran.offMiddle - before.m}, ` +
      `upperConsumer +${ran.offUpper - before.u} (both want +1)`,
  );
}
