/**
 * Visual styling for a chart, threaded through {@link ChartContainer} via
 * context. Canvas has **no CSS cascade into drawn pixels**, so this typed object
 * is the single styling channel for the drawn layers — there's no second
 * (CSS / per-element `style` prop) channel to disagree with it. DOM chrome (axis
 * labels, legend) derives from the same object, so there's still one source of
 * truth.
 *
 * Tokens grow as components land: `line` now, axis tokens with `YAxis` (M2.3),
 * band fill tokens with `BandChart` (M3). Override per-container with the
 * `theme` prop; `estelaTheme` is the first concrete skin (M2.4).
 */
export interface ChartTheme {
  /** Painted behind the layers; omit for a transparent background. */
  readonly background?: string;
  /**
   * Line-role colours. A line defaults to `primary`; a secondary axis line
   * (e.g. HR) uses `secondary`; a context underlay (e.g. elevation) uses
   * `context`. An explicit `stroke` prop overrides the role colour.
   */
  readonly line: {
    readonly primary: string;
    readonly secondary: string;
    readonly context: string;
    /** Stroke width (px) for all line layers. */
    readonly width: number;
  };
  /** Label / tick typography. Defined here so axes and chrome share one source. */
  readonly font: {
    readonly family: string;
    readonly size: number;
  };
}

/**
 * The neutral default theme. `line.primary` matches the M1 `LineChart` default
 * (`#2563eb`), so adopting the theme channel doesn't shift existing renders.
 */
export const defaultTheme: ChartTheme = {
  line: {
    primary: '#2563eb',
    secondary: '#e8836b',
    context: '#5eb5a6',
    width: 1.5,
  },
  font: {
    family: 'system-ui, -apple-system, sans-serif',
    size: 11,
  },
};
