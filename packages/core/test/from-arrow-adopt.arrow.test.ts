import { describe, expect, it } from 'vitest';
import {
  Float64,
  Int32,
  Table,
  Utf8,
  makeData,
  makeVector,
  vectorFromArray,
} from 'apache-arrow';
import { TimeSeries } from '../src/index.js';
import type { Float64Column } from '../src/columnar/index.js';

/**
 * [PND-ARROWNULL] — zero-copy adoption of a **null-bearing** numeric column.
 *
 * `fromArrow` has always adopted a `Float64Array` values buffer when
 * `nullCount === 0`. A column carrying nulls used to fall to a per-element
 * `vector.get(i)` walk — ~10× slower than the dense path it otherwise
 * matches — even though Arrow's validity bitmap is byte-identical to
 * pond's. It now adopts both buffers.
 *
 * Two things need pinning:
 *
 * 1. **Adoption is actually happening.** Easy to claim, easy to silently
 *    lose to a fallback. The test that proves it writes through the Arrow
 *    buffer afterwards and reads the change out of the series — only true
 *    if there was no copy. (That aliasing is also the documented hazard, so
 *    the test doubles as the record of it.)
 * 2. **Every decline path still produces the same answer.** Adoption is
 *    refused for six distinct reasons; each has to land on the fallback and
 *    agree with it cell for cell. A wrong answer here is silent.
 */

const MINUTE = 60_000;

/** Real single-chunk Float64 vector with nulls at `i % every === offset`. */
function nulledFloats(n: number, every: number, offset = 0) {
  return vectorFromArray(
    Array.from({ length: n }, (_, i) =>
      i % every === offset ? null : 100 + i * 0.5,
    ),
    new Float64(),
  );
}

function timeVector(n: number) {
  return makeVector(Float64Array.from({ length: n }, (_, i) => i * MINUTE));
}

function seriesOf(n: number, close: ReturnType<typeof nulledFloats>) {
  return TimeSeries.fromArrow(
    new Table({ time: timeVector(n), close }) as never,
  );
}

/** The values pond ends up with, `undefined` for a gap. */
function cells(s: ReturnType<typeof seriesOf>): Array<number | undefined> {
  const col = s.column('close' as never) as unknown as Float64Column;
  return Array.from({ length: s.length }, (_, i) => col.read(i));
}

describe('[PND-ARROWNULL] adoption happens', () => {
  it('adopts the values buffer — writes through it are visible', () => {
    // The only honest proof of zero-copy: mutate Arrow's buffer after
    // construction and watch it show up in the series. This is also the
    // aliasing hazard the caller inherits, stated as a test rather than
    // only as prose.
    const n = 64;
    const close = nulledFloats(n, 8);
    const s = seriesOf(n, close);
    const col = s.column('close' as never) as unknown as Float64Column;

    expect(col.read(1)).toBe(100.5);
    (close.data[0]!.values as Float64Array)[1] = -42;
    expect(col.read(1)).toBe(-42);
  });

  it('adopts the validity bitmap — same buffer, not a copy', () => {
    const n = 64;
    const close = nulledFloats(n, 8);
    const s = seriesOf(n, close);
    const col = s.column('close' as never) as unknown as Float64Column;
    expect(col.validity?.bits).toBe(close.data[0]!.nullBitmap);
  });

  it('proves allFinite, so reductions take the unguarded path', () => {
    const n = 1000;
    const s = seriesOf(n, nulledFloats(n, 25));
    const col = s.column('close' as never) as unknown as Float64Column;
    expect(col.allFinite).toBe(true);
    expect(col.nullCount()).toBe(40);
    expect(col.length).toBe(n);
  });

  it('reads the same cells the per-element path would', () => {
    // The load-bearing correctness check: adoption keeps Arrow's own
    // values at null slots (arbitrary, per Float64Column's contract)
    // rather than writing NaN, so the *bitmap* is what has to carry the
    // gaps. Every cell is checked, not a sample.
    const n = 501; // deliberately not a multiple of 8
    const s = seriesOf(n, nulledFloats(n, 7, 3));
    const got = cells(s);
    for (let i = 0; i < n; i += 1) {
      expect(got[i]).toBe(i % 7 === 3 ? undefined : 100 + i * 0.5);
    }
  });

  it('sums and means over the gaps correctly', () => {
    const n = 200;
    const s = seriesOf(n, nulledFloats(n, 10));
    const col = s.column('close' as never) as unknown as Float64Column;
    let expected = 0;
    let defined = 0;
    for (let i = 0; i < n; i += 1) {
      if (i % 10 !== 0) {
        expected += 100 + i * 0.5;
        defined += 1;
      }
    }
    expect(col.count()).toBe(defined);
    expect(col.sum()).toBeCloseTo(expected, 9);
    expect(col.mean()).toBeCloseTo(expected / defined, 9);
  });
});

