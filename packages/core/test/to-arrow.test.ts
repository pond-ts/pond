import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries } from '../src/index.js';
import type { ArrowExportField } from '../src/index.js';
import type { Float64Column, StringColumn } from '../src/columnar/index.js';

/**
 * [PND-TOARROW] — zero-copy export to the Arrow memory layout.
 *
 * The claim under test is **"nothing is copied"**, and it is the easiest
 * kind of claim to lose silently: a stray `new Float64Array(...)` still
 * produces correct-looking output. So the load-bearing assertions here are
 * buffer *identity* (`toBe`, not `toEqual`) against the series' own storage
 * — every field that says it is zero-copy must hand back the very object
 * pond is holding.
 *
 * The rest pins the shape decisions Arrow forces on us: a two-edged key
 * becomes two flat fields, a dict-encoded string column keeps its indices,
 * and the two paths that genuinely cannot be zero-copy are the two that
 * say so.
 */

const MINUTE = 60_000;

function byName(
  fields: readonly ArrowExportField[],
  name: string,
): ArrowExportField {
  const f = fields.find((x) => x.name === name);
  if (f === undefined)
    throw new Error(
      `no field '${name}' in ${fields.map((x) => x.name).join(', ')}`,
    );
  return f;
}

function numericSeries(n: number, gapEvery = 0) {
  return TimeSeries.fromColumns({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
      { name: 'volume', kind: 'number' },
    ] as const,
    columns: {
      time: Float64Array.from({ length: n }, (_, i) => i * MINUTE),
      close: Array.from({ length: n }, (_, i) =>
        gapEvery > 0 && i % gapEvery === 0 ? null : 100 + i,
      ),
      volume: Float64Array.from({ length: n }, (_, i) => i * 10),
    },
  });
}

describe('toArrow — nothing is copied', () => {
  it('hands back the column s own values buffer, not a copy', () => {
    const s = numericSeries(64);
    const col = s.column('close') as unknown as Float64Column;
    const f = byName(s.toArrow().fields, 'close');
    expect(f.type).toBe('float64');
    // Identity, not equality — a copy would pass `toEqual` and fail this.
    expect(f.values).toBe(col._values);
  });

  it('hands back the validity bitmap itself', () => {
    const s = numericSeries(64, 8);
    const col = s.column('close') as unknown as Float64Column;
    const f = byName(s.toArrow().fields, 'close');
    expect(f.nullBitmap).toBe(col.validity?.bits);
    expect(f.nullCount).toBe(8);
  });

  it('hands back the key buffer itself', () => {
    const s = numericSeries(32);
    const f = byName(s.toArrow().fields, 'time');
    expect(f.type).toBe('timestamp');
    expect(f.values).toBe(s.keyColumn().begin);
  });

  it('omits the bitmap entirely when every cell is defined', () => {
    // pond's "all defined ⇒ no bitmap" convention, which Arrow allows too.
    const f = byName(numericSeries(32).toArrow().fields, 'close');
    expect(f.nullBitmap).toBeUndefined();
    expect(f.nullCount).toBe(0);
  });
});

describe('toArrow — shape', () => {
  it('reports length and every field in schema order', () => {
    const { length, fields } = numericSeries(10).toArrow();
    expect(length).toBe(10);
    expect(fields.map((f) => f.name)).toEqual(['time', 'close', 'volume']);
    for (const f of fields) expect(f.length).toBe(10);
  });

  it('selects a subset, in the order asked for', () => {
    const { fields } = numericSeries(10).toArrow({
      columns: ['volume'],
    });
    // The key always rides along — without it the rows line up against
    // nothing.
    expect(fields.map((f) => f.name)).toEqual(['time', 'volume']);
  });

  it('throws by name on a column that is not there', () => {
    expect(() => numericSeries(4).toArrow({ columns: ['nope'] })).toThrow(
      /toArrow: column 'nope' not found/,
    );
  });

  it('exports a boolean column as a packed bitmap, zero-copy', () => {
    // BooleanColumn already stores LSB-first packed bits — Arrow `Bool`.
    const s = TimeSeries.fromJSON({
      name: 'flags',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'ok', kind: 'boolean' },
      ] as const,
      rows: [
        [0, true],
        [MINUTE, false],
        [2 * MINUTE, true],
      ],
    });
    const f = byName(s.toArrow().fields, 'ok');
    expect(f.type).toBe('bool');
    const col = s.column('ok') as unknown as { values: Uint8Array };
    expect(f.values).toBe(col.values);
  });
});

