import { describe, expect, it } from 'vitest';
import {
  Table,
  Timestamp,
  TimeUnit,
  DateDay,
  Float64,
  Int64,
  Utf8,
  makeData,
  makeVector,
  vectorFromArray,
  tableFromArrays,
  tableFromIPC,
  tableToIPC,
} from 'apache-arrow';
import { Sequence, TimeSeries } from '../src/index.js';

// Integration tests against REAL apache-arrow — the structural fakes in
// from-arrow.test.ts can't validate what apache-arrow's `Vector.toArray()`
// actually returns per column kind (int64 → BigInt64Array raw-unit; Date →
// Array<number> epoch-ms; Utf8 → Array<string>), which is exactly what the
// duck-typed reader depends on. This file pins those runtime contracts.

/** A real Timestamp(unit) vector backed by raw int64 values in that unit. */
function timestampVector(raw: bigint[], unit: TimeUnit) {
  return makeVector(
    makeData({
      type: new Timestamp(unit),
      length: raw.length,
      data: BigInt64Array.from(raw),
    }),
  );
}

function readKeys(series: ReturnType<typeof TimeSeries.fromArrow>): number[] {
  return Array.from({ length: series.length }, (_, i) =>
    series.at(i)!.key().begin(),
  );
}

function readCol(
  series: ReturnType<typeof TimeSeries.fromArrow>,
  name: string,
): Array<number | string | undefined> {
  const c = series.column(name as never);
  return Array.from({ length: series.length }, (_, i) => c.at(i));
}

describe('TimeSeries.fromArrow — real apache-arrow tables', () => {
  it('ingests a Timestamp(ms) key + Float64 + Utf8 columns', () => {
    const table = new Table({
      time: timestampVector(
        [1_700_000_000_000n, 1_700_000_001_000n, 1_700_000_002_000n],
        TimeUnit.MILLISECOND,
      ),
      price: vectorFromArray([100, 200, 300], new Float64()),
      symbol: vectorFromArray(['AAPL', 'MSFT', 'AAPL'], new Utf8()),
    });
    const series = TimeSeries.fromArrow(table);
    expect(series.length).toBe(3);
    expect(series.schema.map((c) => [c.name, c.kind])).toEqual([
      ['time', 'time'],
      ['price', 'number'],
      ['symbol', 'string'],
    ]);
    expect(readKeys(series)).toEqual([
      1_700_000_000_000, 1_700_000_001_000, 1_700_000_002_000,
    ]);
    expect(readCol(series, 'price')).toEqual([100, 200, 300]);
    expect(readCol(series, 'symbol')).toEqual(['AAPL', 'MSFT', 'AAPL']);
  });

  it('scales a real Timestamp(second) key to ms', () => {
    const table = new Table({
      time: timestampVector([1_700_000_000n, 1_700_000_060n], TimeUnit.SECOND),
      v: vectorFromArray([1, 2], new Float64()),
    });
    expect(readKeys(TimeSeries.fromArrow(table))).toEqual([
      1_700_000_000_000, 1_700_000_060_000,
    ]);
  });

  it('scales a real Timestamp(microsecond) key to ms', () => {
    const table = new Table({
      time: timestampVector([1_700_000_000_000_000n], TimeUnit.MICROSECOND),
      v: vectorFromArray([1], new Float64()),
    });
    expect(readKeys(TimeSeries.fromArrow(table))).toEqual([1_700_000_000_000]);
  });

  it('reads a real Date32 (DateDay) key as epoch-ms (not days, not seconds)', () => {
    // The bug the reviews caught: Date32 must NOT be scaled by a unit. Arrow's
    // toArray() already yields epoch-ms numbers; fromArrow must pass them
    // through. 2023-12-04 / 2023-12-05 UTC.
    const d1 = Date.UTC(2023, 11, 4);
    const d2 = Date.UTC(2023, 11, 5);
    const table = new Table({
      time: vectorFromArray([new Date(d1), new Date(d2)], new DateDay()),
      v: vectorFromArray([1, 2], new Float64()),
    });
    expect(readKeys(TimeSeries.fromArrow(table))).toEqual([d1, d2]);
  });

  it('ingests a real Int64 value column (BigInt-free path)', () => {
    const table = new Table({
      time: timestampVector(
        [1_700_000_000_000n, 1_700_000_001_000n],
        TimeUnit.MILLISECOND,
      ),
      count: vectorFromArray([10n, 20n], new Int64()),
    });
    expect(readCol(TimeSeries.fromArrow(table), 'count')).toEqual([10, 20]);
  });

  it('round-trips through IPC (tableFromIPC → fromArrow)', () => {
    const source = tableFromArrays({
      time: Float64Array.from([0, 1000, 2000]),
      value: Float64Array.from([1.5, 2.5, 3.5]),
    });
    const bytes = tableToIPC(source, 'stream');
    const series = TimeSeries.fromArrow(tableFromIPC(bytes));
    expect(readKeys(series)).toEqual([0, 1000, 2000]);
    expect(readCol(series, 'value')).toEqual([1.5, 2.5, 3.5]);
  });

  it('handles a multi-record-batch table (multi-chunk columns copy, stay correct)', () => {
    // Concatenating two same-schema tables' batches yields multi-chunk columns
    // — the case where toArray() concatenates into a fresh array rather than
    // handing back a single backing buffer. Must still ingest correctly.
    const mk = (t0: number) =>
      tableFromArrays({
        time: Float64Array.from([t0, t0 + 1000]),
        value: Float64Array.from([t0, t0 + 1000]),
      });
    const a = mk(0);
    const b = mk(2000);
    const multi = new Table([...a.batches, ...b.batches]);
    // Sanity: this really is multi-chunk.
    expect(multi.getChild('time')!.data.length).toBeGreaterThan(1);
    const series = TimeSeries.fromArrow(multi);
    expect(readKeys(series)).toEqual([0, 1000, 2000, 3000]);
    expect(readCol(series, 'value')).toEqual([0, 1000, 2000, 3000]);
  });

  it('maps real Utf8 nulls to missing', () => {
    const table = new Table({
      time: timestampVector(
        [1_700_000_000_000n, 1_700_000_001_000n, 1_700_000_002_000n],
        TimeUnit.MILLISECOND,
      ),
      label: vectorFromArray(['a', null, 'c'], new Utf8()),
    });
    expect(readCol(TimeSeries.fromArrow(table), 'label')).toEqual([
      'a',
      undefined,
      'c',
    ]);
  });
});

