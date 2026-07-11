import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import { transposeRow } from '../src/data.js';

/** A wide series: time key + two numeric ticker columns + a non-numeric column. */
const wide = () =>
  new TimeSeries({
    name: 'w',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'AAPL', kind: 'number' },
      { name: 'MSFT', kind: 'number' },
      { name: 'note', kind: 'string' },
    ] as const,
    rows: [
      [0, 10, 20, 'a'],
      [1, 15, 25, 'b'],
      [2, 12, 22, 'c'],
    ] as never,
  });

describe('transposeRow', () => {
  it('reads the last row across into numeric columns (default at="last")', () => {
    // The non-numeric `note` column is excluded.
    expect(transposeRow(wide())).toEqual([
      { label: 'AAPL', value: 12 },
      { label: 'MSFT', value: 22 },
    ]);
  });

  it('reads the first row with at="first"', () => {
    expect(transposeRow(wide(), { at: 'first' })).toEqual([
      { label: 'AAPL', value: 10 },
      { label: 'MSFT', value: 20 },
    ]);
  });

  it('reads a row by index (and a negative index from the end)', () => {
    expect(transposeRow(wide(), { at: 1 }).map((d) => d.value)).toEqual([
      15, 25,
    ]);
    expect(transposeRow(wide(), { at: -1 }).map((d) => d.value)).toEqual([
      12, 22,
    ]);
  });

  it('reads the row nearest a time key with at={time}', () => {
    expect(
      transposeRow(wide(), { at: { time: 1 } }).map((d) => d.value),
    ).toEqual([15, 25]);
  });

  it('honours a declared column subset, in order', () => {
    expect(transposeRow(wide(), { columns: ['MSFT', 'AAPL'] })).toEqual([
      { label: 'MSFT', value: 22 },
      { label: 'AAPL', value: 12 },
    ]);
  });

  it('reads a missing / non-numeric named column as a gap (NaN)', () => {
    const out = transposeRow(wide(), { columns: ['AAPL', 'nope', 'note'] });
    expect(out[0]).toEqual({ label: 'AAPL', value: 12 });
    expect(Number.isNaN(out[1]!.value)).toBe(true); // unknown column
    expect(Number.isNaN(out[2]!.value)).toBe(true); // string column
  });

  it('returns [] for an empty series', () => {
    const empty = new TimeSeries({
      name: 'e',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'AAPL', kind: 'number' },
      ] as const,
      rows: [] as never,
    });
    expect(transposeRow(empty)).toEqual([]);
  });
});