describe('[PND-ARROWNULL] declines, and still gets the right answer', () => {
  it('declines a sliced vector (non-zero chunk offset)', () => {
    const n = 128;
    const full = nulledFloats(n, 8);
    const sliced = full.slice(8, 72); // offset != 0
    expect(sliced.data[0]!.offset).not.toBe(0);
    const s = TimeSeries.fromArrow(
      new Table({ time: timeVector(sliced.length), close: sliced }) as never,
    );
    const col = s.column('close' as never) as unknown as Float64Column;
    // Cells 8..71 of the original: null where i % 8 === 0.
    for (let i = 0; i < sliced.length; i += 1) {
      const src = i + 8;
      expect(col.read(i)).toBe(src % 8 === 0 ? undefined : 100 + src * 0.5);
    }
  });

  it('declines an int32 column with nulls (nothing to adopt)', () => {
    const n = 40;
    const close = vectorFromArray(
      Array.from({ length: n }, (_, i) => (i % 5 === 0 ? null : i * 3)),
      new Int32(),
    );
    const s = seriesOf(n, close as never);
    const col = s.column('close' as never) as unknown as Float64Column;
    for (let i = 0; i < n; i += 1) {
      expect(col.read(i)).toBe(i % 5 === 0 ? undefined : i * 3);
    }
  });

  it('declines when a non-null cell holds NaN, keeping NaN-as-gap', () => {
    // The semantics gate. Every other numeric intake maps a defined NaN to
    // a gap; adopting would leave it *defined*, so the same table would
    // ingest differently depending on whether adoption was possible.
    const n = 40;
    const raw = Array.from<number | null>({ length: n }).map((_, i) =>
      i % 5 === 0 ? null : i * 1.5,
    );
    raw[7] = NaN; // defined, but not finite
    const close = vectorFromArray(raw, new Float64());
    const s = seriesOf(n, close);
    const col = s.column('close' as never) as unknown as Float64Column;

    expect(col.read(7)).toBeUndefined(); // NaN became a gap, as always
    expect(col.read(5)).toBeUndefined(); // the real null
    expect(col.read(6)).toBe(9);
    expect(col.validity?.bits).not.toBe(close.data[0]!.nullBitmap);
  });

  it('declines when sorting, and sorts correctly', () => {
    // Sorting permutes rows into fresh buffers — nothing left to adopt.
    const n = 32;
    const time = makeVector(
      Float64Array.from({ length: n }, (_, i) => (n - 1 - i) * MINUTE),
    );
    const close = vectorFromArray(
      Array.from({ length: n }, (_, i) => (i % 4 === 0 ? null : i)),
      new Float64(),
    );
    const s = TimeSeries.fromArrow(new Table({ time, close }) as never, {
      sort: true,
    });
    const col = s.column('close' as never) as unknown as Float64Column;
    // Row j after sorting is source row n-1-j.
    for (let j = 0; j < n; j += 1) {
      const src = n - 1 - j;
      expect(col.read(j)).toBe(src % 4 === 0 ? undefined : src);
    }
  });

  it('handles an all-null column', () => {
    const n = 24;
    const close = vectorFromArray(
      Array.from({ length: n }, () => null),
      new Float64(),
    );
    const s = seriesOf(n, close);
    const col = s.column('close' as never) as unknown as Float64Column;
    expect(col.nullCount()).toBe(n);
    expect(col.mean()).toBeUndefined();
    expect(col.sum()).toBe(0);
  });

  it('leaves a dense column on its existing adopt path', () => {
    const n = 64;
    const close = makeVector(
      Float64Array.from({ length: n }, (_, i) => i + 0.25),
    );
    const s = seriesOf(n, close as never);
    const col = s.column('close' as never) as unknown as Float64Column;
    expect(col.validity).toBeUndefined();
    expect(col.allFinite).toBe(true);
    expect(col.read(3)).toBe(3.25);
  });

  it('still rejects an unsupported column kind by name', () => {
    const n = 8;
    const s = () =>
      TimeSeries.fromArrow(
        new Table({
          time: timeVector(n),
          tag: vectorFromArray(
            Array.from({ length: n }, () => 'a'),
            new Utf8(),
          ),
          bad: makeVector(
            makeData({
              type: new Float64(),
              length: n,
              data: new Float64Array(n),
            }),
          ),
        }) as never,
        { columns: ['nope'] },
      );
    expect(s).toThrow(/nope/);
  });
});