describe('toArrow — string columns', () => {
  it('exports a dict-encoded column as Arrow Dictionary, indices zero-copy', () => {
    // Few distinct values over many rows ⇒ pond dict-encodes, which is
    // Arrow's Dictionary<Int32, Utf8> already.
    const n = 200;
    const s = TimeSeries.fromColumns({
      name: 'hosts',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'host', kind: 'string' },
      ] as const,
      columns: {
        time: Float64Array.from({ length: n }, (_, i) => i * MINUTE),
        host: Array.from({ length: n }, (_, i) => `h${i % 3}`),
      },
    });
    const col = s.column('host') as unknown as StringColumn;
    const f = byName(s.toArrow().fields, 'host');
    if (f.type !== 'dictionary')
      throw new Error(`expected dictionary, got ${f.type}`);
    expect(f.values).toBe(col.indices);
    expect(f.dictionary).toBe(col.dictionary);
    expect([...f.dictionary].sort()).toEqual(['h0', 'h1', 'h2']);
  });

  it('exports a non-dict-encoded column as utf8, with gaps as null', () => {
    // All-distinct values ⇒ no dictionary ⇒ a plain array, the one shape
    // that genuinely is not zero-copy. `undefined` (a pond gap) becomes
    // `null`, which is what an Arrow consumer reads alongside the bitmap.
    const s = TimeSeries.fromColumns({
      name: 'ids',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'id', kind: 'string' },
      ] as const,
      columns: {
        time: Float64Array.from({ length: 4 }, (_, i) => i * MINUTE),
        id: ['a', null, 'c', 'd'],
      },
    });
    const f = byName(s.toArrow().fields, 'id');
    if (f.type !== 'utf8') throw new Error(`expected utf8, got ${f.type}`);
    expect(f.values).toEqual(['a', null, 'c', 'd']);
    expect(f.nullCount).toBe(1);
    expect(f.nullBitmap).toBeDefined();
  });
});

describe('toArrow — two-edged keys', () => {
  const aggregated = () =>
    numericSeries(120).aggregate(Sequence.every('10m'), {
      close: { from: 'close', using: 'avg' },
    });

  it('splits an interval key into begin, end and label fields', () => {
    // Arrow has no interval-of-time type, so a two-edged pond key has to
    // become two flat fields; the labels are part of the key's identity
    // for an aggregate result, so they ride along too. (An aggregate
    // result's key column is named `interval`.)
    const s = aggregated();
    const { fields } = s.toArrow();
    expect(fields.map((f) => f.name)).toEqual([
      'interval',
      'intervalEnd',
      'close',
      'intervalLabel',
    ]);
    expect(byName(fields, 'interval').values).toBe(s.keyColumn().begin);
    expect(byName(fields, 'intervalEnd').values).toBe(s.keyColumn().end);
  });

  it('begin and end differ, and bound each row', () => {
    const s = aggregated();
    const { fields, length } = s.toArrow();
    const begin = byName(fields, 'interval').values as Float64Array;
    const end = byName(fields, 'intervalEnd').values as Float64Array;
    expect(begin.length).toBe(length);
    for (let i = 0; i < length; i += 1) {
      expect(end[i]! - begin[i]!).toBe(10 * MINUTE);
    }
  });

  it('throws rather than emitting two fields with the same name', () => {
    // A value column literally called `intervalEnd` would collide with the
    // synthesized edge. Arrow tolerates duplicate field names; `getChild`
    // then silently picks one, which is worse than an error here.
    const s = numericSeries(120).aggregate(Sequence.every('10m'), {
      intervalEnd: { from: 'close', using: 'avg' },
    });
    expect(() => s.toArrow()).toThrow(/would appear twice/);
  });

  it('throws on a duplicate columns entry (Layer-2 review find)', () => {
    // ['close', 'close'] used to sail through and emit two identical
    // fields — exactly the silent-duplicate outcome the collision error
    // exists to prevent. `taken` now grows as names are claimed.
    expect(() =>
      numericSeries(8).toArrow({ columns: ['close', 'close'] }),
    ).toThrow(/would appear twice/);
  });

  it('throws when a requested column collides with the label field', () => {
    const s = numericSeries(120).aggregate(Sequence.every('10m'), {
      intervalLabel: { from: 'close', using: 'avg' },
    });
    expect(() => s.toArrow()).toThrow(/interval labels export as/);
  });
});

