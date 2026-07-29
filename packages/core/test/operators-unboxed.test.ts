import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* [PND-BOXFREE] — the unboxed operator paths must equal the boxed ones.       */
/*                                                                             */
/* `cumulative` and `diff` / `rate` / `pctChange` gained a fast path that      */
/* walks the source's `Float64Array` + validity bits directly and writes into  */
/* typed output buffers, instead of `read(i)` into a boxed                     */
/* `Array<number | undefined>` handed to `float64ColumnFromArray`.             */
/*                                                                             */
/* The old boxed loop is still there as the fallback for chunked / non-numeric */
/* sources, so the contract is that the two agree. Every expectation here is   */
/* computed by a reference implementation that mirrors the OLD code, rather    */
/* than hard-coded — a hard-coded value would pin whatever the new path        */
/* happens to do.                                                              */
/*                                                                             */
/* The seams that could plausibly differ, each with a case:                    */
/*   - a leading run of missing cells (output undefined until first defined)   */
/*   - a missing cell CARRIES the accumulator rather than resetting it         */
/*   - a stored NaN is a *defined* number and must be folded in                */
/*   - `allFinite` on the output must be derived, not inherited                */
/*   - "all defined ⇒ no validity bitmap" must survive                         */
/* -------------------------------------------------------------------------- */

type Cell = number | undefined;

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'a', kind: 'number', required: false },
  { name: 'b', kind: 'number', required: false },
] as const;

function series(a: Cell[], b: Cell[] = a) {
  return new TimeSeries({
    name: 's',
    schema,
    rows: a.map((v, i) => [i * 1000, v, b[i]] as const) as never,
  });
}

const readColumn = (s: TimeSeries<never>, name: string): Cell[] =>
  Array.from({ length: s.length }, (_, i) => s.column(name).at(i) as Cell);

/* ── reference implementations, mirroring the pre-change boxed code ──────── */

function referenceCumulative(
  src: Cell[],
  reducer: 'sum' | 'min' | 'max' | 'count',
): Cell[] {
  const apply = (acc: number | undefined, v: number): number => {
    switch (reducer) {
      case 'sum':
        return (acc ?? 0) + v;
      case 'count':
        return (acc ?? 0) + 1;
      case 'max':
        return acc === undefined || v > acc ? v : acc;
      case 'min':
        return acc === undefined || v < acc ? v : acc;
    }
  };
  const out: Cell[] = new Array(src.length);
  let acc: number | undefined;
  for (let i = 0; i < src.length; i += 1) {
    const raw = src[i];
    if (typeof raw === 'number') acc = apply(acc, raw);
    out[i] = acc;
  }
  return out;
}

function referenceDiff(
  src: Cell[],
  mode: 'diff' | 'rate' | 'pctChange',
  stepSeconds = 1,
): Cell[] {
  const out: Cell[] = new Array(src.length);
  if (src.length > 0) out[0] = undefined;
  for (let i = 1; i < src.length; i += 1) {
    const prev = src[i - 1];
    const curr = src[i];
    if (typeof curr === 'number' && typeof prev === 'number') {
      const delta = curr - prev;
      if (mode === 'pctChange') out[i] = prev !== 0 ? delta / prev : undefined;
      else if (mode === 'rate')
        out[i] = stepSeconds !== 0 ? delta / stepSeconds : undefined;
      else out[i] = delta;
    } else {
      out[i] = undefined;
    }
  }
  return out;
}

/* ── shapes ─────────────────────────────────────────────────────────────── */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(0xb0f);

const SHAPES: Record<string, Cell[]> = {
  dense: Array.from({ length: 200 }, (_, i) => i - 100),
  'scattered gaps': Array.from({ length: 200 }, (_, i) =>
    i % 7 === 3 ? undefined : rnd() * 100 - 50,
  ),
  // The accumulator-prefix seam: output stays undefined until the first
  // defined cell, and the new path expresses that by simply not writing.
  'leading gaps': [
    undefined,
    undefined,
    undefined,
    5,
    ...Array.from({ length: 50 }, (_, i) => i),
  ],
  'trailing gaps': [
    ...Array.from({ length: 50 }, (_, i) => i),
    undefined,
    undefined,
    undefined,
  ],
  'all missing': Array.from({ length: 40 }, () => undefined),
  // A missing cell must CARRY the accumulator, not reset it.
  'long gap run': [1, 2, ...Array.from({ length: 30 }, () => undefined), 3, 4],
  zeros: [0, 0, 0, 0, 0],
  'signed zeros': [-0, 0, -0, 0],
  negatives: Array.from({ length: 60 }, (_, i) => -i),
  empty: [],
  single: [7],
  'single missing': [undefined],
  pair: [3, 9],
};