describe('[PND-FLATKEY] two-edged keys round-trip through Arrow', () => {
  // `toArrow` has always flattened a two-edged key into `<key>` + `<key>End`
  // (+ `<key>Label`) because Arrow has no interval-of-time type — but nothing
  // read that shape back, so the pair was one-way for anything but a point
  // key. `{ keyKind }` closes it, using the same convention the JSON columnar
  // doors now speak.
  function ranged() {
    return new TimeSeries({
      name: 'ranges',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'load', kind: 'number' },
      ] as const,
      rows: [
        [[0, 60_000], 1],
        [[60_000, 120_000], 2],
      ],
    });
  }

  function assembled(series: ReturnType<typeof ranged>) {
    const out = series.toArrow();
    const entries: Record<string, ReturnType<typeof makeVector>> = {};
    for (const f of out.fields) {
      if (f.type === 'float64' || f.type === 'timestamp') {
        entries[f.name] = makeVector(
          makeData({
            type: new Float64(),
            length: f.length,
            nullCount: f.nullCount,
            nullBitmap: f.nullBitmap,
            data: f.values as Float64Array,
          }),
        );
      } else if (f.type === 'dictionary') {
        // Dict-encoded strings hand over Int32 indices plus the dictionary —
        // resolve them here, since this helper is standing in for whatever
        // real Arrow assembly a consumer would write.
        const dict = f.dictionary;
        entries[f.name] = vectorFromArray(
          Array.from(f.values, (i) => dict[i]!),
          new Utf8(),
        );
      } else {
        entries[f.name] = vectorFromArray(
          (f as { values: ReadonlyArray<string | null> }).values.map(
            (v) => v ?? '',
          ),
          new Utf8(),
        );
      }
    }
    return new Table(entries);
  }

  it('toArrow → Table → fromArrow({ keyKind: "timeRange" })', () => {
    const series = ranged();
    expect(series.toArrow().fields.map((f) => f.name)).toEqual([
      'timeRange',
      'timeRangeEnd',
      'load',
    ]);
    const back = TimeSeries.fromArrow(assembled(series) as never, {
      name: 'ranges',
      keyKind: 'timeRange',
    });
    expect(back.schema).toEqual(series.schema);
    expect(back.toRows()).toEqual(series.toRows());
  });

  it('an interval key round-trips with its labels', () => {
    const series = new TimeSeries({
      name: 'shifts',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'load', kind: 'number' },
      ] as const,
      rows: [
        [['morning', 0, 60_000], 1],
        [['evening', 60_000, 120_000], 2],
      ],
    });
    const back = TimeSeries.fromArrow(assembled(series as never) as never, {
      name: 'shifts',
      keyKind: 'interval',
    });
    expect(back.schema).toEqual(series.schema);
    expect(back.toRows()).toEqual(series.toRows());
  });

  it('is explicit, not sniffed — a stray `timeEnd` stays a value column', () => {
    // A table that merely carries `time` and `timeEnd` must NOT silently
    // become range-keyed; without `keyKind` the default point key stands and
    // `timeEnd` is read as an ordinary numeric column.
    const table = tableFromArrays({
      time: Float64Array.from([0, 1000]),
      timeEnd: Float64Array.from([500, 1500]),
    });
    const series = TimeSeries.fromArrow(table as never);
    expect(series.schema.map((c) => [c.name, c.kind])).toEqual([
      ['time', 'time'],
      ['timeEnd', 'number'],
    ]);
  });

  it('round-trips an AGGREGATED series — numeric interval labels', () => {
    // The case the option exists for, and the one the first cut of this PR
    // got wrong: `aggregate` labels buckets numerically, `toArrow` emits that
    // label column as float64, and the ingest engine was rejecting typed-array
    // labels outright. Both original Arrow interval tests used STRING labels,
    // which is exactly why it slipped through (Layer-2 review of #567).
    const agg = new TimeSeries({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 1],
        [30_000, 3],
        [60_000, 2],
      ],
    }).aggregate(Sequence.every('1m'), { v: 'avg' });

    const back = TimeSeries.fromArrow(assembled(agg as never) as never, {
      name: 'bars',
      keyKind: 'interval',
    });
    // Names and kinds round-trip; `required: false` does not, because an Arrow
    // field carries no such flag — `fromArrow` derives its schema from the
    // table, as its trust contract says. The KEY is what this test is about.
    expect(back.schema.map((c) => [c.name, c.kind])).toEqual(
      agg.schema.map((c) => [c.name, c.kind]),
    );
    expect(back.toRows()).toEqual(agg.toRows());
    expect(back.at(0)!.key().end()).toBe(agg.at(0)!.key().end());
  });

  it('refuses to key a two-edged kind off a differently-named field', () => {
    // The flattened names are derived from the kind, so a key named anything
    // else would mint a schema whose key name disagrees with its kind.
    const table = tableFromArrays({
      bucket: Float64Array.from([0]),
      bucketEnd: Float64Array.from([60_000]),
    });
    expect(() =>
      TimeSeries.fromArrow(table as never, {
        time: 'bucket',
        keyKind: 'timeRange',
      }),
    ).toThrow(/cannot name it — rename the table's fields/);
  });

  it('names the missing edge when a keyKind has nothing to read', () => {
    const table = tableFromArrays({ timeRange: Float64Array.from([0, 1000]) });
    expect(() =>
      TimeSeries.fromArrow(table as never, { keyKind: 'timeRange' }),
    ).toThrow(/key column 'timeRangeEnd' not found/);
  });
});
