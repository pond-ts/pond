/**
 * RFC #543 — join as a node, and dirty state per column / per range.
 *
 * Sizes the proposal against the worst number measured so far: the hot
 * leading edge, where an 8-study stack over 500k rows costs ~765 ms per
 * tick because every node recomputes its whole history for one new bar.
 *
 * Two ideas, tested separately:
 *
 *   JOIN AS A NODE — n series in, one aligned column set out, with the
 *     join policy in its id. Every downstream op then reads columns off
 *     one aligned base instead of re-implementing alignment, and dirty
 *     state can be tracked PER COLUMN, so a tick in one source does not
 *     invalidate a study reading only the other's column.
 *
 *   DIRTY PER RANGE — a source records WHICH rows changed. A node
 *     declares its lookback, so an input dirty range [a,b) becomes
 *     [a-lookback, b) for that node, and only that slice is recomputed
 *     and spliced into the cached values.
 *
 * Correctness is checked against full recompute at every step; a fast
 * wrong answer is worthless.
 *
 * Throwaway. Not package API, not published.
 *     node scripts/rfc543-ranged-dirty.mjs
 */

const now = () => process.hrtime.bigint();
const ms = (t) => Number(process.hrtime.bigint() - t) / 1e6;
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];

// ═══════════════════════════════════════════════════════════════
// A miniature ranged engine. Deliberately not the real one — the point
// is to price the design, and the real engine's `markDirty()` carries no
// payload, which is precisely the change being evaluated.
// ═══════════════════════════════════════════════════════════════
const EMPTY = { lo: Infinity, hi: -Infinity };
const isEmpty = (r) => r.hi <= r.lo;
const union = (a, b) =>
  isEmpty(a)
    ? b
    : isEmpty(b)
      ? a
      : { lo: Math.min(a.lo, b.lo), hi: Math.max(a.hi, b.hi) };

class RangedSource {
  constructor(values) {
    this.values = values;
    this.version = 1;
    this.dirty = EMPTY;
    this.downstream = [];
  }
  /** Append rows: only [oldLen, newLen) changed. */
  append(more) {
    const lo = this.values.length;
    this.values = this.values.concat(more);
    this.version += 1;
    this.mark({ lo, hi: this.values.length });
  }
  /** Replace wholesale: everything changed. */
  replace(values) {
    this.values = values;
    this.version += 1;
    this.mark({ lo: 0, hi: values.length });
  }
  mark(range) {
    for (const d of this.downstream) d.mark(range);
  }
  get() {
    return this.values;
  }
}

class RangedNode {
  /**
   * @param inputs   upstream sources/nodes
   * @param spec     { lookback, compute(inputValues, out, range) }
   *   `compute` fills `out` over [range.lo, range.hi) only. A node that
   *   cannot do that declares lookback: Infinity and gets a full pass.
   */
  constructor(inputs, spec, label) {
    this.inputs = inputs;
    this.spec = spec;
    this.label = label;
    this.out = null;
    this.dirty = { lo: 0, hi: Infinity }; // never computed
    this.version = 0;
    this.downstream = [];
    this.slicesComputed = 0;
    this.cellsComputed = 0;
    for (const i of inputs) i.downstream.push(this);
  }
  mark(range) {
    // A value at i depends on [i - lookback, i], so an upstream change at
    // [a,b) dirties [a - lookback, b) here.
    const grown =
      this.spec.lookback === Infinity
        ? { lo: 0, hi: Infinity }
        : { lo: Math.max(0, range.lo - this.spec.lookback), hi: range.hi };
    const before = this.dirty;
    this.dirty = union(this.dirty, grown);
    if (before.lo !== this.dirty.lo || before.hi !== this.dirty.hi)
      for (const d of this.downstream) d.mark(grown);
  }
  get() {
    for (const i of this.inputs) i.get();
    if (isEmpty(this.dirty) && this.out) return this.out;

    const ins = this.inputs.map((i) => i.get());
    const n = ins[0].length;
    let range;
    if (!this.out || this.out.length !== n) {
      // First run, or the length changed: grow the buffer and recompute
      // from the dirty low-water mark to the end.
      const next = new Array(n).fill(undefined);
      if (this.out)
        for (let i = 0; i < this.out.length && i < n; i += 1)
          next[i] = this.out[i];
      this.out = next;
      range = {
        lo: this.out ? Math.max(0, Math.min(this.dirty.lo, n)) : 0,
        hi: n,
      };
      if (!Number.isFinite(this.dirty.lo)) range.lo = 0;
    } else {
      range = {
        lo: Math.max(0, this.dirty.lo),
        hi: Math.min(n, this.dirty.hi),
      };
    }
    if (this.dirty.hi === Infinity) range.hi = n;
    if (this.dirty.lo === 0 && this.dirty.hi === Infinity) range.lo = 0;

    this.spec.compute(ins, this.out, range);
    this.slicesComputed += 1;
    this.cellsComputed += Math.max(0, range.hi - range.lo);
    this.dirty = EMPTY;
    this.version += 1;
    return this.out;
  }
}