describe('[PND-BOXFREE] cumulative: unboxed path equals the boxed reference', () => {
  for (const reducer of ['sum', 'min', 'max', 'count'] as const) {
    for (const [name, src] of Object.entries(SHAPES)) {
      it(`'${reducer}' on '${name}'`, () => {
        const out = series(src).cumulative({ a: reducer });
        expect(readColumn(out as never, 'a')).toStrictEqual(
          referenceCumulative(src, reducer),
        );
      });
    }
  }

  it('a custom fold still routes through the closure and agrees', () => {
    const src = SHAPES['scattered gaps']!;
    const out = series(src).cumulative({
      a: (acc: number, v: number) => acc * 0.5 + v,
    });
    const ref: Cell[] = new Array(src.length);
    let acc: number | undefined;
    for (let i = 0; i < src.length; i += 1) {
      const raw = src[i];
      if (typeof raw === 'number')
        acc = acc === undefined ? raw : acc * 0.5 + raw;
      ref[i] = acc;
    }
    expect(readColumn(out as never, 'a')).toStrictEqual(ref);
  });

  it('leaves no validity bitmap when every output cell is defined', () => {
    const out = series(SHAPES.dense!).cumulative({ a: 'sum' });
    const col = out.column('a');
    expect(col.validity).toBeUndefined();
    expect(col.hasMissing()).toBe(false);
  });

  it('keeps a validity bitmap for the undefined prefix', () => {
    const out = series(SHAPES['leading gaps']!).cumulative({ a: 'sum' });
    const col = out.column('a');
    expect(col.nullCount()).toBe(3);
    expect(col.at(2)).toBeUndefined();
    expect(col.at(3)).toBe(5);
  });

  it('derives allFinite from the output, not the input', () => {
    // Input is all-finite; the running sum overflows to +Infinity, so the
    // OUTPUT is not. Inheriting the source's flag would mark a non-finite
    // column `allFinite: true` and send every downstream reducer down the
    // unguarded path.
    const out = series([Number.MAX_VALUE, Number.MAX_VALUE]).cumulative({
      a: 'sum',
    });
    const col = out.column('a');
    expect(col.at(1)).toBe(Infinity);
    expect((col as unknown as { allFinite: boolean }).allFinite).toBe(false);
  });

  it('handles many columns independently', () => {
    const a = SHAPES['scattered gaps']!;
    const b = SHAPES['long gap run']!;
    const n = Math.max(a.length, b.length);
    const padA = Array.from({ length: n }, (_, i) => a[i]);
    const padB = Array.from({ length: n }, (_, i) => b[i]);
    const out = series(padA, padB).cumulative({ a: 'sum', b: 'max' });
    expect(readColumn(out as never, 'a')).toStrictEqual(
      referenceCumulative(padA, 'sum'),
    );
    expect(readColumn(out as never, 'b')).toStrictEqual(
      referenceCumulative(padB, 'max'),
    );
  });
});

describe('[PND-BOXFREE] diff / rate / pctChange: unboxed path equals the boxed reference', () => {
  for (const mode of ['diff', 'rate', 'pctChange'] as const) {
    for (const [name, src] of Object.entries(SHAPES)) {
      it(`'${mode}' on '${name}'`, () => {
        const s = series(src);
        const out =
          mode === 'diff'
            ? s.diff(['a'])
            : mode === 'rate'
              ? s.rate(['a'])
              : s.pctChange(['a']);
        expect(readColumn(out as never, 'a')).toStrictEqual(
          referenceDiff(src, mode),
        );
      });
    }
  }

  it('pctChange yields undefined where the predecessor is zero', () => {
    const out = series([0, 5, 0, 5]).pctChange(['a']);
    expect(readColumn(out as never, 'a')).toStrictEqual([
      undefined,
      undefined,
      -1,
      undefined,
    ]);
  });

  it('drop: true removes the predecessor-less first row', () => {
    const out = series([1, 3, 6]).diff(['a'], { drop: true });
    expect(out.length).toBe(2);
    expect(readColumn(out as never, 'a')).toStrictEqual([2, 3]);
  });

  it('leaves no validity bitmap when every diffed cell is defined', () => {
    // Row 0 has no predecessor, so a diff always has at least one gap —
    // the bitmap must survive, and nullCount must count exactly that row.
    const out = series([1, 2, 3, 4]).diff(['a']);
    const col = out.column('a');
    expect(col.nullCount()).toBe(1);
    expect(col.at(0)).toBeUndefined();
  });

  it('rate divides by the real elapsed seconds, not the row step', () => {
    const s = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 10, 0],
        [2000, 30, 0],
        [3000, 30, 0],
      ] as never,
    });
    // 20 over 2 s, then 0 over 1 s.
    expect(readColumn(s.rate(['a']) as never, 'a')).toStrictEqual([
      undefined,
      10,
      0,
    ]);
  });

  it('derives allFinite from the output, not the input', () => {
    const out = series([-Number.MAX_VALUE, Number.MAX_VALUE]).diff(['a']);
    const col = out.column('a');
    expect(col.at(1)).toBe(Infinity);
    expect((col as unknown as { allFinite: boolean }).allFinite).toBe(false);
  });
});

