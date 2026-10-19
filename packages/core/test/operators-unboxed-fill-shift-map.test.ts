import { describe, expect, it } from 'vitest';
import {
  type Column,
  ColumnarStore,
  Float64Column,
  concatSorted,
  timeKeyColumnFromArray,
} from '../src/columnar/index.js';
import { shiftOp } from '../src/batch/operators/shift.js';
import { fillOp, type ResolvedFillSpec } from '../src/batch/operators/fill.js';
import { mapOp, type ColumnMapper } from '../src/batch/operators/map.js';
import { TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* [PND-BOXFREE] second tranche — `shift`, `fill`, `mapColumns`.               */
/*                                                                             */
/* Each operator gained an unboxed path for packed number columns: it reads    */
/* the source `Float64Array` and writes a typed output buffer instead of       */
/* `read(i)` into a boxed array handed to `float64ColumnFromArray`.            */
/*                                                                             */
/* The OLD boxed loop is still in the source, unchanged, as the fallback for   */
/* chunked storage. So the strongest available proof is differential: build    */
/* the same data twice — once packed (new path), once split across two chunks  */
/* (old path, verbatim) — run the operator on both, and require the outputs    */
/* to be identical cell for cell (`Object.is`, so `-0` vs `0` counts), with    */
/* the same `allFinite` flag and the same "column replaced or kept" outcome.   */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
] as const;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A store whose `v` column is a packed `Float64Column` over `raw`. */
function packedStore(times: number[], raw: Float64Array) {
  return ColumnarStore.fromTrustedStore(
    SCHEMA,
    timeKeyColumnFromArray(times),
    new Map<string, Column>([
      // `allFinite` false is always safe; when it can be proven true, say so
      // so the fast copy branches are exercised too.
      ['v', new Float64Column(raw.slice(), raw.length, isAllFinite(raw))],
    ]),
  );
}

function isAllFinite(raw: Float64Array): boolean {
  for (const v of raw) if (v - v !== 0) return false;
  return true;
}

/** The same data with `v` split into two chunks — drives the boxed path. */
function chunkedStore(times: number[], raw: Float64Array, split: number) {
  const store = concatSorted([
    packedStore(times.slice(0, split), raw.slice(0, split)),
    packedStore(times.slice(split), raw.slice(split)),
  ]);
  expect(store.columns.get('v')!.storage).toBe('chunked'); // guard
  return store;
}

type Shape = { times: number[]; raw: Float64Array; split: number };

/**
 * Random shapes with the cases that could plausibly differ: leading and
 * trailing gap runs, long runs, a stray `±Infinity` in the buffer (a gap,
 * [PND-NANREP]), `-0`, huge magnitudes (so interpolation can overflow),
 * and repeated timestamps (so linear's `tspan === 0` branch runs).
 */
function randomShape(rnd: () => number): Shape {
  const n = 2 + Math.floor(rnd() * 40);
  const times: number[] = [];
  let t = 0;
  for (let i = 0; i < n; i += 1) {
    times.push(t);
    const r = rnd();
    t += r < 0.15 ? 0 : r < 0.6 ? 1000 : 2500;
  }
  // concatSorted needs the two halves disjoint: pick a split where time
  // strictly increases, forcing one if needed.
  const split = 1 + Math.floor(rnd() * (n - 1));
  if (times[split]! <= times[split - 1]!) {
    for (let i = split; i < n; i += 1) times[i]! += 1000;
  }
  const raw = new Float64Array(n);
  const gapRate = rnd() * 0.7;
  for (let i = 0; i < n; i += 1) {
    const r = rnd();
    if (r < gapRate) {
      const g = rnd();
      raw[i] = g < 0.8 ? NaN : g < 0.9 ? Infinity : -Infinity;
    } else {
      const k = rnd();
      raw[i] =
        k < 0.05
          ? -0
          : k < 0.1
            ? 1.7e308
            : k < 0.15
              ? -1.7e308
              : Math.round((rnd() - 0.5) * 2000) / 8;
    }
  }
  return { times, raw, split };
}

function cells(col: Column): unknown[] {
  return Array.from({ length: col.length }, (_, i) => col.read(i));
}

