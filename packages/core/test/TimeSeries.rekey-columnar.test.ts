import { describe, expect, it } from 'vitest';
import { TimeSeries, TimeRange } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* asTime / asTimeRange / asInterval — column-native rekeys.                   */
/*                                                                             */
/* These reinterpret the key's KIND (time ↔ timeRange ↔ interval) straight off */
/* the existing key's begin/end buffers via withKeyColumn — no this.events.    */
/* Value columns pass through by reference. asInterval's label fn now receives  */
/* the interval's TimeRange (its [begin, end] extent) + index, not the whole    */
/* event (breaking change — see CHANGELOG). The existing asX tests in            */
/* TimeSeries.test */
/* pin the row behavior; this file pins the column-native specifics + the new   */
/* asInterval signature.                                                        */
/* -------------------------------------------------------------------------- */

const rangeSchema = [
  { name: 'span', kind: 'timeRange' },
  { name: 'v', kind: 'number' },
] as const;

// timeRange-keyed source so begin/center/end actually differ.
function ranged() {
  return new TimeSeries({
    name: 'r',
    schema: rangeSchema,
    rows: [
      [[0, 100], 10],
      [[1000, 1100], 20],
    ] as any,
  });
}

const timeSchema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function timed() {
  return new TimeSeries({
    name: 't',
    schema: timeSchema,
    rows: [
      [0, 10, 'a'],
      [1000, 20, 'b'],
    ] as any,
  });
}

describe('asTime (column-native rekey)', () => {
  it('anchors at begin / end / center of the extent', () => {
    expect(
      Array.from(ranged().asTime({ at: 'begin' }).keyColumn().begin),
    ).toEqual([0, 1000]);
    expect(
      Array.from(ranged().asTime({ at: 'end' }).keyColumn().begin),
    ).toEqual([100, 1100]);
    expect(
      Array.from(ranged().asTime({ at: 'center' }).keyColumn().begin),
    ).toEqual([50, 1050]);
  });

  it('changes schema[0] to time and preserves value columns', () => {
    const t = ranged().asTime();
    expect(t.schema[0]).toEqual({ name: 'time', kind: 'time' });
    expect(t.at(0)!.get('v')).toBe(10);
    expect(t.at(1)!.get('v')).toBe(20);
  });

  it('leaves the source untouched', () => {
    const r = ranged();
    r.asTime({ at: 'center' });
    expect(r.schema[0]!.kind).toBe('timeRange');
  });
});

describe('asTimeRange (column-native rekey)', () => {
  it('covers each row extent; a time source becomes zero-width [t, t]', () => {
    const tr = timed().asTimeRange();
    expect(tr.schema[0]).toEqual({ name: 'timeRange', kind: 'timeRange' });
    expect(tr.at(0)!.key().begin()).toBe(0);
    expect(tr.at(0)!.key().end()).toBe(0); // time → [t, t]
    expect(tr.at(1)!.key().begin()).toBe(1000);
    expect(tr.at(0)!.get('host')).toBe('a'); // value cols intact
  });

  it('preserves a ranged source extent', () => {
    const tr = ranged().asTimeRange();
    expect(tr.at(0)!.key().begin()).toBe(0);
    expect(tr.at(0)!.key().end()).toBe(100);
  });
});

describe('asInterval (column-native rekey + TimeRange label fn)', () => {
  it('fills a constant string label', () => {
    const iv = timed().asInterval('bucket');
    expect(iv.schema[0]).toEqual({ name: 'interval', kind: 'interval' });
    expect(iv.at(0)!.key().value).toBe('bucket');
    expect(iv.at(1)!.key().value).toBe('bucket');
    expect(iv.at(0)!.get('v')).toBe(10); // value cols intact
  });

  it('fills a constant numeric label', () => {
    const iv = timed().asInterval(42);
    expect(iv.at(0)!.key().value).toBe(42);
  });

  it('passes the interval TimeRange + index to the label fn (not the event)', () => {
    const seen: Array<{ begin: number; end: number; i: number }> = [];
    const iv = ranged().asInterval((range, i) => {
      expect(range).toBeInstanceOf(TimeRange);
      seen.push({ begin: range.begin(), end: range.end(), i });
      return `${range.begin()}-${range.end()}`;
    });
    expect(seen).toEqual([
      { begin: 0, end: 100, i: 0 },
      { begin: 1000, end: 1100, i: 1 },
    ]);
    expect(iv.at(0)!.key().value).toBe('0-100');
    expect(iv.at(1)!.key().value).toBe('1000-1100');
  });

  it('infers a numeric label column from a numeric-returning fn', () => {
    const iv = ranged().asInterval((range) => range.begin());
    expect(iv.at(0)!.key().value).toBe(0);
    expect(iv.at(1)!.key().value).toBe(1000);
  });

  it('throws on mixed label kinds across rows', () => {
    expect(() =>
      ranged().asInterval((_range, i) => (i === 0 ? 'x' : 1) as any),
    ).toThrow(/one type throughout/);
  });
});