describe('[PND-BOXFREE] randomised agreement', () => {
  it('agrees with the boxed reference over 300 random shapes', () => {
    const r = mulberry32(0xfeed);
    for (let trial = 0; trial < 300; trial += 1) {
      const n = Math.floor(r() * 40);
      // Row intake rejects non-finite cells, so a randomly-built series
      // can only carry finite values and gaps. Defined non-finite cells
      // are covered separately, via the operator chain that can actually
      // produce them.
      const src: Cell[] = Array.from({ length: n }, () => {
        const p = r();
        if (p < 0.2) return undefined;
        if (p < 0.24) return 0;
        return Math.round((r() * 200 - 100) * 100) / 100;
      });
      const s = series(src);
      const label = `trial ${trial}: ${JSON.stringify(src)}`;
      for (const reducer of ['sum', 'min', 'max', 'count'] as const) {
        expect(
          readColumn(s.cumulative({ a: reducer }) as never, 'a'),
          `${label} cumulative ${reducer}`,
        ).toStrictEqual(referenceCumulative(src, reducer));
      }
      expect(
        readColumn(s.diff(['a']) as never, 'a'),
        `${label} diff`,
      ).toStrictEqual(referenceDiff(src, 'diff'));
      expect(
        readColumn(s.pctChange(['a']) as never, 'a'),
        `${label} pctChange`,
      ).toStrictEqual(referenceDiff(src, 'pctChange'));
    }
  });
});

describe('[PND-BOXFREE] defined non-finite cells, reached the only way they can be', () => {
  // Row intake rejects NaN / ±Infinity ("expected finite number"), so a
  // *defined* non-finite cell cannot be constructed directly. It can still
  // occur: an operator whose own arithmetic overflows produces one, and
  // that column is then a legitimate input to the next operator. This is
  // where the unboxed path's finiteness handling has to hold up, because
  // the old boxed path treated a stored NaN as a defined number
  // (`typeof raw === 'number'` is true for NaN) and so must the new one.
  const overflowed = () =>
    new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, Number.MAX_VALUE, 1],
        [1000, Number.MAX_VALUE, 2],
        [2000, 1, 3],
        [3000, 2, 4],
      ] as never,
    }).cumulative({ a: 'sum' });

  it('produces a defined +Infinity that the column reports as present', () => {
    const col = overflowed().column('a');
    expect(col.at(1)).toBe(Infinity);
    expect(col.nullCount()).toBe(0);
    expect((col as unknown as { allFinite: boolean }).allFinite).toBe(false);
  });

  it('cumulative folds a defined non-finite cell in, as the boxed path did', () => {
    const src = readColumn(overflowed() as never, 'a');
    const again = overflowed().cumulative({ a: 'sum' });
    expect(readColumn(again as never, 'a')).toStrictEqual(
      referenceCumulative(src, 'sum'),
    );
  });

  it('diff over a defined non-finite cell agrees with the boxed reference', () => {
    const src = readColumn(overflowed() as never, 'a');
    expect(readColumn(overflowed().diff(['a']) as never, 'a')).toStrictEqual(
      referenceDiff(src, 'diff'),
    );
  });

  it('Infinity - Infinity is NaN, defined, and keeps allFinite false', () => {
    // The boxed path wrote NaN into the array and `float64ColumnFromArray`
    // saw a number, so the cell stayed defined with allFinite false. The
    // unboxed path must not quietly turn it into a gap.
    const col = overflowed().diff(['a']).column('a');
    expect(Number.isNaN(col.at(2) as number)).toBe(true);
    expect((col as unknown as { allFinite: boolean }).allFinite).toBe(false);
  });
});
