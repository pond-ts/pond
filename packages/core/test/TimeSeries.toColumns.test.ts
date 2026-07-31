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

  describe('two-edged keys', () => {
    const aggregated = () =>
      bars().aggregate(Sequence.every('1m'), { close: 'avg' });

    it('refuses an interval key, naming both ways out', () => {
      const series = aggregated();
      expect(series.schema[0]!.kind).toBe('interval');
      const fail = () => series.toColumns();
      expect(fail).toThrow(ValidationError);
      expect(fail).toThrow(/the 'interval' key spans two edges/);
      expect(fail).toThrow(/asTime\(\{ at: 'begin' \}\)/);
      expect(fail).toThrow(/toJSON\(\)/);
    });

    it('refuses a timeRange key', () => {
      const ranged = bars().asTimeRange();
      expect(() => ranged.toColumns()).toThrow(
        /the 'timeRange' key spans two edges/,
      );
    });

    it('…and the named remedy actually works', () => {
      const collapsed = aggregated().asTime({ at: 'begin' });
      const out = collapsed.toColumns();
      expect(out.columns.time).toEqual([0, 60_000, 120_000]);
      expect(TimeSeries.fromColumns(out).toRows()).toEqual(collapsed.toRows());
    });

    it('…as does the other one (toJSON carries interval keys)', () => {
      const json = aggregated().toJSON();
      // The row envelope spells an interval key `[value, start, end]`.
      expect(Array.isArray(json.rows[0]![0])).toBe(true);
      expect(TimeSeries.fromJSON(json as never).length).toBe(3);
    });
  });
});
