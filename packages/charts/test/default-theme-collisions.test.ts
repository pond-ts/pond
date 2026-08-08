/**
 * Colour-collision guards for `defaultTheme` — the palette every consumer who
 * passes no `theme` gets.
 *
 * Two rules, both of which have silently failed before (the annotation
 * register sat ~ΔE 4 from the bar palette's resting teal, and the old data
 * blue sat ~ΔE 5 from the selection blue — each invisible until the stories
 * actually rendered the default theme):
 *
 * 1. **A placed mark never reads as data.** `annotation.color` must clear
 *    every data hue in the palette.
 * 2. **Selection stays unambiguous.** The bar palette's `highlight` is the
 *    committed-selection colour; no data hue may approach it, or a series
 *    drawn over bars reads as selected.
 *
 * Distances are CIE76 ΔE (Lab Euclidean) — coarse but monotone enough for a
 * floor. For reference: ΔE ≈ 2 is a just-noticeable difference; the failures
 * above were ΔE 4–5; every pairing below clears 25+.
 */
import { describe, expect, it } from 'vitest';
import { defaultTheme } from '../src/theme.js';

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToLab([r8, g8, b8]: [number, number, number]): [
  number,
  number,
  number,
] {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = [lin(r8), lin(g8), lin(b8)];
  const x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  const f = (t: number) =>
    t > 0.008856 ? Math.cbrt(t) : (903.3 * t + 16) / 116;
  const [fx, fy, fz] = [f(x / 0.95047), f(y), f(z / 1.08883)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 ΔE between two `#rrggbb` colours. */
function deltaE(h1: string, h2: string): number {
  const [l1, a1, b1] = rgbToLab(hexToRgb(h1));
  const [l2, a2, b2] = rgbToLab(hexToRgb(h2));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Every flat data hue in the default palette, by name (for failure output). */
const dataHues: ReadonlyArray<readonly [string, string]> = [
  ['bar.default.fill (rest teal)', defaultTheme.bar.default.fill],
  ['bar.default.hover', defaultTheme.bar.default.hover!],
  ['bar.default.highlight (selection)', defaultTheme.bar.default.highlight],
  ['bar.default.bands[1] (amber)', defaultTheme.bar.default.bands![1]!],
  ['bar.default.bands[2] (red)', defaultTheme.bar.default.bands![2]!],
  ['bar.secondary.fill', defaultTheme.bar.secondary!.fill],
  ['line.default', defaultTheme.line.default.color],
  ['line.secondary', defaultTheme.line.secondary!.color],
  ['line.context', defaultTheme.line.context!.color],
  ['area.default.fill', defaultTheme.area.default.fill],
  ['area.out.fill', defaultTheme.area.out!.fill],
  ['scatter.default', defaultTheme.scatter.default.color],
  ['scatter.secondary', defaultTheme.scatter.secondary!.color],
  ['box.default.fill', defaultTheme.box.default.fill],
  ['candle rising body', defaultTheme.candle.default.rising.body],
  ['candle falling body', defaultTheme.candle.default.falling.body],
  ['candle neutral body', defaultTheme.candle.default.neutral!.body],
];

describe('defaultTheme colour collisions', () => {
  it('annotation register clears every data hue (a placed mark never reads as data)', () => {
    const register = defaultTheme.annotation!.color;
    for (const [name, hue] of dataHues) {
      const d = deltaE(register, hue);
      expect(
        d,
        `annotation ${register} vs ${name} ${hue} — ΔE76 ${d.toFixed(1)}`,
      ).toBeGreaterThanOrEqual(25);
    }
  });

  it('no data hue approaches the selection blue (selection stays unambiguous)', () => {
    const selection = defaultTheme.bar.default.highlight;
    for (const [name, hue] of dataHues) {
      if (hue === selection) continue; // the selection colour itself
      const d = deltaE(selection, hue);
      expect(
        d,
        `selection ${selection} vs ${name} ${hue} — ΔE76 ${d.toFixed(1)}`,
      ).toBeGreaterThanOrEqual(25);
    }
  });
});
