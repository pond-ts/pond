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
    borderRadius: '3px',
    padding: '0 4px',
    fontFamily: theme.font.family,
    fontSize: `${theme.font.size}px`,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    lineHeight: 1.5,
  };
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
