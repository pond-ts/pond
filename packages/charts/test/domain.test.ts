import { describe, expect, it } from 'vitest';
import { resolveYDomain } from '../src/domain.js';

describe('resolveYDomain', () => {
  it('auto-fits both bounds to the union of layer extents', () => {
    expect(
      resolveYDomain(undefined, undefined, [
        [10, 30],
        [5, 20],
      ]),
    ).toEqual([5, 30]);
  });

  it('returns [0, 1] when there is no finite data', () => {
    expect(resolveYDomain(undefined, undefined, [])).toEqual([0, 1]);
    expect(resolveYDomain(undefined, undefined, [null, null])).toEqual([0, 1]);
  });

  it('gives a flat extent ±1 of headroom (constant line sits mid-row)', () => {
    expect(resolveYDomain(undefined, undefined, [[42, 42]])).toEqual([41, 43]);
  });

  it('honours two explicit bounds verbatim (even inverted — a deliberate flip)', () => {
    expect(resolveYDomain(0, 100, [[10, 20]])).toEqual([0, 100]);
    expect(resolveYDomain(100, 0, [])).toEqual([100, 0]); // not second-guessed
  });

  it('auto-fits only the missing side when one bound is explicit', () => {
    expect(resolveYDomain(0, undefined, [[10, 80]])).toEqual([0, 80]);
    expect(resolveYDomain(undefined, 100, [[10, 80]])).toEqual([10, 100]);
  });

  // The bug L2 caught: an explicit bound with no data on the other side must
  // not invert (naive resolve gave [5, 1] from the empty-data [0,1] fallback).
  it('keeps the domain ascending when a partial bound has no data', () => {
    expect(resolveYDomain(5, undefined, [])).toEqual([5, 6]);
    expect(resolveYDomain(5, undefined, [null])).toEqual([5, 6]);
  });

  it('keeps ascending when an explicit max sits below flat data', () => {
    // flat data at 8 → auto lo would be 7; explicit max 5 is below it.
    expect(resolveYDomain(undefined, 5, [[8, 8]])).toEqual([7, 8]);
  });
});
