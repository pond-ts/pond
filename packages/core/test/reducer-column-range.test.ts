import { describe, expect, it } from 'vitest';
import { Float64Column, validityFromPredicate } from '../src/columnar/index.js';
import { resolveReducer } from '../src/reducers/index.js';

/* -------------------------------------------------------------------------- */
/* [PND-AGGALLOC] — `reduceColumnRange` must equal `reduceColumn` on a slice.  */
/*                                                                             */
/* The whole point of the range form is to avoid materialising                 */
/* `col.sliceByRange(start, end)`, so the contract is exactly:                  */
/*                                                                             */
/*   reduceColumnRange(col, s, e)  ===  reduceColumn(col.sliceByRange(s, e))   */
/*                                                                             */
/* This asserts that directly, against the real slice, over every shape that   */
/* could break it. The load-bearing case is a range that does NOT start at 0:  */
/* slicing REBASES the validity bitmap so the slice's bit 0 is the source's    */
/* bit `start`, while the range form indexes the ORIGINAL bitmap at absolute   */
/* positions. Get that backwards and every offset bucket silently reads the    */
/* wrong cells' validity — with no type error and no crash.                    */
/* -------------------------------------------------------------------------- */

const REDUCERS = [
  'sum',
  'count',
  'avg',
  'min',
  'max',
  'stdev',
  'median',
  'p95',
];

/** Deterministic RNG so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function column(
  source: ReadonlyArray<number | undefined>,
  allFinite: boolean,
): Float64Column {
  const n = source.length;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    values[i] = typeof source[i] === 'number' ? (source[i] as number) : 0;
  }
  const validity = validityFromPredicate(
    n,
    (i) => typeof source[i] === 'number',
  );
  return new Float64Column(values, n, validity, allFinite);
}

const rnd = mulberry32(0x9e3779b9);

const SHAPES: Record<string, ReadonlyArray<number | undefined>> = {
  dense: Array.from({ length: 64 }, () => rnd() * 200 - 100),
  // Gaps at irregular offsets — the case that exercises bit indexing.
  gappy: Array.from({ length: 64 }, (_, i) =>
    i % 7 === 3 || i % 11 === 5 ? undefined : rnd() * 50,
  ),
  'mostly missing': Array.from({ length: 64 }, (_, i) =>
    i % 13 === 0 ? rnd() * 10 : undefined,
  ),
  'all missing': Array.from({ length: 32 }, () => undefined),
  constant: Array.from({ length: 40 }, () => 5),
  'single value': [42],
  'two values': [3, -7],
  'negative zero': [-0, 0, -0, 0],
};

// Ranges deliberately skewed off zero and across byte boundaries (8, 16),
// because that is where an absolute-vs-rebased bitmap bug hides.
const RANGES: Array<[number, number]> = [
  [0, 0],
  [0, 1],
  [0, 8],
  [1, 9],
  [3, 11],
  [5, 6],
  [7, 8],
  [8, 16],
  [9, 25],
  [13, 13],
  [17, 32],
  [31, 32],
];

describe('[PND-AGGALLOC] reduceColumnRange === reduceColumn(sliceByRange)', () => {
  for (const name of REDUCERS) {
    for (const allFinite of [true, false]) {
      it(`'${name}' matches the slice on every shape and range (allFinite: ${allFinite})`, () => {
        const def = resolveReducer(name);
        expect(def.reduceColumnRange).toBeTypeOf('function');
        expect(def.reduceColumn).toBeTypeOf('function');

        for (const [shape, source] of Object.entries(SHAPES)) {
          const col = column(source, allFinite);
          for (const [start, end] of RANGES) {
            if (end > col.length) continue;
            const viaRange = def.reduceColumnRange!(col, start, end);
            const viaSlice = def.reduceColumn!(col.sliceByRange(start, end));
            expect(
              viaRange,
              `${name} ${shape}[${start},${end}) allFinite=${allFinite}`,
            ).toStrictEqual(viaSlice);
          }
        }
      });
    }
  }

  it('matches the slice on non-finite data (guarded path only)', () => {
    // `allFinite: false` is the honest flag here — a column carrying
    // NaN/±Inf while claiming `allFinite` violates the contract, so the
    // fast path's behaviour on it is undefined and not worth pinning.
    const source: Array<number | undefined> = Array.from(
      { length: 48 },
      (_, i) => {
        if (i % 9 === 0) return NaN;
        if (i % 13 === 0) return Infinity;
        if (i % 17 === 0) return -Infinity;
        if (i % 5 === 0) return undefined;
        return i - 24;
      },
    );
    const col = column(source, false);
    for (const name of REDUCERS) {
      const def = resolveReducer(name);
      for (const [start, end] of RANGES) {
        if (end > col.length) continue;
        expect(
          def.reduceColumnRange!(col, start, end),
          `${name} non-finite [${start},${end})`,
        ).toStrictEqual(def.reduceColumn!(col.sliceByRange(start, end)));
      }
    }
  });

  it('matches the whole-column form at (0, length)', () => {
    // `reduceColumn` keeps its own body for `count` / `avg` (they use the
    // cached `definedCount`, which a range cannot), so the two are only
    // guaranteed to agree — not to be the same code. Pin the agreement.
    for (const [shape, source] of Object.entries(SHAPES)) {
      for (const allFinite of [true, false]) {
        const col = column(source, allFinite);
        for (const name of REDUCERS) {
          const def = resolveReducer(name);
          expect(
            def.reduceColumnRange!(col, 0, col.length),
            `${name} ${shape} whole-column allFinite=${allFinite}`,
          ).toStrictEqual(def.reduceColumn!(col));
        }
      }
    }
  });

  it('reads validity at absolute offsets, not rebased ones', () => {
    // A targeted regression guard for the bit-indexing bug the range form
    // could plausibly have. Cells 0-7 are defined and huge; cells 8-15 are
    // missing except one small value. Reducing [8, 16) must see ONE cell —
    // if the bitmap were read rebased (bits 0-7 for range 8-15), it would
    // see the first byte's all-defined bits and pick up the wrong answer.
    const source: Array<number | undefined> = [
      ...Array.from({ length: 8 }, () => 1000),
      ...Array.from({ length: 8 }, (_, i) => (i === 4 ? 7 : undefined)),
    ];
    const col = column(source, true);
    expect(resolveReducer('count').reduceColumnRange!(col, 8, 16)).toBe(1);
    expect(resolveReducer('sum').reduceColumnRange!(col, 8, 16)).toBe(7);
    expect(resolveReducer('min').reduceColumnRange!(col, 8, 16)).toBe(7);
    expect(resolveReducer('max').reduceColumnRange!(col, 8, 16)).toBe(7);
    expect(resolveReducer('avg').reduceColumnRange!(col, 8, 16)).toBe(7);
    expect(resolveReducer('median').reduceColumnRange!(col, 8, 16)).toBe(7);
  });
});
