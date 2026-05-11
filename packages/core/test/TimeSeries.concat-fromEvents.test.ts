import { describe, expect, it } from 'vitest';
import { TimeSeries, TimeRange } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const altSchema = [
  { name: 'time', kind: 'time' },
  { name: 'memory', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const requiredFalseSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
] as const;

function makeSeries(
  name: string,
  rows: ReadonlyArray<readonly [number, number, string]>,
) {
  return new TimeSeries({
    name,
    schema,
    rows: rows.map((r) => [...r] as [number, number, string]),
  });
}

describe('TimeRange.toJSON / toString', () => {
  it('toJSON returns { start, end } as ms-since-epoch', () => {
    const r = new TimeRange({ start: 1000, end: 60_000 });
    expect(r.toJSON()).toEqual({ start: 1000, end: 60_000 });
  });

  it('round-trips through new TimeRange(range.toJSON())', () => {
    const original = new TimeRange({ start: 1000, end: 60_000 });
    const restored = new TimeRange(original.toJSON());
    expect(restored.begin()).toBe(original.begin());
    expect(restored.end()).toBe(original.end());
  });

  it('JSON.stringify uses toJSON implicitly', () => {
    const r = new TimeRange({ start: 1000, end: 60_000 });
    expect(JSON.stringify(r)).toBe('{"start":1000,"end":60000}');
  });

  it('toString returns ISO start/end format', () => {
    const r = new TimeRange({ start: 0, end: 60_000 });
    expect(r.toString()).toBe(
      '1970-01-01T00:00:00.000Z/1970-01-01T00:01:00.000Z',
    );
  });
});

describe('TimeSeries.fromEvents', () => {
  it('builds a series from an existing event array', () => {
    const source = makeSeries('src', [
      [0, 0.5, 'a'],
      [60_000, 0.6, 'a'],
      [120_000, 0.7, 'a'],
    ]);
    const rebuilt = TimeSeries.fromEvents([...source.events], {
      schema,
      name: 'rebuilt',
    });
    expect(rebuilt.length).toBe(3);
    expect(rebuilt.name).toBe('rebuilt');
    expect(rebuilt.first()?.get('cpu')).toBe(0.5);
    expect(rebuilt.last()?.get('cpu')).toBe(0.7);
  });

  it('materializes constructor events once and keeps stable event references', () => {
    const source = makeSeries('src', [
      [0, 0.5, 'a'],
      [60_000, 0.6, 'a'],
    ]);

    expect(source.events).toBe(source.events);
    expect(source.at(0)).toBe(source.at(0));
    expect(source.first()).toBe(source.events[0]);
    expect(source.last()).toBe(source.events[1]);
    expect(Object.keys(source)).toContain('events');
  });

  it('sorts events by key — caller does not need to pre-sort', () => {
    const source = makeSeries('src', [
      [0, 0.5, 'a'],
      [60_000, 0.6, 'a'],
      [120_000, 0.7, 'a'],
    ]);
    const shuffled = [source.events[2]!, source.events[0]!, source.events[1]!];
    const rebuilt = TimeSeries.fromEvents(shuffled, {
      schema,
      name: 'rebuilt',
    });
    expect(rebuilt.toPoints().map((p) => p.ts)).toEqual([0, 60_000, 120_000]);
  });

  it('empty events array produces an empty series', () => {
    const rebuilt = TimeSeries.fromEvents([], { schema, name: 'empty' });
    expect(rebuilt.length).toBe(0);
    expect(rebuilt.schema).toEqual(schema);
  });

  it('preserves schema fully — including the required: false flag', () => {
    const source = new TimeSeries({
      name: 'src',
      schema: requiredFalseSchema,
      rows: [
        [0, 0.5, 'a'],
        [60_000, undefined, 'a'],
      ],
    });
    const rebuilt = TimeSeries.fromEvents([...source.events], {
      schema: requiredFalseSchema,
      name: 'rebuilt',
    });
    expect(rebuilt.length).toBe(2);
    expect(rebuilt.last()?.get('cpu')).toBeUndefined();
  });
});

describe('TimeSeries.concat', () => {
  it('concatenates events from multiple same-schema series', () => {
    const a = makeSeries('a', [
      [0, 0.5, 'a'],
      [60_000, 0.6, 'a'],
    ]);
    const b = makeSeries('b', [
      [30_000, 0.7, 'b'],
      [90_000, 0.8, 'b'],
    ]);
    const merged = TimeSeries.concat([a, b]);
    expect(merged.length).toBe(4);
    expect(merged.toPoints().map((p) => p.ts)).toEqual([
      0, 30_000, 60_000, 90_000,
    ]);
  });

  it('takes name from the first input', () => {
    const a = makeSeries('first', [[0, 0.5, 'a']]);
    const b = makeSeries('second', [[60_000, 0.6, 'b']]);
    expect(TimeSeries.concat([a, b]).name).toBe('first');
  });

  it('preserves the source schema', () => {
    const a = makeSeries('a', [[0, 0.5, 'a']]);
    const b = makeSeries('b', [[60_000, 0.6, 'b']]);
    expect(TimeSeries.concat([a, b]).schema).toEqual(schema);
  });

  it('single-input concat passes through cleanly', () => {
    const a = makeSeries('a', [
      [0, 0.5, 'a'],
      [60_000, 0.6, 'a'],
    ]);
    const merged = TimeSeries.concat([a]);
    expect(merged.length).toBe(2);
    expect(merged.first()?.get('cpu')).toBe(0.5);
  });

  it('preserves event identity — references survive, not clones', () => {
    // Pins that concat does not allocate fresh Event instances. A future
    // refactor that adds event.merge({}) or similar in the concat path
    // must trip this test.
    const a = makeSeries('a', [
      [0, 0.5, 'a'],
      [60_000, 0.6, 'a'],
    ]);
    const merged = TimeSeries.concat([a]);
    expect(merged.at(0)).toBe(a.at(0));
    expect(merged.at(1)).toBe(a.at(1));
  });

  it('preserves input order for tied keys (stable sort)', () => {
    // Array.prototype.sort is stable since ES2019. concat relies on this
    // to keep deterministic ordering when two inputs have an event at
    // the exact same key. Pin it so a future custom-sort refactor
    // can't silently break the contract.
    const a = makeSeries('a', [[0, 0.5, 'first']]);
    const b = makeSeries('b', [[0, 0.7, 'second']]);
    const c = makeSeries('c', [[0, 0.9, 'third']]);
    const merged = TimeSeries.concat([a, b, c]);
    expect(merged.toPoints().map((p) => p.host)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('works on Interval-keyed schemas, not just Time-keyed', () => {
    // compareEventKeys handles all key kinds; verify the sort path
    // doesn't have a Time-key assumption.
    const intervalSchema = [
      { name: 'window', kind: 'interval' },
      { name: 'cpu', kind: 'number' },
    ] as const;
    const a = new TimeSeries({
      name: 'a',
      schema: intervalSchema,
      rows: [
        [{ value: 'a-0', start: 0, end: 60_000 }, 0.5],
        [{ value: 'a-1', start: 60_000, end: 120_000 }, 0.6],
      ],
    });
    const b = new TimeSeries({
      name: 'b',
      schema: intervalSchema,
      rows: [
        [{ value: 'b-0', start: 30_000, end: 90_000 }, 0.7],
        [{ value: 'b-1', start: 90_000, end: 150_000 }, 0.8],
      ],
    });
    const merged = TimeSeries.concat([a, b]);
    expect(merged.length).toBe(4);
    expect(merged.toPoints().map((p) => p.ts)).toEqual([
      0, 30_000, 60_000, 90_000,
    ]);
  });

  it('throws on empty input', () => {
    expect(() => TimeSeries.concat([])).toThrow(
      /requires at least one input series/,
    );
  });

  it('throws on schema length mismatch', () => {
    const a = makeSeries('a', [[0, 0.5, 'a']]);
    const wide = new TimeSeries({
      name: 'wide',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cpu', kind: 'number' },
        { name: 'host', kind: 'string' },
        { name: 'extra', kind: 'number' },
      ] as const,
      rows: [[60_000, 0.6, 'b', 1]],
    });
    expect(() => TimeSeries.concat([a, wide as unknown as typeof a])).toThrow(
      /schema length mismatch/,
    );
  });

  it('throws on column-name mismatch at same position', () => {
    const a = makeSeries('a', [[0, 0.5, 'a']]);
    const b = new TimeSeries({
      name: 'b',
      schema: altSchema,
      rows: [[60_000, 0.7, 'b']],
    });
    expect(() => TimeSeries.concat([a, b as unknown as typeof a])).toThrow(
      /schema mismatch at column 1/,
    );
  });

  it('rebuilds the merged series with re-sorted events on overlapping keys', () => {
    const a = makeSeries('a', [
      [0, 0.5, 'a'],
      [60_000, 0.6, 'a'],
    ]);
    const b = makeSeries('b', [
      [60_000, 0.7, 'b'],
      [120_000, 0.8, 'b'],
    ]);
    const merged = TimeSeries.concat([a, b]);
    // Same-timestamp events both kept (this is row-append, not key-dedupe).
    expect(merged.length).toBe(4);
    const at60k = merged
      .toPoints()
      .filter((p) => p.ts === 60_000)
      .map((p) => p.host);
    expect(at60k.sort()).toEqual(['a', 'b']);
  });

  it('closes the groupBy round-trip', () => {
    const source = makeSeries('metrics', [
      [0, 0.5, 'a'],
      [0, 0.7, 'b'],
      [60_000, 0.6, 'a'],
      [60_000, 0.8, 'b'],
    ]);
    const groups = source.groupBy('host');
    const merged = TimeSeries.concat([...groups.values()]);
    expect(merged.length).toBe(source.length);
    // Same time-ordered output.
    expect(merged.toPoints().map((p) => p.ts)).toEqual([0, 0, 60_000, 60_000]);
  });
});
