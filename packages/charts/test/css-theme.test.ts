import { afterEach, describe, expect, it } from 'vitest';
import { cssVarTheme } from '../src/css-theme.js';
import { defaultTheme } from '../src/theme.js';

const realGCS = globalThis.getComputedStyle;
afterEach(() => {
  globalThis.getComputedStyle = realGCS;
});

/** Stub `getComputedStyle` so `getPropertyValue` reads from `vars`
 *  (unset props return '' like the real API). */
function stubVars(vars: Record<string, string>) {
  globalThis.getComputedStyle = (() => ({
    getPropertyValue: (name: string) => vars[name] ?? '',
  })) as unknown as typeof getComputedStyle;
}

describe('cssVarTheme', () => {
  it('overlays resolved vars onto the base, leaving unmapped leaves intact', () => {
    stubVars({ '--primary': '#111', '--grid': '#eee' });
    const theme = cssVarTheme(defaultTheme, (v) => ({
      line: { default: { color: v('--primary') } },
      axis: { grid: v('--grid') },
    }));
    expect(theme.line.default.color).toBe('#111'); // overridden
    expect(theme.line.default.width).toBe(defaultTheme.line.default.width); // kept
    expect(theme.axis.grid).toBe('#eee'); // overridden
    expect(theme.axis.label).toBe(defaultTheme.axis.label); // kept
    expect(theme.band).toEqual(defaultTheme.band); // untouched slot
  });

  it('keeps the base value when a var is unset and no fallback is given', () => {
    stubVars({}); // nothing resolves
    const theme = cssVarTheme(defaultTheme, (v) => ({
      line: { default: { color: v('--nope') } },
    }));
    expect(theme.line.default.color).toBe(defaultTheme.line.default.color);
  });

  it('uses the literal fallback when a var is unset', () => {
    stubVars({});
    const theme = cssVarTheme(defaultTheme, (v) => ({
      cursor: v('--nope', '#abc'),
    }));
    expect(theme.cursor).toBe('#abc');
  });

  it('replaces arrays whole rather than merging element-wise', () => {
    stubVars({});
    const theme = cssVarTheme(defaultTheme, () => ({
      annotation: { depth: [0.9, 0.6, 0.3] },
    }));
    expect(theme.annotation?.depth).toEqual([0.9, 0.6, 0.3]);
  });

  it('does not mutate the base theme', () => {
    stubVars({ '--primary': '#111' });
    const before = defaultTheme.line.default.color;
    cssVarTheme(defaultTheme, (v) => ({
      line: { default: { color: v('--primary') } },
    }));
    expect(defaultTheme.line.default.color).toBe(before);
  });

  it('is safe with no DOM — returns the base plus any literal fallbacks', () => {
    globalThis.getComputedStyle =
      undefined as unknown as typeof getComputedStyle;
    const theme = cssVarTheme(defaultTheme, (v) => ({
      line: { default: { color: v('--primary') } }, // no fallback → base kept
      cursor: v('--cursor', '#123'), // fallback → applied
    }));
    expect(theme.line.default.color).toBe(defaultTheme.line.default.color);
    expect(theme.cursor).toBe('#123');
  });
});