/** Packed vs chunked output for column `v`: identical in every respect. */
function expectSameOutput(
  packedIn: ColumnarStore<never>,
  chunkedIn: ColumnarStore<never>,
  packedOut: ColumnarStore<never>,
  chunkedOut: ColumnarStore<never>,
) {
  const p = packedOut.columns.get('v')!;
  const c = chunkedOut.columns.get('v')!;
  const pReplaced = p !== packedIn.columns.get('v');
  const cReplaced = c !== chunkedIn.columns.get('v');
  expect(pReplaced).toBe(cReplaced);
  expect(p.length).toBe(c.length);
  const pc = cells(p);
  const cc = cells(c);
  for (let i = 0; i < pc.length; i += 1) {
    if (!Object.is(pc[i], cc[i])) {
      throw new Error(`cell ${i}: packed ${pc[i]} vs boxed ${cc[i]}`);
    }
  }
  if (pReplaced) {
    // Both outputs are freshly built packed columns.
    const pf = p as Float64Column;
    const cf = c as Float64Column;
    expect(pf.storage).toBe('packed');
    expect(pf.allFinite).toBe(cf.allFinite);
    // Raw buffers agree too: a gap is spelled `NaN`, never `±Infinity`.
    for (let i = 0; i < pf.length; i += 1) {
      expect(Object.is(pf._values[i], cf._values[i])).toBe(true);
    }
  }
}

const SHAPE_COUNT = 150;

describe('[PND-BOXFREE] shift: unboxed path equals the boxed path', () => {
  it(`agrees over ${SHAPE_COUNT} random shapes and every offset`, () => {
    const rnd = mulberry32(0x5a1f7);
    for (let s = 0; s < SHAPE_COUNT; s += 1) {
      const { times, raw, split } = randomShape(rnd);
      const n = raw.length;
      const packed = packedStore(times, raw) as never as ColumnarStore<never>;
      const chunked = chunkedStore(times, raw, split) as never;
      for (let k = -n - 2; k <= n + 2; k += 1) {
        const a = shiftOp(packed, SCHEMA as never, ['v'], k);
        const b = shiftOp(chunked, SCHEMA as never, ['v'], k);
        expectSameOutput(packed, chunked, a.store as never, b.store as never);
      }
    }
  });

  it('a dense column shifted by 0 stays allFinite; any padding clears it', () => {
    const raw = Float64Array.of(1, 2, 3);
    const store = packedStore([0, 1000, 2000], raw) as never;
    const at = (k: number) =>
      shiftOp(store, SCHEMA as never, ['v'], k).store.columns.get(
        'v',
      ) as Float64Column;
    expect(at(0).allFinite).toBe(true);
    expect(at(1).allFinite).toBe(false);
    expect(at(-1).allFinite).toBe(false);
    expect(cells(at(1))).toEqual([undefined, 1, 2]);
    expect(cells(at(-1))).toEqual([2, 3, undefined]);
    expect(cells(at(5))).toEqual([undefined, undefined, undefined]);
  });

  it('does not alias the source buffer', () => {
    const store = packedStore([0, 1000], Float64Array.of(1, 2)) as never;
    const out = shiftOp(store, SCHEMA as never, ['v'], 0).store.columns.get(
      'v',
    ) as Float64Column;
    const src = (store as ColumnarStore<never>).columns.get(
      'v',
    ) as Float64Column;
    expect(out._values).not.toBe(src._values);
  });
});

const FILL_SPECS: ResolvedFillSpec[] = [
  { mode: 'hold' },
  { mode: 'bfill' },
  { mode: 'zero' },
  { mode: 'linear' },
  { mode: 'literal', value: 7.5 },
  { mode: 'literal', value: -0 },
  // A non-finite literal is placed, then reads back as missing.
  { mode: 'literal', value: NaN },
  { mode: 'literal', value: Infinity },
];
const LIMITS = [undefined, 0, 1, 2, 3];
const MAX_GAPS = [undefined, 0, 1000, 2500, 5000];

