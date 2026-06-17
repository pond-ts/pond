import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import { fromTimeSeries } from '../src/data.js';

const numeric = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 10],
      [1, 20],
      [2, 30],
    ],
  });

describe('fromTimeSeries', () => {
  it('extracts x (timestamps) and y (values) as equal-length Float64Arrays', () => {
    const cs = fromTimeSeries(numeric(), 'v');
    expect(cs.x).toBeInstanceOf(Float64Array);
    expect(cs.y).toBeInstanceOf(Float64Array);
    expect(Array.from(cs.x)).toEqual([0, 1, 2]);
    expect(Array.from(cs.y)).toEqual([10, 20, 30]);
    expect(cs.length).toBe(3);
    expect(cs.x.length).toBe(cs.y.length);
  });

  it('represents missing values as NaN (the gap signal)', () => {
    const s = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 10],
        [1, undefined],
        [2, 30],
      ] as never,
    });
    const cs = fromTimeSeries(s, 'v');
    expect(cs.y[0]).toBe(10);
    expect(Number.isNaN(cs.y[1]!)).toBe(true);
    expect(cs.y[2]).toBe(30);
  });

  it('throws on an unknown column', () => {
    expect(() => fromTimeSeries(numeric(), 'nope')).toThrow(/unknown column/);
  });

  it('throws on a non-numeric column', () => {
    const s = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'label', kind: 'string' },
      ] as const,
      rows: [[0, 'a']],
    });
    expect(() => fromTimeSeries(s, 'label')).toThrow(/numeric|number/);
  });
});
