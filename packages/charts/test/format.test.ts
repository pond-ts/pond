import { describe, expect, it } from 'vitest';
import { scaleLinear, scaleUtc } from 'd3-scale';
import { resolveAxisFormat, resolveTimeFormat } from '../src/format.js';

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

describe('resolveTimeFormat', () => {
  const BASE = Date.UTC(2026, 0, 1, 13, 30, 0); // 2026-01-01 13:30 UTC
  // scaleUtc so the specifier formats in UTC — TZ-independent assertions.
  const utc = () =>
    scaleUtc()
      .domain([BASE, BASE + 3_600_000])
      .range([0, 100]);

  it('uses a function format verbatim (called with epoch ms)', () => {
    expect(resolveTimeFormat(utc(), 5, (ms) => `t=${ms}`)(BASE)).toBe(
      `t=${BASE}`,
    );
  });

  it('routes a d3 time specifier through the scale, wrapping epoch ms in a Date', () => {
    expect(resolveTimeFormat(utc(), 5, '%H:%M')(BASE)).toBe('13:30');
  });

  it('falls back to the scale multi-scale default when undefined', () => {
    const out = resolveTimeFormat(utc(), 5, undefined)(BASE);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});
