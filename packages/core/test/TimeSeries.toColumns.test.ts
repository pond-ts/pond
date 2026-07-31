import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries, ValidationError } from '../src/index.js';

/**
 * `TimeSeries.toColumns` — the columnar-JSON door out, and the exact inverse
 * of `fromColumns`, which had been a one-way door since it shipped. Same
 * exporter the `ValueSeries` side already uses (`operators/to-columns.ts`), so
 * what these pin is the time-key half: the envelope shape, the gap spelling,
 * the round trip, and the two-edged-key refusal.
 */

const OHLC = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
  { name: 'symbol', kind: 'string' },
] as const;

const SPARSE = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number', required: false },
  { name: 'symbol', kind: 'string', required: false },
] as const;

function bars() {
  return new TimeSeries({
    name: 'bars',
    schema: OHLC,
    rows: [
      [0, 100, 'AAPL'],
      [60_000, 101, 'AAPL'],
      [120_000, 99, 'MSFT'],
    ],
  });
}

describe('TimeSeries.toColumns', () => {
  it('emits one array per column, the time key under its own name', () => {
    const out = bars().toColumns();
    expect(out.name).toBe('bars');
    expect(out.schema).toEqual(OHLC);
    expect(out.columns).toEqual({
      time: [0, 60_000, 120_000],
      close: [100, 101, 99],
      symbol: ['AAPL', 'AAPL', 'MSFT'],
    });
  });

  it('spells gaps as null, in numeric and string columns alike', () => {
    const series = new TimeSeries({
      name: 'gappy',
      schema: SPARSE,
      rows: [
        [0, undefined, 'AAPL'],
        [60_000, 101, undefined],
      ],
    });
    expect(series.toColumns().columns).toEqual({
      time: [0, 60_000],
      close: [null, 101],
      symbol: ['AAPL', null],
    });
  });

  it('round-trips back through fromColumns, cell for cell', () => {
    const series = new TimeSeries({
      name: 'gappy',
      schema: SPARSE,
      rows: [
        [0, 100, 'AAPL'],
        [60_000, undefined, 'AAPL'],
        [120_000, 99, undefined],
      ],
    });
    // No cast: `toColumns()`'s output type is assignable to `fromColumns`'s
    // input. That assignability IS the round-trip contract.
    const back = TimeSeries.fromColumns(series.toColumns());
    expect(back.name).toBe(series.name);
    expect(back.schema).toEqual(series.schema);
    expect(back.toRows()).toEqual(series.toRows());
  });

  it('survives a real JSON.stringify round trip', () => {
    const series = bars();
    const wire = JSON.parse(JSON.stringify(series.toColumns()));
    expect(TimeSeries.fromColumns(wire).toRows()).toEqual(series.toRows());
  });

  it('carries the same data as toJSON, transposed', () => {
    const series = bars();
    const { columns } = series.toColumns();
    const rows = series.toJSON().rows;
    for (let i = 0; i < series.length; i += 1) {
      expect([columns.time[i], columns.close[i], columns.symbol[i]]).toEqual(
        rows[i],
      );
    }
  });

  it('exports a derived series, not the source rows behind it', () => {
    const window = bars().slice(1, 3);
    expect(window.toColumns().columns).toEqual({
      time: [60_000, 120_000],
      close: [101, 99],
      symbol: ['AAPL', 'MSFT'],
    });
  });

  it('emits empty arrays for an empty series (still ingestable)', () => {
    const empty = bars().slice(0, 0);
    const out = empty.toColumns();
    expect(out.columns).toEqual({ time: [], close: [], symbol: [] });
    expect(TimeSeries.fromColumns(out).length).toBe(0);
  });

  it('emits boolean and array columns the ingest door cannot take back', () => {
    // Ordinary on a TimeSeries (unlike ValueSeries, where only a projection
    // introduces them). They export as valid JSON; the type — not a throw —
    // is what stops the round trip.
    const series = new TimeSeries({
      name: 'mixed',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'ok', kind: 'boolean' },
        { name: 'tags', kind: 'array' },
      ] as const,
      rows: [
        [0, true, ['a', 'b']],
        [60_000, false, ['c']],
      ],
    });
    expect(series.toColumns().columns).toEqual({
      time: [0, 60_000],
      ok: [true, false],
      tags: [['a', 'b'], ['c']],
    });
  });

  it('is a fresh payload, not a view onto live storage', () => {
    const series = bars();
    const out = series.toColumns();
    out.columns.close[0] = 999;
    expect(series.at(0)!.get('close')).toBe(100);
  });

  describe('two-edged keys flatten', () => {
    const aggregated = () =>
      bars().aggregate(Sequence.every('1m'), { close: 'avg' });

    it('an interval key exports as begin + end + label', () => {
      const series = aggregated();
      expect(series.schema[0]!.kind).toBe('interval');
      const out = series.toColumns();
      // The SCHEMA still declares the logical key…
      expect(out.schema[0]).toEqual({ name: 'interval', kind: 'interval' });
      // …while the COLUMNS carry the physical edges, named off it.
      expect(out.columns).toEqual({
        interval: [0, 60_000, 120_000],
        intervalEnd: [60_000, 120_000, 180_000],
        intervalLabel: [0, 60_000, 120_000],
        close: [100, 101, 99],
      });
    });

    it('a timeRange key exports as begin + end', () => {
      const out = bars().asTimeRange().toColumns();
      expect(out.schema[0]).toEqual({ name: 'timeRange', kind: 'timeRange' });
      expect(Object.keys(out.columns).sort()).toEqual([
        'close',
        'symbol',
        'timeRange',
        'timeRangeEnd',
      ]);
    });

    it('and both round-trip back through fromColumns, key and all', () => {
      for (const series of [aggregated(), bars().asTimeRange()]) {
        const back = TimeSeries.fromColumns(series.toColumns() as never);
        expect(back.schema).toEqual(series.schema);
        expect(back.toRows()).toEqual(series.toRows());
        // The key survives as the same kind, not collapsed to a point.
        expect(back.at(0)!.key().begin()).toBe(series.at(0)!.key().begin());
        expect(back.at(0)!.key().end()).toBe(series.at(0)!.key().end());
      }
    });

    it('survives JSON.stringify — the point of the flattened spelling', () => {
      const series = aggregated();
      const wire = JSON.parse(JSON.stringify(series.toColumns()));
      expect(TimeSeries.fromColumns(wire).toRows()).toEqual(series.toRows());
    });

    it('carries string interval labels too, not just numeric ones', () => {
      // `aggregate` labels buckets numerically; a hand-built interval series
      // is the string-label case, and the engine dict-encodes those.
      const labelled = new TimeSeries({
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
      const out = labelled.toColumns();
      expect(out.columns.intervalLabel).toEqual(['morning', 'evening']);
      const back = TimeSeries.fromColumns(out as never);
      expect(back.toRows()).toEqual(labelled.toRows());
    });

    it('matches what toArrow emits — one convention, two formats', () => {
      const series = aggregated();
      const arrowNames = series.toArrow().fields.map((f) => f.name);
      const columnNames = Object.keys(series.toColumns().columns);
      expect(new Set(columnNames)).toEqual(new Set(arrowNames));
    });

    it('refuses to EXPORT a series whose value column collides', () => {
      // The row door builds such a series happily, so this is reachable. The
      // first cut of this PR wrote the key edges first and let the value-column
      // loop overwrite them — emitting a payload that contradicted its own
      // schema, with the end edge silently gone (Layer-2 review of #567).
      // `toArrow` throws on the same series; these two must agree.
      const clashing = new TimeSeries({
        name: 'clash',
        schema: [
          { name: 'timeRange', kind: 'timeRange' },
          { name: 'timeRangeEnd', kind: 'number' },
        ] as const,
        rows: [
          [[0, 60_000], 7],
          [[60_000, 120_000], 8],
        ],
      });
      const fail = () => clashing.toColumns();
      expect(fail).toThrow(ValidationError);
      expect(fail).toThrow(
        /value column 'timeRangeEnd' collides with the second edge/,
      );
      expect(() => clashing.toArrow()).toThrow(/would appear twice/);
    });

    it('rejects a value column colliding with a synthesized edge name', () => {
      // One array cannot serve both the key's second edge and a value column.
      const fail = () =>
        TimeSeries.fromColumns({
          name: 'clash',
          schema: [
            { name: 'timeRange', kind: 'timeRange' },
            { name: 'timeRangeEnd', kind: 'number' },
          ] as const,
          columns: { timeRange: [0], timeRangeEnd: [1] },
        });
      expect(fail).toThrow(ValidationError);
      expect(fail).toThrow(
        /value column 'timeRangeEnd' collides with the second edge/,
      );
    });
  });
});
