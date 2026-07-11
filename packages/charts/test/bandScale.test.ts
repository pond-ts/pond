import { describe, expect, it } from 'vitest';
import { scaleBand } from '../src/bandScale.js';

/** Four categories over a 400px range → 100px slots, centres at 50/150/250/350. */
const s = () => scaleBand(['a', 'b', 'c', 'd']).domain([0, 4]).range([0, 400]);

describe('scaleBand', () => {
  it('maps slot values to pixels linearly (edges + centres)', () => {
    const scale = s();
    expect(scale(0)).toBe(0); // left edge of slot 0
    expect(scale(4)).toBe(400); // right edge of the last slot
    expect(scale(0.5)).toBe(50); // centre of slot 0
    expect(scale(2.5)).toBe(250); // centre of slot 2
  });

  it('bandwidth / step is one slot width', () => {
    expect(s().bandwidth()).toBe(100);
    expect(s().step()).toBe(100);
  });

  it('ticks returns one band centre per category', () => {
    expect(s().ticks()).toEqual([0.5, 1.5, 2.5, 3.5]);
  });

  it('invert snaps a pixel to the nearest slot centre', () => {
    const scale = s();
    expect(scale.invert(50)).toBe(0.5); // dead centre of slot 0
    expect(scale.invert(120)).toBe(1.5); // anywhere in slot 1 → its centre
    expect(scale.invert(299)).toBe(2.5); // just inside slot 2
  });

  it('invert clamps to a real slot outside the range', () => {
    const scale = s();
    expect(scale.invert(-30)).toBe(0.5); // left of the plot → first slot
    expect(scale.invert(999)).toBe(3.5); // right of the plot → last slot
  });

  it('label looks up the category name at a slot value', () => {
    const scale = s();
    expect(scale.label(0.5)).toBe('a');
    expect(scale.label(2.5)).toBe('c');
    expect(scale.label(3.9)).toBe('d'); // still in slot 3
    expect(scale.label(4)).toBe(''); // past the last slot → no label
  });

  it('domain / range getters + fluent setters', () => {
    const scale = scaleBand(['x', 'y']);
    expect(scale.domain([0, 2]).range([0, 200])).toBe(scale); // fluent (returns this)
    expect(scale.domain()).toEqual([0, 2]);
    expect(scale.range()).toEqual([0, 200]);
    expect(scale(1)).toBe(100); // slot boundary at the midpoint
  });

  it('tickFormat maps a slot value to its category name (specifier ignored)', () => {
    // A category axis labels by name; a numeric specifier can't name a category.
    const f = s().tickFormat(5, '.0%');
    expect(f(0.5)).toBe('a');
    expect(f(2.5)).toBe('c');
  });

  it('copy is independent of the original', () => {
    const a = s();
    const b = a.copy().range([0, 800]);
    expect(a.bandwidth()).toBe(100); // unchanged
    expect(b.bandwidth()).toBe(200);
  });
});