describe('[PND-ARROWNULL] error messages name the door', () => {
  it('an out-of-order table blames fromArrow, not fromColumns', () => {
    const n = 4;
    const time = makeVector(new Float64Array([0, 3 * MINUTE, MINUTE, 9e5]));
    const close = makeVector(Float64Array.from({ length: n }, (_, i) => i));
    expect(() =>
      TimeSeries.fromArrow(new Table({ time, close }) as never),
    ).toThrow(/fromArrow: key column/);
  });
});

describe('[PND-TOARROW] round trip through real apache-arrow', () => {
  it('toArrow → Table → fromArrow shares the original buffers', () => {
    // The pair's reason to exist, end to end: export, assemble a REAL
    // Arrow Table from the handed-over buffers, re-import — and the
    // resulting series is backed by the ORIGINAL series' storage. Not
    // "equal": the same memory, a full trip through Arrow with zero
    // copies in either direction (nulls included, which is what
    // [PND-ARROWNULL] bought).
    const n = 96;
    const s = seriesOf(n, nulledFloats(n, 8));
    const out = s.toArrow();

    const time = out.fields.find((f) => f.name === 'time')!;
    const close = out.fields.find((f) => f.name === 'close')!;
    const table = new Table({
      time: makeVector(
        makeData({
          type: new Float64(),
          length: time.length,
          data: time.values as Float64Array,
        }),
      ),
      close: makeVector(
        makeData({
          type: new Float64(),
          length: close.length,
          nullCount: close.nullCount,
          nullBitmap: close.nullBitmap,
          data: close.values as Float64Array,
        }),
      ),
    });

    const s2 = TimeSeries.fromArrow(table as never);
    const c1 = s.column('close' as never) as unknown as Float64Column;
    const c2 = s2.column('close' as never) as unknown as Float64Column;

    // The value column survives as the SAME object: the null path adopts
    // `chunk.values` directly, and `makeData` stored our exported array
    // as-is.
    expect(c2._values).toBe(c1._values);
    // The key and the bitmap share MEMORY, not object identity. The dense
    // key goes through `vector.toArray()`, which re-wraps a view per call;
    // the bitmap is Arrow-allocated 64-byte-aligned, trimmed to ceil(n/8)
    // by `toArrow`'s subarray, then wrapped again by `makeData`. Several
    // typed-array objects — one `ArrayBuffer` each. Asserting the buffer
    // is what "zero-copy" actually means.
    expect(s2.keyColumn().begin.buffer).toBe(s.keyColumn().begin.buffer);
    expect(s2.keyColumn().begin.byteOffset).toBe(0);
    expect(c2.validity?.bits.buffer).toBe(c1.validity?.bits.buffer);
    expect(c2.validity?.bits.byteOffset).toBe(0);

    // And the cells agree — the identity assertions above are only
    // meaningful if the round-tripped series also *reads* correctly.
    for (let i = 0; i < n; i += 1) {
      expect(c2.read(i)).toBe(c1.read(i));
    }
  });
});
