import { describe, expect, it } from 'vitest';
import { resolveYTickCount } from '../src/yticks.js';

describe('resolveYTickCount', () => {
  it('derives from height (~1 tick / 48px), floored at 2', () => {
    expect(resolveYTickCount(72)).toBe(2); // floor(72/48)=1 → clamped to 2
    expect(resolveYTickCount(380)).toBe(7); // floor(380/48)=7
    expect(resolveYTickCount(0)).toBe(2); // pre-layout: still drawable
  });

  it('a taller row derives more ticks than a shorter one (monotonic)', () => {
    expect(resolveYTickCount(120)).toBeLessThan(resolveYTickCount(600));
  });

  it('an explicit count overrides the derivation (floored at 1)', () => {
    expect(resolveYTickCount(380, 3)).toBe(3);
    expect(resolveYTickCount(72, 6)).toBe(6);
    expect(resolveYTickCount(200, 0)).toBe(1); // a request of 0 → 1
  });
});
