/**
 * [PND-CHARTAPI] spike — what does the type seam actually *cost*?
 *
 * The 2026-08 API review's highest-value item: chart column props are bare
 * `string` on schema-generic components, and `BarChartProps` models every
 * source/column prop as independently optional (so `series` + `bins`
 * compiles and throws at render). The proposed fix is schema-derived column
 * names + a discriminated union of valid modes.
 *
 * The open question is **not** whether it type-checks — it's whether the
 * resulting errors are legible. A union of 4 modes × generic schema
 * inference is exactly the shape TypeScript reports worst ("no overload
 * matches", then four irrelevant candidate dumps). This file compiles each
 * variant against good and bad call sites; `run.mjs` captures the real tsc
 * text so the decision is made on evidence rather than taste.
 *
 * Not shipped code. Nothing here is imported by the package.
 */
import type { ReactNode } from 'react';
import type {
  NumericColumnNameForSchema,
  SeriesSchema,
  TimeSeries,
} from 'pond-ts';

// A representative schema — the shape every call site below is checked against.
type Cpu = readonly [
  { readonly name: 'time'; readonly kind: 'time' },
  { readonly name: 'cpu'; readonly kind: 'number' },
  { readonly name: 'host'; readonly kind: 'string' },
];

declare const cpuSeries: TimeSeries<Cpu>;
declare const bins: ReadonlyArray<{ start: number; end: number }>;
declare const cats: ReadonlyArray<{ label: string; value: number }>;

// ---------------------------------------------------------------------------
// V0 — today. Everything optional, columns are bare strings.
// ---------------------------------------------------------------------------

interface V0Props<S extends SeriesSchema = SeriesSchema> {
  series?: TimeSeries<S>;
  bins?: ReadonlyArray<{ start: number; end: number }>;
  categories?: ReadonlyArray<{ label: string; value: number }>;
  column?: string;
  columns?: readonly string[];
  orientation?: 'vertical' | 'horizontal';
}
declare function V0<S extends SeriesSchema>(p: V0Props<S>): ReactNode;

export const v0Good = <V0 series={cpuSeries} column="cpu" />;
// @ts-expect-error-CANDIDATE: a typo'd column — today this COMPILES (the bug).
export const v0Typo = <V0 series={cpuSeries} column="cpuu" />;
// @ts-expect-error-CANDIDATE: two sources at once — today this COMPILES.
export const v0TwoSources = <V0 series={cpuSeries} bins={bins} column="cpu" />;

// ---------------------------------------------------------------------------
// V1 — column names only (no union). The cheap half: does schema-derived
// naming survive JSX inference, and is the typo message readable?
// ---------------------------------------------------------------------------

interface V1Props<S extends SeriesSchema = SeriesSchema> {
  series?: TimeSeries<S>;
  bins?: ReadonlyArray<{ start: number; end: number }>;
  column?: NumericColumnNameForSchema<S>;
  columns?: readonly NumericColumnNameForSchema<S>[];
  orientation?: 'vertical' | 'horizontal';
}
declare function V1<S extends SeriesSchema>(p: V1Props<S>): ReactNode;

export const v1Good = <V1 series={cpuSeries} column="cpu" />;
// Expected: a clean '"cpuu" is not assignable to "cpu"'.
export const v1Typo = <V1 series={cpuSeries} column="cpuu" />;
// Expected: rejects the STRING column (only numeric columns are legal here).
export const v1StringCol = <V1 series={cpuSeries} column="host" />;

// ---------------------------------------------------------------------------
// V2 — the full discriminated union of modes. Fixes both the typo and the
// two-sources case, but this is where error messages usually degrade.
// ---------------------------------------------------------------------------

interface V2Common {
  orientation?: 'vertical' | 'horizontal';
  gap?: number;
}
type V2Props<S extends SeriesSchema = SeriesSchema> = V2Common &
  (
    | {
        series: TimeSeries<S>;
        column: NumericColumnNameForSchema<S>;
        bins?: never;
        categories?: never;
        columns?: never;
      }
    | {
        series: TimeSeries<S>;
        columns: readonly NumericColumnNameForSchema<S>[];
        bins?: never;
        categories?: never;
        column?: never;
      }
    | {
        bins: ReadonlyArray<{ start: number; end: number }>;
        column: string;
        series?: never;
        categories?: never;
        columns?: never;
      }
    | {
        categories: ReadonlyArray<{ label: string; value: number }>;
        series?: never;
        bins?: never;
        column?: never;
        columns?: never;
      }
  );
declare function V2<S extends SeriesSchema>(p: V2Props<S>): ReactNode;

export const v2Good = <V2 series={cpuSeries} column="cpu" />;
export const v2GoodBins = <V2 bins={bins} column="seconds" />;
export const v2GoodCats = <V2 categories={cats} />;
// The three errors whose MESSAGES are the decision:
export const v2Typo = <V2 series={cpuSeries} column="cpuu" />;
export const v2TwoSources = <V2 series={cpuSeries} bins={bins} column="cpu" />;
export const v2MissingColumn = <V2 series={cpuSeries} />;
// The review's own example: categories takes no `column`.
export const v2CatsWithColumn = <V2 categories={cats} column="value" />;
// A string column where a numeric one is required, through the union.
export const v2StringCol = <V2 series={cpuSeries} column="host" />;
