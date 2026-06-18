import { describe, expect, it } from 'vitest';
import { curveBasis, curveLinear, curveMonotoneX, curveStep } from 'd3-shape';
import { resolveCurve } from '../src/curve.js';

describe('resolveCurve', () => {
  it('defaults to linear (undefined or "linear")', () => {
    expect(resolveCurve()).toBe(curveLinear);
    expect(resolveCurve('linear')).toBe(curveLinear);
  });

  it('maps names to their d3 curve factories', () => {
    expect(resolveCurve('monotone')).toBe(curveMonotoneX);
    expect(resolveCurve('basis')).toBe(curveBasis);
    expect(resolveCurve('step')).toBe(curveStep);
  });
});
