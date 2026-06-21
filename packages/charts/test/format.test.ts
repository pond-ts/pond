import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import { resolveAxisFormat } from '../src/format.js';

// A stub scale to isolate the routing (fn vs specifier vs default) from d3's
// actual formatting: it echoes which path was taken.
const stub = {
  tickFormat:
    (count: number, specifier?: string) =>
    (v: number): string =>
      specifier === undefined ? `default(${count}):${v}` : `${specifier}:${v}`,
};

describe('resolveAxisFormat', () => {
  it('uses a function format verbatim (ignoring the scale)', () => {
    const fmt = resolveAxisFormat(stub, 5, (v) => `<${v}>`);
    expect(fmt(42)).toBe('<42>');
  });

  it('routes a specifier string through the scale tickFormat', () => {
    const fmt = resolveAxisFormat(stub, 5, '.0%');
    expect(fmt(0.5)).toBe('.0%:0.5');
  });

  it('falls back to the scale default tickFormat when undefined', () => {
    const fmt = resolveAxisFormat(stub, 7, undefined);
    expect(fmt(3)).toBe('default(7):3');
  });

  // Real d3 scale — confirms the specifier actually formats (not just routes),
  // and that the same formatter the ticks would use is what the readout gets.
  it('formats with a real d3 scale + a percent specifier', () => {
    const s = scaleLinear().domain([0, 1]).range([0, 100]);
    expect(resolveAxisFormat(s, 5, '.0%')(0.5)).toBe('50%');
  });

  it('uses d3 default formatting for a plain integer domain', () => {
    const s = scaleLinear().domain([0, 100]).range([0, 100]);
    expect(resolveAxisFormat(s, 5, undefined)(25)).toBe('25');
  });
});