describe('[PND-BOXFREE] fill: unboxed path equals the boxed path', () => {
  it(`agrees over ${SHAPE_COUNT} random shapes × every strategy, limit and maxGap`, () => {
    const rnd = mulberry32(0xf111);
    for (let s = 0; s < SHAPE_COUNT; s += 1) {
      const { times, raw, split } = randomShape(rnd);
      const packed = packedStore(times, raw) as never as ColumnarStore<never>;
      const chunked = chunkedStore(times, raw, split) as never;
      for (const spec of FILL_SPECS) {
        for (const limit of LIMITS) {
          for (const maxGap of MAX_GAPS) {
            const specs = new Map([['v', spec]]);
            const a = fillOp(packed, SCHEMA as never, specs, limit, maxGap);
            const b = fillOp(chunked, SCHEMA as never, specs, limit, maxGap);
            expectSameOutput(
              packed,
              chunked,
              a.store as never,
              b.store as never,
            );
          }
        }
      }
    }
  });

  it('a kind-mismatched literal throws the same error on both paths', () => {
    const raw = Float64Array.of(1, NaN, 3);
    const times = [0, 1000, 2000];
    const specs = new Map([
      ['v', { mode: 'literal', value: 'x' } as ResolvedFillSpec],
    ]);
    const run = (store: unknown) => () =>
      fillOp(store as never, SCHEMA as never, specs, undefined, undefined);
    const message =
      "fill: literal value \"x\" for column 'v' does not match its kind 'number'";
    expect(run(packedStore(times, raw))).toThrow(new RangeError(message));
    expect(run(chunkedStore(times, raw, 1))).toThrow(new RangeError(message));
  });

  it('a mismatched literal does not throw when there is no gap to place it in', () => {
    const specs = new Map([
      ['v', { mode: 'literal', value: 'x' } as ResolvedFillSpec],
    ]);
    const store = packedStore([0, 1000], Float64Array.of(1, 2));
    const out = fillOp(
      store as never,
      SCHEMA as never,
      specs,
      undefined,
      undefined,
    );
    // Untouched: the same column object, by reference.
    expect(out.store.columns.get('v')).toBe(store.columns.get('v'));
  });

  it('an interpolation that overflows reads back as missing', () => {
    const store = packedStore(
      [0, 1000, 2000],
      Float64Array.of(-1.7e308, NaN, 1.7e308),
    );
    const out = fillOp(
      store as never,
      SCHEMA as never,
      new Map([['v', { mode: 'linear' } as ResolvedFillSpec]]),
      undefined,
      undefined,
    ).store.columns.get('v') as Float64Column;
    expect(out.read(1)).toBeUndefined();
    expect(out.allFinite).toBe(false);
  });

  it('a filled-everywhere column is allFinite', () => {
    const store = packedStore([0, 1000, 2000], Float64Array.of(1, NaN, 3));
    const out = fillOp(
      store as never,
      SCHEMA as never,
      new Map([['v', { mode: 'hold' } as ResolvedFillSpec]]),
      undefined,
      undefined,
    ).store.columns.get('v') as Float64Column;
    expect(cells(out)).toEqual([1, 1, 3]);
    expect(out.allFinite).toBe(true);
  });

  it('text columns still fill through the public method (boxed path)', () => {
    const s = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'host', kind: 'string', required: false },
        { name: 'v', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 'a', 1],
        [1000, undefined, undefined],
        [2000, 'c', 3],
      ],
    });
    const out = s.fill('hold');
    expect(out.at(1)!.get('host')).toBe('a');
    expect(out.at(1)!.get('v')).toBe(1);
  });
});

const MAPPERS: Record<string, ColumnMapper> = {
  double: (x) => (x as number) * 2,
  'NaN above 0': (x) => ((x as number) > 0 ? NaN : x),
  'Infinity for big': (x) => (Math.abs(x as number) > 100 ? Infinity : x),
  'overflow by doubling huge': (x) => (x as number) * 10,
  'negate (makes -0)': (x) => -(x as number),
  'wrong kind via cast': (x) => String(x),
  'undefined via cast': () => undefined,
};

describe('[PND-BOXFREE] mapColumns: unboxed path equals the boxed path', () => {
  for (const [label, fn] of Object.entries(MAPPERS)) {
    it(`'${label}' agrees over ${SHAPE_COUNT} random shapes, same calls`, () => {
      const rnd = mulberry32(0x3a9);
      for (let s = 0; s < SHAPE_COUNT; s += 1) {
        const { times, raw, split } = randomShape(rnd);
        const packed = packedStore(times, raw) as never as ColumnarStore<never>;
        const chunked = chunkedStore(times, raw, split) as never;
        const callsA: unknown[] = [];
        const callsB: unknown[] = [];
        const a = mapOp(
          packed,
          SCHEMA as never,
          new Map([['v', (x: unknown) => (callsA.push(x), fn(x))]]),
        );
        const b = mapOp(
          chunked,
          SCHEMA as never,
          new Map([['v', (x: unknown) => (callsB.push(x), fn(x))]]),
        );
        // The mapper sees the same values, in the same order, the same
        // number of times — only on defined cells.
        expect(callsA.length).toBe(callsB.length);
        for (let i = 0; i < callsA.length; i += 1) {
          expect(Object.is(callsA[i], callsB[i])).toBe(true);
        }
        expectSameOutput(packed, chunked, a.store as never, b.store as never);
      }
    });
  }
});

describe('[PND-BOXFREE] fill: an unknown mode (untyped JS) is a no-op on both paths', () => {
  it('keeps the column by reference, like the boxed loop', () => {
    const times = [0, 1000, 2000];
    const raw = Float64Array.of(1, Infinity, 3);
    const specs = new Map([
      ['v', { mode: 'mean' } as never as ResolvedFillSpec],
    ]);
    for (const store of [
      packedStore(times, raw),
      chunkedStore(times, raw, 1),
    ]) {
      const out = fillOp(
        store as never,
        SCHEMA as never,
        specs,
        undefined,
        undefined,
      );
      expect(out.store.columns.get('v')).toBe(store.columns.get('v'));
    }
  });
});
