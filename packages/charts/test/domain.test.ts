import { describe, expect, it } from 'vitest';
import { resolveYDomain } from '../src/domain.js';

describe('resolveYDomain', () => {
  it('auto-fits both bounds to the union of extents, rounded out for headroom', () => {
    // .nice() rounds [5, 30] out to [4, 30] — covers the data with headroom + a
    // round lower bound, so peaks/whiskers don't sit on the plot edge.
    expect(
      resolveYDomain(undefined, undefined, [
        [10, 30],
        [5, 20],
      ]),
    ).toEqual([4, 30]);
  });

  it('leaves an explicit domain exact — never nice (even non-round bounds)', () => {
    expect(resolveYDomain(3, 97, [[10, 20]])).toEqual([3, 97]);
  });

  it('does not nice the auto side when one bound is explicit', () => {
    // min explicit ⇒ the caller controls the axis; the auto max stays the raw
    // data extent (83), not rounded to 85/90.
    expect(resolveYDomain(0, undefined, [[10, 83]])).toEqual([0, 83]);
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

  it('honours an explicit max, pushing the auto-fit lo below it', () => {
    // flat data at 8 → auto lo 7; explicit max 5 is below it. Preserve max=5
    // and move lo to 4 (data above 5 is intentionally off the top — that's what
    // an explicit max means), rather than discarding max and showing [7, 8].
    expect(resolveYDomain(undefined, 5, [[8, 8]])).toEqual([4, 5]);
    // max-only, no data: lo auto-fits below the explicit max.
    expect(resolveYDomain(undefined, 5, [])).toEqual([0, 5]);
    // max-only, data below the max: lo fits the data, max honoured.
    expect(resolveYDomain(undefined, 5, [[1, 3]])).toEqual([1, 5]);
  });

  it('pads the resolved domain outward by pad × span on each side', () => {
    // explicit [0, 100], pad 0.1 → 10 of headroom each side
    expect(resolveYDomain(0, 100, [], 0.1)).toEqual([-10, 110]);
    // partial/auto domains are padded too (auto-fit [10,80] → ±7 at pad 0.1)
    expect(resolveYDomain(0, undefined, [[10, 80]], 0.1)).toEqual([-8, 88]);
  });

  it('treats pad 0 (the default) as a no-op', () => {
    expect(resolveYDomain(0, 100, [], 0)).toEqual([0, 100]);
    expect(resolveYDomain(0, 100, [])).toEqual([0, 100]);
  });
});
