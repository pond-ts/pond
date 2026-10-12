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
 * [PND-ARROWNULL] — bulk intake of a **null-bearing** numeric column.
 *
 * `fromArrow` adopts a `Float64Array` values buffer when `nullCount === 0`.
 * A column carrying nulls used to fall to a per-element `vector.get(i)`
 * walk — ~10× slower than the dense path. [PND-ARROWNULL] adopted both of
 * Arrow's buffers instead; since [PND-NANREP] a number column marks a
 * missing cell with `NaN` in its own buffer and keeps no bitmap, so the
 * null path now **copies** the values buffer once and writes `NaN` behind
 * each null bit. Still a bulk copy, never the per-element walk.
 *
 * Two things need pinning:
 *
 * 1. **It copies, and does not write into the caller's table.** Writing
 *    `NaN` into Arrow's own buffer would corrupt the caller's data, so the
 *    test mutates Arrow's buffer afterwards and checks the series did not
 *    see it, and checks Arrow's null slots were left alone.
 * 2. **Every decline path still produces the same answer.** The bulk copy
 *    is refused for several distinct reasons; each has to land on the
 *    fallback and agree with it cell for cell. A wrong answer here is
 *    silent.
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

describe('[PND-ARROWNULL] bulk copy of a null-bearing column', () => {
  it('copies the values buffer — later writes to Arrow are not visible', () => {
    // The copy is what keeps the NaN stamping below from reaching the
    // caller's table. Prove it: mutate Arrow's buffer after construction
    // and the series still reads the original value.
    const n = 64;
    const close = nulledFloats(n, 8);
    const s = seriesOf(n, close);
    const col = s.column('close' as never) as unknown as Float64Column;

    expect(col.read(1)).toBe(100.5);
    (close.data[0]!.values as Float64Array)[1] = -42;
    expect(col.read(1)).toBe(100.5);
  });

  it("writes NaN at null slots in its own copy, not in Arrow's buffer", () => {
    const n = 64;
    const close = nulledFloats(n, 8);
    const arrowValues = close.data[0]!.values as Float64Array;
    const before = arrowValues[0];
    const s = seriesOf(n, close);
    const col = s.column('close' as never) as unknown as Float64Column;
    expect(Number.isNaN(col._values[0])).toBe(true);
    expect(Object.is(arrowValues[0], before)).toBe(true);
  });

  it('is not allFinite (it has gaps) and counts them', () => {
    const n = 1000;
    const s = seriesOf(n, nulledFloats(n, 25));
    const col = s.column('close' as never) as unknown as Float64Column;
    expect(col.allFinite).toBe(false);
    expect(col.nullCount()).toBe(40);
    expect(col.length).toBe(n);
  });

  it('reads the same cells the per-element path would', () => {
    // The main correctness check: the null bitmap is walked a byte at a
    // time, so every cell is checked (not a sample) on a length that is
    // not a multiple of 8.
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

describe('[PND-ARROWNULL] other shapes still get the right answer', () => {
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

  it('a non-null cell holding NaN is a gap, like every other intake', () => {
    // Every numeric intake maps a defined NaN to a gap; the bulk copy must
    // agree, so the same table ingests the same way whichever path runs.
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
      ordering: 'reorder',
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
  it('toArrow → Table → fromArrow shares the key, copies a gappy column', () => {
    // End to end: export, assemble a REAL Arrow Table from the handed-over
    // buffers, re-import. The dense key comes back on the ORIGINAL
    // series' memory. A number column with nulls is copied on the way in
    // (pond stores its gaps as NaN, so it cannot adopt Arrow's buffer
    // without writing into it — [PND-NANREP]); its cells must still agree.
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

    // The gappy value column is a copy (see above).
    expect(c2._values).not.toBe(c1._values);
    // The key shares MEMORY, not object identity: the dense key goes
    // through `vector.toArray()`, which re-wraps a view per call.
    // Asserting the buffer is what "zero-copy" actually means.
    expect(s2.keyColumn().begin.buffer).toBe(s.keyColumn().begin.buffer);
    expect(s2.keyColumn().begin.byteOffset).toBe(0);

    // And the cells agree.
    for (let i = 0; i < n; i += 1) {
      expect(c2.read(i)).toBe(c1.read(i));
    }
  });
});
