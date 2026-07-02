import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useChartTheme } from '../src/useChartTheme.js';
import { defaultTheme } from '../src/theme.js';

const realGCS = globalThis.getComputedStyle;

// getComputedStyle resolves --accent differently by the root's data-theme —
// standing in for a real design system's cascade (which happy-dom doesn't
// compute from stylesheets).
const LIGHT = '#2563eb';
const DARK = '#93c5fd';
function stubThemedVars() {
  globalThis.getComputedStyle = (() => ({
    getPropertyValue: (name: string) => {
      if (name !== '--accent') return '';
      return document.documentElement.getAttribute('data-theme') === 'dark'
        ? DARK
        : LIGHT;
    },
  })) as unknown as typeof getComputedStyle;
}

afterEach(() => {
  globalThis.getComputedStyle = realGCS;
  document.documentElement.removeAttribute('data-theme');
});

const map = (v: (n: string, f?: string) => string | undefined) => ({
  line: { default: { color: v('--accent') } },
});

describe('useChartTheme', () => {
  it('resolves the theme from CSS vars on mount', () => {
    stubThemedVars();
    document.documentElement.setAttribute('data-theme', 'light');
    const { result } = renderHook(() => useChartTheme(defaultTheme, map));
    expect(result.current.line.default.color).toBe(LIGHT);
    // untouched slots still come from the base
    expect(result.current.axis.grid).toBe(defaultTheme.axis.grid);
  });

  it('re-resolves when the root data-theme flips, returning a new theme ref', async () => {
    stubThemedVars();
    document.documentElement.setAttribute('data-theme', 'light');
    const { result } = renderHook(() => useChartTheme(defaultTheme, map));
    const first = result.current;
    expect(first.line.default.color).toBe(LIGHT);

    act(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    await waitFor(() => {
      expect(result.current.line.default.color).toBe(DARK);
    });
    // a new reference — the repaint signal ChartContainer keys on
    expect(result.current).not.toBe(first);
  });
});
