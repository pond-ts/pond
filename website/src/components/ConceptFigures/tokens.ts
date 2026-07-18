/**
 * Shared styling tokens for the Concepts-page figures — hand-drawn SVG
 * diagrams that follow the site palette (`--pond-*` custom properties from
 * `src/css/custom.css`), so every figure tracks light/dark mode for free.
 *
 * Conventions (mirroring the ConceptViz drivers):
 * - mono for anything that is code or data (identifiers, values, times)
 * - base font for prose annotations, coloured `--pond-body`
 * - `--pond-viz-*` hues only for data marks; `--pond-viz-mark` (orange) only
 *   for behavioural annotations (flows, callouts), never as a data hue
 */
export const MONO = 'var(--ifm-font-family-monospace)';
export const BASE = 'var(--ifm-font-family-base)';

export const INK = 'var(--pond-ink)';
export const BODY = 'var(--pond-body)';
export const GRID = 'var(--pond-viz-grid)';
export const SURFACE = 'var(--pond-surface)';
export const SURFACE2 = 'var(--pond-surface-2)';

export const TEAL = 'var(--pond-viz-1)';
export const BLUE = 'var(--pond-viz-2)';
export const PURPLE = 'var(--pond-viz-3)';
export const PINK = 'var(--pond-viz-4)';
export const MARK = 'var(--pond-viz-mark)';

/** Soft tint for temporal-key cells — teal over the surface. */
export const KEY_TINT = `color-mix(in srgb, ${TEAL} 10%, ${SURFACE})`;
/** Fainter wash, e.g. an "inside the query range" region. */
export const WASH = `color-mix(in srgb, ${TEAL} 6%, transparent)`;

/** Standard block style for the figures' responsive scaling. */
export const svgStyle = (maxWidth: number): React.CSSProperties => ({
  width: '100%',
  maxWidth,
  height: 'auto',
  display: 'block',
  margin: '1.25rem auto',
});
