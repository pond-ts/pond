import type { CSSProperties } from 'react';
import type { ChartTheme } from './theme.js';

/**
 * The shared **chip** look — one source of truth for the cursor's value flag and
 * the annotation labels, so a placed label and a cursor flag read as the same
 * object. A filled panel (the theme's `chip.background`) with crisp tabular text
 * and **no outline** — the fill delineates it (a border read as a hard edge on a
 * dark ground). The caller layers on `color` (the series / annotation hue) and the
 * position (`top` + `left`/`right`).
 *
 * Note: on a light theme whose `chip.background` doesn't contrast with the plot
 * ground, the borderless chip needs another delineator (a subtle shadow, or a
 * contrasting chip background) — a token to settle before this ships.
 */
export function flagChipStyle(theme: ChartTheme): CSSProperties {
  return {
    position: 'absolute',
    background: theme.chip?.background,
    // Square corners — a flag is a filled panel behind the number, not a pill
    // (the rounded pill is reserved for axis indicators, see `axisPillStyle`).
    borderRadius: '0',
    padding: '0 4px',
    fontFamily: theme.font.family,
    fontSize: `${theme.font.size}px`,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    lineHeight: 1.5,
  };
}

/**
 * Pick a readable text colour (near-black or white) for text drawn **on top of**
 * `bg`, by its sRGB relative luminance. Handles `#rgb`/`#rrggbb` (the theme
 * palette); any other CSS colour falls back to white. So a saturated blue/red/
 * teal pill gets white text, a pale turquoise pill gets dark text.
 */
export function contrastText(bg: string): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg.trim());
  const raw = m?.[1];
  if (raw === undefined) return '#ffffff';
  const h =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.6 ? '#0b1220' : '#ffffff';
}

/**
 * The **axis indicator pill** look — a *solid* filled tag in `color` with
 * auto-contrast text (the ChartIQ / Yahoo price-tag). Distinct from
 * {@link flagChipStyle} (a light in-plot value chip): an on-axis indicator reads
 * as a saturated pill covering the tick, not a floating readout. Note: it does
 * **not** set `lineHeight` — it inherits `normal`, matching a bare tick label, so
 * a pill anchored at the same offset lines up with its tick-label neighbours (a
 * forced lineHeight would shift the text off the tick baseline). Shared by
 * {@link YAxisIndicator}, the crosshair axis pills, and the Baseline/Marker
 * `indicator` pills.
 */
export function axisPillStyle(theme: ChartTheme, color: string): CSSProperties {
  return {
    position: 'absolute',
    background: color,
    color: contrastText(color),
    borderRadius: '3px',
    padding: '0 4px',
    fontFamily: theme.font.family,
    fontSize: `${theme.font.size}px`,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  };
}

/**
 * A small triangle on an axis pill's **plot-facing edge**, pointing into the
 * plot at the value (the callout tab). For a `right`-side pill (extending right
 * across the gutter) it sits on the pill's left edge pointing left; for a `left`
 * pill, the mirror. Render as an absolutely-positioned child of the pill (the
 * pill is itself absolute, so it's the containing block); colour matches the pill.
 */
export function pointerStyle(
  side: 'left' | 'right',
  color: string,
): CSSProperties {
  return {
    position: 'absolute',
    top: '50%',
    transform: 'translateY(-50%)',
    width: 0,
    height: 0,
    borderTop: '4px solid transparent',
    borderBottom: '4px solid transparent',
    ...(side === 'right'
      ? { left: '-5px', borderRight: `5px solid ${color}` }
      : { right: '-5px', borderLeft: `5px solid ${color}` }),
  };
}

/**
 * CSS placing a value pill **on the axis gutter** at `side`: anchor its inner
 * edge at the plot boundary (`plotWidth`) and let it overflow outward across the
 * reserved gutter (the plot div doesn't clip), lifted with `zIndex` above the
 * sibling axis column (rendered later in the row) so it covers the tick behind
 * it. Shared by {@link YAxisIndicator}'s `placement='axis'` and the crosshair
 * cursor's per-series value pills, so both sit identically on the axis.
 */
export function axisPillX(
  side: 'left' | 'right',
  plotWidth: number,
): CSSProperties {
  return side === 'right'
    ? { left: `${plotWidth}px`, zIndex: 3 }
    : { right: `${plotWidth}px`, zIndex: 3 };
}

/** Gap (px) between a flag chip and its pole — the cursor staff or an annotation's
 *  line — so the chip floats just beside the pole rather than sitting on it. */
const FLAG_GAP = 4;
/** Past this fraction of the plot, a flag flips to the left of its pole to stay in. */
const FLAG_FLIP = 0.85;

/**
 * Horizontal placement for a flag chip beside a vertical pole at plot-x `x`:
 * `FLAG_GAP` to the right, flipping to the left near the right edge so it stays
 * in-plot. Shared by the cursor value flag and the annotation labels so a chip
 * sits **identically** relative to its pole in both.
 */
export function flagChipX(x: number, plotWidth: number): CSSProperties {
  return x > plotWidth * FLAG_FLIP
    ? { right: `${plotWidth - x + FLAG_GAP}px` }
    : { left: `${x + FLAG_GAP}px` };
}
