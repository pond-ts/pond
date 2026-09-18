/**
 * Compile-time half of the ingest page's example harness — the runtime half is
 * `test/docs-creating-examples.test.ts`.
 *
 * This file exists because `test/` is **not** type-checked (`tsconfig.types`
 * includes `src` and `test-d` only), and the Layer 2 review of PR #564 found a
 * doc example that failed to *compile* rather than at runtime:
 * `TimeSeries.fromEvents(events, { schema })`, whose `name` is required. A
 * vitest run can never catch that class — `venue`-style missing arguments throw,
 * but a missing required *option* on a call the reader would paste is a
 * type error, and only `tsc` sees it.
 *
 * So: every call shape the page teaches gets written out here as it appears on
 * the page, and the ones the page claims are rejected get an
 * `@ts-expect-error` — which fails the build if the library ever starts
 * accepting them, forcing the prose to be revisited. That second direction is
 * the load-bearing one: [PND-COLBOOL] is on the roadmap to make `boolean` /
 * array columns ingestable, and when it lands the assertion below will break
 * and point at the paragraph that needs deleting.
 */

import { TimeSeries, ValueSeries } from '../src/index.js';

const CPU = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

declare const cpuSeries: TimeSeries<typeof CPU>;

// ── Introduction: the two "smaller doors" ───────────────────────────────────
// `fromEvents` requires BOTH schema and name; `fromPoints` defaults its name.
// The page states each accordingly — this pins that asymmetry, which is what
// made the wrong version look right sitting beside the correct one.
TimeSeries.fromEvents([...cpuSeries.events], { schema: CPU, name: 'cpu' });
TimeSeries.fromPoints([{ ts: 0, cpu: 0.3, host: 'api-1' }], { schema: CPU });

// @ts-expect-error — `name` is required on fromEvents (the reviewed defect).
TimeSeries.fromEvents([...cpuSeries.events], { schema: CPU });

// ── Columnar: the typed round trip the page promises "without a cast" ───────
const BARS = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'venue', kind: 'string' },
] as const;

declare const bars: TimeSeries<typeof BARS>;

// "the round trip is typed end to end — no cast, and the result is a
// TimeSeries<typeof schema>, not a widened one."
const restored: TimeSeries<typeof BARS> = TimeSeries.fromColumns(
  bars.toColumns(),
);
void restored;

// The across-a-wire variant, with the annotation the page tells you to write.
declare const wire: string;
const parsed = JSON.parse(wire) as ReturnType<typeof bars.toColumns>;
void TimeSeries.fromColumns(parsed);

// ── The boolean/array claim in "Common ingest issues" ───────────────────────
// The page states this round trip "fails to _compile_ rather than at runtime".
const WITH_BOOL = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'healthy', kind: 'boolean' },
] as const;

declare const withBool: TimeSeries<typeof WITH_BOOL>;

// @ts-expect-error — boolean columns export but cannot be ingested back.
// When [PND-COLBOOL] lands this stops erroring, and the doc paragraph goes.
void TimeSeries.fromColumns(withBool.toColumns());

// ── ValueSeries: the three direct doors, as the page spells them ────────────
const CHAIN = [
  { name: 'strike', kind: 'value' },
  { name: 'iv', kind: 'number' },
  { name: 'oi', kind: 'number' },
] as const;

ValueSeries.fromJSON({
  name: 'chain',
  schema: CHAIN,
  rows: [
    [90, 0.31, 1200],
    [95, 0.28, 3400],
  ],
});

const chain = ValueSeries.fromColumns({
  name: 'chain',
  schema: CHAIN,
  columns: { strike: [90, 95], iv: [0.31, 0.28], oi: [1200, 3400] },
});

// Same "no cast" promise on the value side.
const chainBack: ValueSeries<typeof CHAIN> = ValueSeries.fromColumns(
  chain.toColumns(),
);
void chainBack;

// `axis` is required on the Arrow door — the page's stated divergence from
// `TimeSeries.fromArrow`, which falls back to a field named 'time'.
declare const table: Parameters<typeof ValueSeries.fromArrow>[0];
ValueSeries.fromArrow(table, { axis: 'strike' });

// @ts-expect-error — no `axis`, and there is no convention to fall back on.
ValueSeries.fromArrow(table, {});
