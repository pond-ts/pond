import { describe, expect, it } from 'vitest';
import { panRange, zoomRange } from '../src/viewport.js';

describe('panRange', () => {
  it('shifts the range by dt (caller signs the gesture)', () => {
    expect(panRange([100, 200], 50)).toEqual([150, 250]);
    expect(panRange([100, 200], -30)).toEqual([70, 170]);
  });
});

describe('zoomRange', () => {
  it('zooms in (factor < 1) holding the centre pivot fixed', () => {
    expect(zoomRange([0, 100], 50, 0.5)).toEqual([25, 75]);
  });

  it('zooms out (factor > 1)', () => {
    expect(zoomRange([0, 100], 50, 2)).toEqual([-50, 150]);
  });

  it('holds an off-centre pivot fixed', () => {
    // pivot 20 stays at the same fractional position (0.2) of the new window.
    expect(zoomRange([0, 100], 20, 0.5)).toEqual([10, 60]);
  });

  it('clamps to minDuration (the zoom-in floor), keeping the pivot fraction', () => {
    // factor 0.001 would give a ~0.1ms span; floor is 10, pivot frac 0.25.
    expect(zoomRange([0, 100], 25, 0.001, 10)).toEqual([22.5, 32.5]);
  });
});
