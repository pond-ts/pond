/**
 * Data-driven point encoding for {@link ScatterChart} — the **deliberate,
 * signed-off exception** to the package's single-styling-channel rule.
 *
 * Every other layer takes one styling input: a semantic `as` token the theme
 * maps to a style. That discipline exists because react-timeseries-charts' free
 * per-component style accessor (a function from a datum to a style object) bred
 * a class of styling bugs. Scatter keeps the base mark on that same channel
 * (`theme.scatter[as]` → the default radius + colour) but **adds** size and
 * colour driven *from the data*: a column value run through a scale. The
 * difference that keeps this safe is that the input is a **column name + a
 * range**, not an arbitrary callback — there is no place to hide a styling bug
 * in `{ column: 'velocity', range: [2, 12] }`.
 *
 * Both encodings build a *linear* scale over the **finite extent** of the named
 * column (NaN / missing cells ignored, so a gap doesn't drag the domain) and map
 * it into the requested output range. The scale is precomputed once per resolve;
 * the returned `radiusAt` / `colorAt` are O(1) per point.
 *
 * Pure + unit-tested (`test/encoding.test.ts`); scatter is the sole consumer.
 */

import type { ChartSeries } from './data.js';

/**
 * Per-point **radius** encoding. Either:
 * - a fixed radius in CSS px (every point the same size — the common case), or
 * - `{ column, range }`: map the column's finite extent linearly onto
 *   `[minR, maxR]` px. A point whose radius column is non-finite falls back to
 *   the base radius (it still draws, at the default size).
 *
 * **Omitted ⇒ the base radius** from the style (`theme.scatter[as].radius`).
 */
export type RadiusEncoding =
  | number
  | {
      /** Numeric column whose value drives each point's radius. */
      readonly column: string;
      /** Output radius range in px, `[atColumnMin, atColumnMax]`. */
      readonly range: readonly [number, number];
    };

/**
 * Per-point **colour** encoding — `{ column, range }`: map the column's finite
 * extent linearly onto a two-stop colour ramp `[atMin, atMax]` (interpolated in
 * sRGB). A point whose colour column is non-finite falls back to the base colour
 * (the single styling channel — `theme.scatter[as].color`).
 *
 * **Omitted ⇒ the base colour** for every point. The `range` stops must be CSS
 * hex (`#rgb` / `#rrggbb`); a non-hex stop disables interpolation for that point
 * (falls back to the base colour) rather than guessing.
 */
export interface ColorEncoding {
  /** Numeric column whose value drives each point's colour. */
  readonly column: string;
  /** Two-stop colour ramp, `[atColumnMin, atColumnMax]` — CSS hex. */
  readonly range: readonly [string, string];
}

/**
 * A resolved encoding: O(1) per-point accessors over a {@link ChartSeries}'
 * index. `radiusAt`/`colorAt` are indexed by the *same* row position as the
 * scatter's `x`/`y` arrays — a point with a non-finite encoding value (or no
 * encoding configured) gets the base radius / colour.
 */
export interface ResolvedEncoding {
  /** This point's radius in px (base radius if unencoded / non-finite). */
  radiusAt(i: number): number;
  /** This point's fill colour (base colour if unencoded / non-finite). */
  colorAt(i: number): string;
  /**
   * `true` when **neither** radius nor colour is data-driven — every mark is the
   * same fixed size and colour (`radiusAt`/`colorAt` ignore their index). This is
   * the precondition for lossless occupancy **decimation** (PND-MARKDEC scatter
   * half): only same-size, same-colour marks can be collapsed where they overlap
   * without changing the picture. A `{column, range}` on either channel makes it
   * `false`, and the scatter draws every point.
   */
  readonly uniform: boolean;
}

/** A numeric column read into a `Float64Array` (gaps as NaN), by name. */
export type ColumnReader = (column: string) => Float64Array;

/**
 * The `[min, max]` of the **finite** values in `col`, or `null` if none are
 * finite. (Same gap-aware contract as `yExtent`; duplicated here so encoding
 * stays a leaf module with no draw-layer dependency.)
 */
