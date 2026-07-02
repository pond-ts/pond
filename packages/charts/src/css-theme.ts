import type { ChartTheme } from './theme.js';

/**
 * A deep-partial of {@link ChartTheme} — every leaf optional, arrays kept whole
 * (so `axis.gridDash` / `annotation.depth` replace rather than merge
 * element-wise). The shape a {@link cssVarTheme} resolver returns: name only the
 * slots you're driving from CSS, everything else falls through to the base.
 */
export type ChartThemeOverrides = DeepPartial<ChartTheme>;

// Leaves allow `| undefined` on purpose: a resolver returns `undefined` for an
// unresolved var (the "keep the base value" signal), and under
// `exactOptionalPropertyTypes` an optional key alone wouldn't accept it.
type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | undefined }
    : T;

/**
 * Reads a CSS custom property's computed value. Returns the trimmed value, or
 * `fallback` when the property is empty / unset / there's no DOM (SSR, worker).
 * `undefined` from a resolver leaf means "leave the base theme's value" — so a
 * missing var never blanks a colour.
 */
export type VarReader = (name: string, fallback?: string) => string | undefined;

/**
 * Build a {@link ChartTheme} by overlaying CSS-custom-property values onto a
 * `base` theme — the adapter that lets a chart track a design system's tokens
 * (and its dark/light toggle) without hand-mirroring hex values.
 *
 * `resolve` receives a {@link VarReader} and returns only the slots to override
 * (a {@link ChartThemeOverrides}); the result is `base` deep-merged with them.
 * The typed `ChartTheme` stays the one styling channel — this **generates** it
 * from CSS, it doesn't add a second one.
 *
 * ```ts
 * const theme = cssVarTheme(defaultTheme, (v) => ({
 *   line: { default: { color: v('--td-primary') }, secondary: { color: v('--td-secondary') } },
 *   axis: { label: v('--td-text-3'), grid: v('--td-hairline') },
 *   cursor: v('--td-text-3'),
 *   font: { family: v('--td-font-mono') },
 * }));
 * ```
 *
 * **DOM-only, by design.** It reads `getComputedStyle` off `opts.element` (or
 * `document.documentElement`). With no DOM — SSR, an OffscreenCanvas worker —
 * every `readVar` returns its fallback (or `undefined`, kept from `base`), so
 * the call is safe and returns the base theme (plus any literal fallbacks). For
 * a live chart that follows a theme toggle, use {@link useChartTheme}, which
 * wraps this and re-resolves on a `data-theme` change — don't call `cssVarTheme`
 * per frame (`getComputedStyle` is a layout read).
 */
export function cssVarTheme(
  base: ChartTheme,
  resolve: (readVar: VarReader) => ChartThemeOverrides,
  opts?: { element?: Element },
): ChartTheme {
  const el =
    opts?.element ??
    (typeof document !== 'undefined' ? document.documentElement : undefined);
  const style =
    el && typeof getComputedStyle === 'function'
      ? getComputedStyle(el)
      : undefined;
  const readVar: VarReader = (name, fallback) => {
    const raw = style?.getPropertyValue(name).trim();
    return raw ? raw : fallback;
  };
  return deepMerge(base, resolve(readVar)) as ChartTheme;
}

/**
 * Deep-merge `partial` over `base`: recurse into plain objects, replace at
 * leaves and arrays, and **skip `undefined`** in `partial` (so an unresolved
 * var keeps the base value). Never mutates `base`; each merged object level is
 * freshly spread, and untouched subtrees are shared by reference (safe — a
 * `ChartTheme` is read-only).
 */
function deepMerge(base: unknown, partial: unknown): unknown {
  if (partial === undefined) return base;
  if (
    base === null ||
    typeof base !== 'object' ||
    Array.isArray(base) ||
    Array.isArray(partial) ||
    typeof partial !== 'object' ||
    partial === null
  ) {
    // Leaf, array (replace whole), or a partial that introduces a value where
    // the base had none — the partial wins.
    return partial;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(partial as Record<string, unknown>)) {
    // Never let a resolver's key rewrite the prototype chain.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      continue;
    const pv = (partial as Record<string, unknown>)[key];
    if (pv === undefined) continue;
    out[key] = deepMerge((base as Record<string, unknown>)[key], pv);
  }
  return out;
}