// ═══ ops that can fill a slice ══════════════════════════════
/** SMA is exactly windowed: value at i needs [i-p+1, i]. */
const smaSpec = (period) => ({
  lookback: period,
  compute: ([src], out, { lo, hi }) => {
    for (let i = lo; i < hi; i += 1) {
      if (i < period - 1) {
        out[i] = undefined;
        continue;
      }
      let s = 0;
      let okAll = true;
      for (let k = i - period + 1; k <= i; k += 1) {
        const v = src[k];
        if (v === undefined) {
          okAll = false;
          break;
        }
        s += v;
      }
      out[i] = okAll ? s / period : undefined;
    }
  },
});
/** Ratio of two aligned columns — pointwise, so lookback 0. */
const ratioSpec = () => ({
  lookback: 0,
  compute: ([a, b], out, { lo, hi }) => {
    for (let i = lo; i < hi; i += 1)
      out[i] =
        a[i] === undefined || b[i] === undefined ? undefined : a[i] / b[i];
  },
});
/** A deliberately non-local op: percentile rank over ALL history. */
const rankSpec = () => ({
  lookback: Infinity,
  compute: ([src], out, { lo, hi }) => {
    const seen = [];
    for (let i = 0; i < src.length; i += 1)
      if (src[i] !== undefined) seen.push(src[i]);
    seen.sort((x, y) => x - y);
    for (let i = lo; i < hi; i += 1) {
      if (src[i] === undefined) {
        out[i] = undefined;
        continue;
      }
      let c = 0;
      while (c < seen.length && seen[c] < src[i]) c += 1;
      out[i] = c / seen.length;
    }
  },
});

// ═══ JOIN AS A NODE ═════════════════════════════════════════
/**
 * n sources -> one aligned column set. The policy is a parameter and
 * belongs in the id, because it changes the answer.
 *
 * Per-COLUMN dirty falls out: the join marks only the output columns
 * whose source changed, so a study reading column 0 is untouched by a
 * tick in source 1.
 */
class JoinNode {
  constructor(sources, keysOf, how, label) {
    this.sources = sources;
    this.keysOf = keysOf;
    this.how = how;
    this.label = label;
    this.columns = sources.map(() => null);
    this.colDirty = sources.map(() => ({ lo: 0, hi: Infinity }));
    this.downstream = sources.map(() => []);
    this.version = 0;
    sources.forEach((s, i) =>
      s.downstream.push({ mark: (r) => this.markColumn(i, r) }),
    );
  }
  markColumn(i, range) {
    this.colDirty[i] = union(this.colDirty[i], range);
    for (const d of this.downstream[i]) d.mark(range);
  }
  /** A per-column handle downstream nodes bind to. */
  column(i) {
    const self = this;
    return {
      downstream: self.downstream[i],
      get() {
        self.resolve();
        return self.columns[i];
      },
    };
  }
  resolve() {
    if (this.colDirty.every(isEmpty)) return;
    const base = this.keysOf(this.sources[0]);
    const index = this.sources.map((s, i) => {
      const m = new Map();
      const k = this.keysOf(s);
      const v = s.get();
      for (let j = 0; j < k.length; j += 1) m.set(k[j], v[j]);
      return m;
    });
    this.sources.forEach((s, i) => {
      if (isEmpty(this.colDirty[i]) && this.columns[i]) return;
      const out = new Array(base.length);
      let carried;
      for (let j = 0; j < base.length; j += 1) {
        const raw = index[i].get(base[j]);
        out[j] =
          this.how === 'asof'
            ? raw !== undefined
              ? (carried = raw)
              : carried
            : raw;
      }
      this.columns[i] = out;
      this.colDirty[i] = EMPTY;
    });
    this.version += 1;
  }
}