export function finiteExtent(col: Float64Array): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < col.length; i += 1) {
    const v = col[i]!;
    if (Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return min === Infinity ? null : [min, max];
}

/** Linear interpolate `t` (0..1) across `[a, b]`. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Parse a CSS hex colour to `[r, g, b]` (0–255), or `null` if not hex. */
function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (m === null) return null;
  const h = m[1]!;
  if (h.length === 3) {
    return [
      parseInt(h[0]! + h[0]!, 16),
      parseInt(h[1]! + h[1]!, 16),
      parseInt(h[2]! + h[2]!, 16),
    ];
  }
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** Interpolate two hex colours in sRGB at `t` (0..1) → `rgb(r, g, b)`. */
function mixHex(from: string, to: string, t: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  if (a === null || b === null) return from; // non-hex stop: leave it to caller
  const r = Math.round(lerp(a[0], b[0], t));
  const g = Math.round(lerp(a[1], b[1], t));
  const bl = Math.round(lerp(a[2], b[2], t));
  return `rgb(${r}, ${g}, ${bl})`;
}

/** Position of `v` within `[min, max]` as a clamped 0..1 fraction (0 if flat). */
function normalize(v: number, min: number, max: number): number {
  if (max - min < 1e-12) return 0; // degenerate extent → everything at the low stop
  const t = (v - min) / (max - min);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Resolve a scatter's data-driven encoding into O(1) per-point accessors.
 *
 * @param cs        the scatter's columnar view (its `length` bounds the indices)
 * @param baseRadius the style's base radius (the fixed-size fallback)
 * @param baseColor  the style's base colour (the single-styling-channel colour)
 * @param radius     the {@link RadiusEncoding} (a number, a `{column,range}`, or omitted)
 * @param color      the {@link ColorEncoding} (a `{column,range}`, or omitted)
 * @param readColumn reads a named numeric column to a `Float64Array` (gaps NaN)
 *
 * A `{column}` encoding whose column is entirely non-finite degrades to the base
 * value (no scale to build); an individual non-finite cell likewise falls back,
 * so every point always resolves to a finite radius and a concrete colour.
 */
export function resolveEncoding(
  cs: ChartSeries,
  baseRadius: number,
  baseColor: string,
  radius: RadiusEncoding | undefined,
  color: ColorEncoding | undefined,
  readColumn: ColumnReader,
): ResolvedEncoding {
  // --- radius ---
  let radiusAt: (i: number) => number;
  if (radius === undefined || typeof radius === 'number') {
    const r = radius === undefined ? baseRadius : radius;
    radiusAt = () => r;
  } else {
    const col = readColumn(radius.column);
    const extent = finiteExtent(col);
    const [minR, maxR] = radius.range;
    if (extent === null) {
      radiusAt = () => baseRadius; // column has no finite values
    } else {
      const [lo, hi] = extent;
      radiusAt = (i) => {
        const v = col[i]!;
        if (!Number.isFinite(v)) return baseRadius;
        return lerp(minR, maxR, normalize(v, lo, hi));
      };
    }
  }

  // --- colour ---
  let colorAt: (i: number) => string;
  if (color === undefined) {
    colorAt = () => baseColor;
  } else {
    const col = readColumn(color.column);
    const extent = finiteExtent(col);
    const [from, to] = color.range;
    if (extent === null) {
      colorAt = () => baseColor;
    } else {
      const [lo, hi] = extent;
      colorAt = (i) => {
        const v = col[i]!;
        if (!Number.isFinite(v)) return baseColor;
        return mixHex(from, to, normalize(v, lo, hi));
      };
    }
  }

  // Uniform iff both channels are fixed: radius a number/omitted and no colour
  // encoding. Data-driven either side (`{column, range}`) makes every mark
  // potentially distinct, so decimation must not collapse them.
  const uniform =
    (radius === undefined || typeof radius === 'number') && color === undefined;

  return { radiusAt, colorAt, uniform };
}
