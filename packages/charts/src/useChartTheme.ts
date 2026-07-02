import { useEffect, useRef, useState } from 'react';
import {
  cssVarTheme,
  type ChartThemeOverrides,
  type VarReader,
} from './css-theme.js';
import type { ChartTheme } from './theme.js';

/** Options for {@link useChartTheme}. */
export interface UseChartThemeOptions {
  /**
   * Element whose CSS custom properties are read and whose attribute changes
   * are watched. **Default `document.documentElement`** (`<html>`) — the usual
   * home of a `data-theme` toggle. Pass a scoped element to theme one subtree.
   */
  target?: Element;
  /**
   * Attributes that, when they change on `target`, trigger a re-resolve.
   * **Default `['data-theme', 'class']`** — the two common dark/light switches.
   */
  attributes?: readonly string[];
}

/**
 * Live {@link ChartTheme} bound to CSS custom properties: resolves `resolve`
 * against the DOM (via {@link cssVarTheme}) and **re-resolves whenever the
 * theme toggle flips** — a `MutationObserver` watches `target`'s
 * `data-theme` / `class`, so `<ChartContainer theme={useChartTheme(...)} />`
 * follows dark/light with no `mode` prop threaded through and no hand-ordered
 * attribute-then-read dance.
 *
 * Returns a new theme reference on each resolve, which is the repaint signal —
 * `ChartContainer` redraws when handed a new `theme`. Resolution happens on
 * mount and on each watched-attribute change only (never per frame), so the
 * `getComputedStyle` read stays cheap.
 *
 * ```tsx
 * const theme = useChartTheme(defaultTheme, (v) => ({
 *   line: { default: { color: v('--td-primary') } },
 *   axis: { label: v('--td-text-3'), grid: v('--td-hairline') },
 * }));
 * return <ChartContainer width={w} theme={theme}>…</ChartContainer>;
 * ```
 *
 * `base` and `resolve` are read fresh on every resolve (held in refs), so
 * inline literals are fine — they don't need to be memoized and don't
 * re-subscribe the observer. SSR-safe: the first value resolves with no DOM
 * (returns `base` + any literal fallbacks); the client re-resolves on mount.
 */
export function useChartTheme(
  base: ChartTheme,
  resolve: (readVar: VarReader) => ChartThemeOverrides,
  opts?: UseChartThemeOptions,
): ChartTheme {
  const baseRef = useRef(base);
  baseRef.current = base;
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  const target = opts?.target;
  // Stable key for the effect dep so an inline `attributes` array doesn't
  // re-subscribe every render.
  const attrKey = (opts?.attributes ?? ['data-theme', 'class']).join(',');

  const compute = () =>
    cssVarTheme(
      baseRef.current,
      resolveRef.current,
      target ? { element: target } : undefined,
    );
  const [theme, setTheme] = useState<ChartTheme>(compute);

  useEffect(() => {
    const el =
      target ??
      (typeof document !== 'undefined' ? document.documentElement : undefined);
    if (!el || typeof MutationObserver === 'undefined') return;
    // Re-resolve on mount: the SSR/first value was computed without a DOM.
    setTheme(compute());
    const observer = new MutationObserver(() => setTheme(compute()));
    observer.observe(el, {
      attributes: true,
      attributeFilter: attrKey.split(','),
    });
    return () => observer.disconnect();
    // `compute` closes over stable refs; re-subscribe only on target/attr change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, attrKey]);

  return theme;
}
