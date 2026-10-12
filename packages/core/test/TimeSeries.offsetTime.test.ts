import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* offsetTime — move every key by a constant. Value columns pass through by    */
/* reference; the key kind, key name and labels are kept.                      */
/* -------------------------------------------------------------------------- */

const MIN = 60_000;

function bars() {
  return new TimeSeries({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number', required: false },
      { name: 'sym', kind: 'string' },
    ] as const,
    rows: [
      [0, 10, 'a'],
      [MIN, undefined, 'b'],
      [2 * MIN, 12, 'c'],
    ],
  });
}

function ranged() {
  return new TimeSeries({
    name: 'r',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [[0, 100], 1],
      [[50, 300], 2],
    ] as any,
  });
}

describe('offsetTime', () => {
  it('moves a time key by milliseconds, forward and back', () => {
    expect(Array.from(bars().offsetTime(MIN).keyColumn().begin)).toEqual([
      MIN,
      2 * MIN,
      3 * MIN,
    ]);
    expect(Array.from(bars().offsetTime(-500).keyColumn().begin)).toEqual([
      -500,
      MIN - 500,
      2 * MIN - 500,
    ]);
  });

  it('accepts duration strings, including a leading minus', () => {
    expect(bars().offsetTime('1m').keyColumn().begin[0]).toBe(MIN);
    expect(bars().offsetTime('-1h').keyColumn().begin[0]).toBe(-3_600_000);
  });

  it('keeps a point key a point: end is begin', () => {
    const k = bars().offsetTime('1m').keyColumn();
    expect(k.end).toBe(k.begin);
  });

  it('shares value columns by reference and keeps the schema', () => {
    const src = bars();
    const out = src.offsetTime('1m');
    expect(out.column('close')).toBe(src.column('close'));
    expect(out.column('sym')).toBe(src.column('sym'));
    expect(out.schema).toEqual(src.schema);
    expect(out.name).toBe('bars');
    expect(out.at(1)!.get('close')).toBeUndefined();
    expect(out.at(2)!.get('close')).toBe(12);
  });

  it('leaves the source untouched', () => {
    const src = bars();
    src.offsetTime('1m');
    expect(Array.from(src.keyColumn().begin)).toEqual([0, MIN, 2 * MIN]);
  });

  it('moves both edges of a timeRange key, keeping overlap', () => {
    const out = ranged().offsetTime(1000);
    expect(out.schema[0]).toEqual({ name: 'timeRange', kind: 'timeRange' });
    expect(Array.from(out.keyColumn().begin)).toEqual([1000, 1050]);
    expect(Array.from(out.keyColumn().end)).toEqual([1100, 1300]);
    expect(out.at(1)!.key().end()).toBe(1300);
  });

  it('moves an interval key and keeps its labels', () => {
    const iv = ranged().asInterval((_r, i) => `b${i}`);
    const out = iv.offsetTime('1s');
    expect(out.keyColumn().labels).toBe(iv.keyColumn().labels);
    expect(out.at(0)!.key().value).toBe('b0');
    expect(out.at(0)!.key().begin()).toBe(1000);
    expect(out.at(0)!.key().end()).toBe(1100);
  });

  it('returns the same series for a zero offset', () => {
    const src = bars();
    expect(src.offsetTime(0)).toBe(src);
    expect(src.offsetTime('0s')).toBe(src);
  });

  it('works on an empty series', () => {
    const empty = bars().filter(() => false);
    expect(empty.offsetTime('1m').length).toBe(0);
  });

  it('keeps key-based queries working on the moved axis', () => {
    const out = bars().offsetTime('1m');
    expect(out.atOrBefore(2 * MIN + 1)!.get('sym')).toBe('b');
    expect(out.timeRange()!.begin()).toBe(MIN);
  });

  it('rejects a non-finite or unparseable offset', () => {
    expect(() => bars().offsetTime(Number.NaN)).toThrow(/finite/);
    expect(() => bars().offsetTime(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(() => bars().offsetTime('1 minute' as any)).toThrow(
      /unsupported duration/,
    );
    expect(() => bars().offsetTime(null as any)).toThrow(/unsupported/);
  });
});
