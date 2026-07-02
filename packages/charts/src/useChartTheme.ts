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
 * When the resolved theme changes it returns a **new** reference, which is the
 * repaint signal — `ChartContainer` redraws when handed a new `theme`. A
 * watched mutation that doesn't change the resolved values (e.g. an app
 * toggling an unrelated `class` on `<html>`) returns the *same* reference, so
 * it doesn't repaint. Resolution runs on mount and on watched-attribute changes
 * only — never per frame — so the `getComputedStyle` read stays cheap.
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
 * inline literals are fine — they don't need memoizing and don't re-subscribe
 * the observer. **But** because a resolve only fires on mount + a watched
 * mutation, changing `base`/`resolve` alone won't re-resolve until the next
 * toggle; if you need to swap them and re-resolve immediately, change `target`
 * / `attributes` (which re-subscribes) or remount. SSR-safe: the first value
 * resolves with no DOM (returns `base` + any literal fallbacks); the client
 * re-resolves on mount.
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

  // Re-resolve, but only push a new reference when the resolved theme actually
  // changed — so a watched-but-unrelated mutation (e.g. an app toggling a
  // scroll-lock `class` on `<html>`) doesn't force a repaint. Identical values
  // ⇒ return the previous reference ⇒ React bails out.
  const resolveAndApply = () => {
    const next = compute();
    setTheme((prev) => (themesEqual(prev, next) ? prev : next));
  };

  useEffect(() => {
    const el =
      target ??
      (typeof document !== 'undefined' ? document.documentElement : undefined);
    if (!el || typeof MutationObserver === 'undefined') return;
    // Re-resolve on mount: the SSR/first value was computed without a DOM.
    resolveAndApply();
    const observer = new MutationObserver(resolveAndApply);
    observer.observe(el, {
      attributes: true,
      attributeFilter: attrKey.split(','),
    });
    return () => observer.disconnect();
    // `resolveAndApply` closes over stable refs; re-subscribe only on
    // target/attr change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, attrKey]);

  return theme;
}

/** Value-equality for two resolved themes. A `ChartTheme` is a plain tree of
 *  strings / numbers / small arrays (no functions, stable key order), so a
 *  JSON compare is correct and cheap at the mount/toggle cadence this runs at. */
function themesEqual(a: ChartTheme, b: ChartTheme): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