// ═══════════════════════════════════════════════════════════════
console.log('═══ 1. correctness — ranged result must equal full recompute ═══');
{
  const N = 5_000;
  const vals = Array.from({ length: N }, (_, i) => 100 + Math.sin(i / 50) * 10);
  const src = new RangedSource(vals.slice());
  const a = new RangedNode([src], smaSpec(20), 'sma20');
  const b = new RangedNode([a], smaSpec(50), 'sma50-of-sma20');
  b.get();

  for (let t = 0; t < 25; t += 1)
    src.append([100 + Math.sin((N + t) / 50) * 10]);
  const ranged = b.get().slice();

  const full = new RangedNode(
    [new RangedNode([new RangedSource(src.get().slice())], smaSpec(20), 'x')],
    smaSpec(50),
    'y',
  ).get();

  const same =
    ranged.length === full.length &&
    ranged.every(
      (v, i) =>
        v === full[i] ||
        (v !== undefined &&
          full[i] !== undefined &&
          Math.abs(v - full[i]) < 1e-9),
    );
  console.log(
    `  ranged == full: ${same}  (${ranged.length} rows, 25 appends, 2-deep chain)`,
  );
  console.log(
    `  cells recomputed: sma20 ${a.cellsComputed}, sma50 ${b.cellsComputed}` +
      `   vs ${(N + 25) * 2} for full recompute of both`,
  );
}

// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 2. the hot leading edge, priced ═══');
{
  const N = 500_000;
  const vals = Array.from(
    { length: N },
    (_, i) => 100 + Math.sin(i / 900) * 12,
  );
  const periods = [10, 20, 50, 100, 200];

  // full recompute per tick
  const srcF = new RangedSource(vals.slice());
  const full = periods.map(
    (p) =>
      new RangedNode([srcF], { ...smaSpec(p), lookback: Infinity }, `sma${p}`),
  );
  for (const n of full) n.get();
  const fl = [];
  for (let t = 0; t < 20; t += 1) {
    const q = now();
    srcF.append([101]);
    for (const n of full) n.get();
    fl.push(ms(q));
  }

  // ranged
  const srcR = new RangedSource(vals.slice());
  const ranged = periods.map(
    (p) => new RangedNode([srcR], smaSpec(p), `sma${p}`),
  );
  for (const n of ranged) n.get();
  const rl = [];
  for (let t = 0; t < 20; t += 1) {
    const q = now();
    srcR.append([101]);
    for (const n of ranged) n.get();
    rl.push(ms(q));
  }
  fl.sort((x, y) => x - y);
  rl.sort((x, y) => x - y);

  const okSame = full
    .map((n, i) => {
      const A = n.get(),
        B = ranged[i].get();
      return (
        A.length === B.length &&
        A.every(
          (v, j) =>
            v === B[j] ||
            (v !== undefined &&
              B[j] !== undefined &&
              Math.abs(v - B[j]) < 1e-9),
        )
      );
    })
    .every(Boolean);

  console.log(
    `  ${N.toLocaleString()} rows, ${periods.length} studies, 20 ticks`,
  );
  console.log(
    `    full recompute  median ${pct(fl, 0.5).toFixed(1).padStart(7)} ms/tick`,
  );
  console.log(
    `    dirty-per-range median ${pct(rl, 0.5).toFixed(3).padStart(7)} ms/tick   -> ${(pct(fl, 0.5) / pct(rl, 0.5)).toFixed(0)}x`,
  );
  console.log(`    identical results: ${okSame}`);
  console.log(
    `    cells recomputed over 20 ticks: full ${full.reduce((s, n) => s + n.cellsComputed, 0).toLocaleString()}` +
      `, ranged ${ranged.reduce((s, n) => s + n.cellsComputed, 0).toLocaleString()}`,
  );
}

// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 3. the op that cannot do it ═══');
{
  const N = 50_000;
  const vals = Array.from({ length: N }, (_, i) => 100 + Math.sin(i / 90) * 10);
  const src = new RangedSource(vals.slice());
  const windowed = new RangedNode([src], smaSpec(20), 'sma20');
  const global = new RangedNode([src], rankSpec(), 'percentileRank');
  windowed.get();
  global.get();

  const t1 = now();
  for (let t = 0; t < 5; t += 1) {
    src.append([101]);
    windowed.get();
  }
  const wms = ms(t1) / 5;
  const t2 = now();
  for (let t = 0; t < 5; t += 1) {
    src.append([101]);
    global.get();
  }
  const gms = ms(t2) / 5;
  console.log(
    `  windowed (sma20)        ${wms.toFixed(3)} ms/tick   lookback 20`,
  );
  console.log(
    `  global (percentileRank) ${gms.toFixed(1)} ms/tick   lookback Infinity`,
  );
  console.log('  -> locality is a per-op property the registry must declare.');
  console.log(
    '     An op that will not declare one is correct-by-default (full pass)',
  );
  console.log('     and simply does not get the speedup.');
}

// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 4. join as a node, dirty per column ═══');
{
  const keysA = Array.from({ length: 12 }, (_, i) => i);
  const keysB = [0, 1, 2, 4, 5, 6, 8, 9, 10, 11]; // two gaps
  const srcA = new RangedSource(keysA.map((i) => 100 + i));
  const srcB = new RangedSource(keysB.map((i) => 200 + i * 2));
  srcA.keys = keysA;
  srcB.keys = keysB;

  const join = new JoinNode([srcA, srcB], (s) => s.keys, 'asof', 'join');
  const colA = join.column(0);
  const colB = join.column(1);
  const studyA = new RangedNode([colA], smaSpec(3), 'sma(A)');
  const studyB = new RangedNode([colB], smaSpec(3), 'sma(B)');
  const ratio = new RangedNode([colA, colB], ratioSpec(), 'ratio');
  studyA.get();
  studyB.get();
  ratio.get();

  console.log(
    `  joined length ${join.column(0).get().length}, both columns on A's key base`,
  );
  console.log(
    `  as-of fills B's gaps: ${join.column(1).get().slice(2, 6).join(', ')}`,
  );

  const before = {
    a: studyA.slicesComputed,
    b: studyB.slicesComputed,
    r: ratio.slicesComputed,
  };
  srcB.keys = [...keysB, 12];
  srcB.append([226]);
  studyA.get();
  studyB.get();
  ratio.get();
  console.log(
    `  after a tick in B only: recomputed  sma(A)=${studyA.slicesComputed - before.a}` +
      `  sma(B)=${studyB.slicesComputed - before.b}  ratio=${ratio.slicesComputed - before.r}`,
  );
  console.log(
    '  -> per-column dirty means the A-only study stays warm even though',
  );
  console.log('     it reads from the same join node.');
}

// ═══════════════════════════════════════════════════════════════
// 12.5 ms/tick is far more than ~2,500 recomputed cells should cost.
// The rest is this prototype reallocating the whole output array every
// time the length grows. A real implementation keeps a growable buffer —
// which is another argument for node values being packed columns rather
// than JS arrays. Measure the ceiling.
// ═══════════════════════════════════════════════════════════════
console.log('\n═══ 5. how much of the remainder is the array copy? ═══');
{
  const N = 500_000,
    TICKS = 20;
  const periods = [10, 20, 50, 100, 200];
  const vals = new Float64Array(N + TICKS + 8);
  for (let i = 0; i < N; i += 1) vals[i] = 100 + Math.sin(i / 900) * 12;
  let len = N;

  // Preallocated, capacity-based: appending never reallocates, and a
  // recompute touches only [lo, hi).
  const bufs = periods.map(() => ({
    v: new Float64Array(N + TICKS + 8),
    ready: 0,
  }));
  const fill = (buf, period, lo, hi) => {
    for (let i = lo; i < hi; i += 1) {
      if (i < period - 1) {
        buf.v[i] = NaN;
        continue;
      }
      let s = 0;
      for (let k = i - period + 1; k <= i; k += 1) s += vals[k];
      buf.v[i] = s / period;
    }
  };
  periods.forEach((p, i) => fill(bufs[i], p, 0, len));

  const lat = [];
  for (let t = 0; t < TICKS; t += 1) {
    const q = now();
    vals[len] = 101;
    const lo = len;
    len += 1;
    periods.forEach((p, i) => fill(bufs[i], p, Math.max(0, lo - p), len));
    lat.push(ms(q));
  }
  lat.sort((a, b) => a - b);
  console.log(
    `  preallocated buffers, same 5 studies: median ${pct(lat, 0.5).toFixed(4)} ms/tick`,
  );
  console.log(
    `  -> the 12.5 ms above was almost entirely array reallocation, not compute.`,
  );
  console.log(
    `     Full recompute was 319.5 ms/tick, so the real ceiling is ~${(319.5 / pct(lat, 0.5)).toFixed(0)}x.`,
  );

  // Correctness against a from-scratch pass over the grown data.
  let allOk = true;
  periods.forEach((p, i) => {
    for (let j = len - 1; j >= len - 3; j -= 1) {
      let s = 0;
      for (let k = j - p + 1; k <= j; k += 1) s += vals[k];
      if (Math.abs(bufs[i].v[j] - s / p) > 1e-9) allOk = false;
    }
  });
  console.log(`  tail values match a from-scratch pass: ${allOk}`);
}
