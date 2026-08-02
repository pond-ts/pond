import { TimeSeries, type SeriesSchema } from 'pond-ts';
import {
  COUNT,
  DEVICE,
  SAPS,
  START_MS,
  STEP_MS,
  type SapSamples,
} from './cern-traffic-samples';

/**
 * The CERN router capture, shaped into pond types for the Gallery's
 * network-traffic cards. Provenance, licensing and every reduction applied to
 * the numbers live in the header of `cern-traffic-samples.ts` — read that
 * first; this module only reassembles.
 *
 * Three views of the same six hours:
 *
 * - {@link sapSeries} — one interface, `in` / `out` in Gbps.
 * - {@link siteTotal} — every kept interface summed: the mirrored in/out
 *   chart's source.
 * - {@link stackedOutbound} — the site's outbound broken down by interface as
 *   **cumulative** columns, which is how you stack areas (each slab is drawn
 *   from zero to its running total, biggest first, and covers the one behind).
 */

export { DEVICE, COUNT, START_MS, STEP_MS };

/** The traffic schema every per-interface series uses. */
export const trafficSchema = [
  { name: 'time', kind: 'time' },
  { name: 'in', kind: 'number' },
  { name: 'out', kind: 'number' },
] as const;

/**
 * One interface in the envelope the router emits — **exactly** the shape the
 * raw capture carries (`{ name, columns, points }`, points as `[ms, in, out]`
 * row tuples), reassembled from the fixture's split arrays. This is the shape
 * `TimeSeries.fromJSON({ schema, rows: points })` reads with no mapping step.
 */
export interface SapTraffic {
  readonly name: string;
  readonly category: SapSamples['category'];
  readonly columns: readonly ['time', 'in', 'out'];
  readonly points: ReadonlyArray<readonly [number, number, number]>;
}

const at = (i: number) => START_MS + i * STEP_MS;

/** The kept interfaces, in descending order of carried volume. */
export const SAP_TRAFFIC: readonly SapTraffic[] = SAPS.map((sap) => ({
  name: sap.name,
  category: sap.category,
  columns: ['time', 'in', 'out'] as const,
  points: Array.from(
    { length: COUNT },
    (_, i) => [at(i), sap.in[i]!, sap.out[i]!] as const,
  ),
}));

/** Interface ids, busiest first. */
export const SAP_NAMES: readonly string[] = SAP_TRAFFIC.map((s) => s.name);

/** The full window the capture covers, as `[begin, end]` epoch ms. */
export const TRAFFIC_RANGE: readonly [number, number] = [at(0), at(COUNT - 1)];

/**
 * One interface as a `TimeSeries` — `in` and `out` in Gbps, both positive.
 * Pass a SAP id from {@link SAP_NAMES}; unknown ids throw rather than draw an
 * empty chart.
 */
export function sapSeries(name: string): TimeSeries<typeof trafficSchema> {
  const hit = sapCache.get(name);
  if (hit) return hit;
  const sap = SAP_TRAFFIC.find((s) => s.name === name);
  if (!sap) throw new Error(`no such interface: ${name}`);
  const series = TimeSeries.fromJSON({
    name: sap.name,
    schema: trafficSchema,
    rows: sap.points as Array<[number, number, number]>,
  });
  sapCache.set(name, series);
  return series;
}

/**
 * These builders are memoized because the cards animate: a card at 24 fps
 * calls its example's body 24 times a second, and rebuilding a 359-row series
 * each frame is both wasteful and churny — the chart layers key off series
 * identity, so a fresh instance every frame re-registers every layer.
 */
const sapCache = new Map<string, TimeSeries<typeof trafficSchema>>();

/**
 * Every kept interface summed — the site's total in and out, Gbps, **both
 * positive**. The mirrored chart negates one direction at draw time
 * (`mapColumns({ out: (v) => -v })`) rather than storing it negative, so the
 * numbers here stay the numbers the router reported.
 */
export function siteTotal(): TimeSeries<typeof trafficSchema> {
  if (totalCache) return totalCache;
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < COUNT; i += 1) {
    let inb = 0;
    let outb = 0;
    for (const sap of SAPS) {
      inb += sap.in[i]!;
      outb += sap.out[i]!;
    }
    rows.push([at(i), round2(inb), round2(outb)]);
  }
  totalCache = TimeSeries.fromJSON({
    name: `${DEVICE} total`,
    schema: trafficSchema,
    rows,
  });
  return totalCache;
}

let totalCache: TimeSeries<typeof trafficSchema> | undefined;

/**
 * The site's **outbound** traffic broken down by interface, as cumulative
 * columns `stack0 … stackN-1`: `stack0` is the busiest interface alone,
 * `stack1` is that plus the second, and the last column is the site total.
 *
 * Cumulative rather than per-interface because that is what stacking an area
 * chart means — draw the *largest* running total first and each smaller one
 * over it, and the visible slab between two adjacent edges is one interface's
 * contribution. `theme.area.seq1…seq8` fill flat for exactly this reason: a
 * graded fill would let the slabs behind show through.
 */
export function stackedOutbound(): TimeSeries<SeriesSchema> {
  if (stackCache) return stackCache;
  const rows: Array<[number, ...number[]]> = [];
  for (let i = 0; i < COUNT; i += 1) {
    const row: [number, ...number[]] = [at(i)];
    let running = 0;
    for (const sap of SAPS) {
      running += sap.out[i]!;
      row.push(round2(running));
    }
    rows.push(row);
  }
  stackCache = new TimeSeries({
    name: `${DEVICE} outbound by interface`,
    schema: stackSchema,
    rows,
  });
  return stackCache;
}

let stackCache: TimeSeries<SeriesSchema> | undefined;

/** Column name for the running total through interface `i` (0-based). */
export const stackColumn = (i: number): string => `stack${i}`;

/** `time` plus one cumulative column per kept interface. The column count is
 *  data-driven, so this schema is the general {@link SeriesSchema} rather than
 *  a literal tuple — the charts take either. */
const stackSchema: SeriesSchema = [
  { name: 'time', kind: 'time' },
  ...SAPS.map((_, i) => ({ name: stackColumn(i), kind: 'number' as const })),
];

/** Per-interface summary for the dashboard's table: peaks and means, Gbps. */
export interface SapStats {
  readonly name: string;
  readonly category: SapSamples['category'];
  readonly peakIn: number;
  readonly peakOut: number;
  readonly meanIn: number;
  readonly meanOut: number;
  /** Share of all bytes carried in the window, 0–1. */
  readonly share: number;
}

/** One row per kept interface, busiest first — the table panel's data. */
export function sapStats(): readonly SapStats[] {
  const volumes = SAPS.map((s) => sum(s.in) + sum(s.out));
  const total = volumes.reduce((a, b) => a + b, 0);
  return SAPS.map((s, i) => ({
    name: s.name,
    category: s.category,
    peakIn: Math.max(...s.in),
    peakOut: Math.max(...s.out),
    meanIn: round2(sum(s.in) / COUNT),
    meanOut: round2(sum(s.out) / COUNT),
    share: volumes[i]! / total,
  }));
}

function sum(xs: readonly number[]): number {
  let t = 0;
  for (const x of xs) t += x;
  return t;
}

/** Gbps to 10 Mbps, matching the fixture's own resolution. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}