describe('toArrow — store-level paths (storeToArrow)', () => {
  // These exercise storeToArrow directly on hand-built stores — the shapes
  // TimeSeries construction doesn't reach from public doors in this file:
  // chunked storage (materializes — the one named copy) and numeric
  // interval labels.

  it('materializes a chunked column — correct values, necessarily a copy', async () => {
    const { storeToArrow } = await import('../src/batch/operators/to-arrow.js');
    const { ColumnarStore, concatSorted, float64ColumnFromArray } =
      await import('../src/columnar/index.js');
    const { timeKeyColumnFromArray } = await import('../src/columnar/index.js');
    const part = (times: number[], values: number[]) =>
      ColumnarStore.fromTrustedStore(
        [
          { name: 'time', kind: 'time' },
          { name: 'v', kind: 'number' },
        ] as const,
        timeKeyColumnFromArray(times),
        new Map([['v', float64ColumnFromArray(values)]]),
      );
    const chunked = concatSorted([
      part([1000, 2000], [1.5, 2.5]),
      part([3000, 4000], [3.5, 4.5]),
    ]);
    expect(chunked.columns.get('v')!.storage).toBe('chunked'); // guard

    const { fields } = storeToArrow(chunked);
    const f = fields.find((x) => x.name === 'v')!;
    if (f.type !== 'float64')
      throw new Error(`expected float64, got ${f.type}`);
    expect([...f.values]).toEqual([1.5, 2.5, 3.5, 4.5]);
    expect(f.nullCount).toBe(0);
  });

  it('exports numeric interval labels as a float64 field', async () => {
    const { storeToArrow } = await import('../src/batch/operators/to-arrow.js');
    const { ColumnarStore, Float64Column, IntervalKeyColumn } =
      await import('../src/columnar/index.js');
    const n = 3;
    const begin = new Float64Array([0, 1000, 2000]);
    const end = new Float64Array([1000, 2000, 3000]);
    const labels = new Float64Column(new Float64Array([7, 8, 9]), n);
    const store = ColumnarStore.fromTrustedStore(
      [
        { name: 'interval', kind: 'interval' },
        { name: 'v', kind: 'number' },
      ] as const,
      new IntervalKeyColumn(begin, end, labels, n),
      new Map([
        [
          'v',
          new Float64Column(new Float64Array([1, 2, 3]), n, undefined, true),
        ],
      ]),
    );
    const { fields } = storeToArrow(store);
    const label = fields.find((x) => x.name === 'intervalLabel')!;
    if (label.type !== 'float64')
      throw new Error(`expected float64 labels, got ${label.type}`);
    expect(label.values).toBe(labels._values); // zero-copy, same as any numeric
    expect([...label.values]).toEqual([7, 8, 9]);
  });
});
