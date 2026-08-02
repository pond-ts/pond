/**
 * [PND-CHARTAPI] **type-level** tests — the guarantees here are compile-time,
 * so the assertions are `@ts-expect-error` directives rather than runtime
 * expectations. `npm run test:type` fails if any of them stops being an
 * error (an unused directive is itself an error), which is exactly the
 * regression signal we want.
 *
 * Included in the `tsconfig.types.json` sweep; deliberately **not** a
 * `.test.tsx`, so vitest doesn't try to run a file with no runtime cases.
 */
import { TimeSeries, ValueSeries } from 'pond-ts';
import type { SeriesSchema } from 'pond-ts';
import { BarChart } from '../src/BarChart.js';
import { BarList } from '../src/BarList.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { LineChart } from '../src/LineChart.js';

const cpu = new TimeSeries({
  name: 'cpu',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'cpu', kind: 'number' },
    { name: 'host', kind: 'string' },
  ] as const,
  rows: [[0, 1, 'web1']] as Array<[number, number, string]>,
});

const quantiles = new TimeSeries({
  name: 'q',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'p5', kind: 'number' },
    { name: 'p95', kind: 'number' },
  ] as const,
  rows: [[0, 1, 9]] as Array<[number, number, number]>,
});

/**
 * A **loosely-typed** series — the case the spike found would break under a
 * naive constraint (`NumericColumnNameForSchema<SeriesSchema>` is `never`).
 * Nothing in the rest of this repo's suite covers it, because every other
 * fixture uses an `as const` schema.
 */
declare const loose: TimeSeries<SeriesSchema>;

// ── Column names: a real column compiles, a typo does not ──────────────────

export const okColumn = <LineChart series={cpu} column="cpu" />;
// @ts-expect-error — 'cpuu' is not a column of the schema.
export const typoColumn = <LineChart series={cpu} column="cpuu" />;
// @ts-expect-error — 'host' exists but is a string column, not numeric.
export const stringColumn = <LineChart series={cpu} column="host" />;
export const okReadout = <LineChart series={cpu} column="cpu" readout="cpu" />;
export const typoReadout = (
  // @ts-expect-error — the readout column is schema-checked too.
  <LineChart series={cpu} column="cpu" readout="nope" />
);

// ── The loose-schema fallback: any string still compiles ───────────────────

export const looseAnyName = <LineChart series={loose} column="whatever" />;
export const looseBar = <BarChart series={loose} column="anything" />;

// ── BoxPlot's quantile props take the same constraint ─────────────────────

export const okBox = <BoxPlot series={quantiles} lower="p5" upper="p95" />;
// @ts-expect-error — 'p50' is not in this schema.
export const typoBox = <BoxPlot series={quantiles} lower="p5" upper="p50" />;

// ── BarChart's mode union: legal modes compile ────────────────────────────

export const okSeriesColumn = <BarChart series={cpu} column="cpu" />;
export const okBins = <BarChart bins={[{ start: 0, end: 1 }]} column="n" />;
export const okCategories = (
  <BarChart categories={[{ label: 'a', value: 1 }]} />
);

// ── …and illegal mixes do not (each was a runtime throw before) ───────────

export const twoSources = (
  // @ts-expect-error — two sources at once.
  <BarChart series={cpu} bins={[{ start: 0, end: 1 }]} column="cpu" />
);
export const bothColumnForms = (
  // @ts-expect-error — `column` and `columns` are mutually exclusive.
  <BarChart series={cpu} column="cpu" columns={['cpu']} />
);
export const catsWithColumn = (
  // @ts-expect-error — `categories` takes no `column`.
  <BarChart categories={[{ label: 'a', value: 1 }]} column="cpu" />
);
// @ts-expect-error — a source with no column form at all.
export const seriesNoColumn = <BarChart series={cpu} />;

// ── The list family's rows XOR series ─────────────────────────────────────

export const okRows = (
  <BarList
    rows={[{ key: 'a', values: { v: 1 } }]}
    columns={[{ column: 'v' }]}
  />
);
export const okListSeries = (
  <BarList series={cpu} columns={[{ column: 'cpu' }]} />
);
// @ts-expect-error — neither door.
export const noDoor = <BarList columns={[{ column: 'v' }]} />;
export const bothDoors = (
  // @ts-expect-error — both doors.
  <BarList
    rows={[{ key: 'a', values: { v: 1 } }]}
    series={cpu}
    columns={[{ column: 'v' }]}
  />
);

/**
 * The #590 review's hazard, now a compile error: `R` used to be inferred from
 * the *callbacks*, so annotating one while passing `series` claimed a custom
 * row shape the series door cannot produce (it yields plain `ListRow`s).
 */
interface MyRow {
  key: string;
  values: Record<string, number>;
  extra: string;
}
export const lyingGeneric = (
  // @ts-expect-error — the series door yields ListRow, not MyRow.
  <BarList
    series={cpu}
    columns={[{ column: 'cpu' }]}
    renderExpanded={(r: MyRow) => r.extra}
  />
);
// Through the record door the same annotation is sound.
export const honestGeneric = (
  <BarList
    rows={[{ key: 'a', values: { v: 1 }, extra: 'x' }] as MyRow[]}
    columns={[{ column: 'v' }]}
    renderExpanded={(r) => r.extra}
  />
);

// ── A ValueSeries is checked against its own axis schema ──────────────────

const smile = ValueSeries.fromColumns({
  name: 'smile',
  schema: [
    { name: 'strike', kind: 'value' },
    { name: 'iv', kind: 'number' },
  ] as const,
  columns: { strike: [90, 100], iv: [0.3, 0.25] },
});
export const okValueSeries = <LineChart series={smile} column="iv" />;
// @ts-expect-error — 'vol' is not a column of the value schema.
export const typoValueSeries = <LineChart series={smile} column="vol" />;
