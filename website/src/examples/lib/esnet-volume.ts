import { TimeSeries } from 'pond-ts';
import {
  LHCONE_IN,
  OSCARS_IN,
  TOTAL_IN,
  VOLUME_MONTHS,
  VOLUME_START_MONTH,
} from './esnet-volume-samples';

/**
 * ESnet's traffic-volume history, shaped for the charts — **real measured
 * data**; provenance and what was dropped are in `esnet-volume-samples.ts`.
 *
 * One `TimeSeries`, three columns, keyed at each month's **first instant in
 * UTC**. A monthly total is a fact about a whole month rather than about an
 * instant, so the chart draws a `<Region>` over the selected month's calendar
 * span (`TimeRange.fromCalendar('month', …)`) to show the extent a point
 * stands for.
 *
 * `lhcone` and `oscars` are declared `required: false`, which is what lets
 * them be **absent** for the months before they existed rather than zero — a
 * distinction a log axis makes unmissable, since zero has no position on one.
 */
export const VOLUME_SCHEMA = [
  { name: 'time', kind: 'time' },
  /** Every byte ESnet carried inbound that month. Runs the whole record. */
  { name: 'total', kind: 'number' },
  /** LHCONE — the LHC experiments' overlay network. From 2015-01. */
  { name: 'lhcone', kind: 'number', required: false },
  /** OSCARS — bandwidth-reserved circuits. From 2009-01. */
  { name: 'oscars', kind: 'number', required: false },
] as const;

const [START_YEAR, START_MONTH] = VOLUME_START_MONTH.split('-').map(Number) as [
  number,
  number,
];

/**
 * `YYYY-MM` for month `i` of the record. The reference
 * `TimeRange.fromCalendar('month', …)` reads to place the highlight band, and
 * the label the month stepper prints.
 */
export function volumeMonth(i: number): string {
  const ordinal = START_YEAR * 12 + (START_MONTH - 1) + i;
  const month = (ordinal % 12) + 1;
  return `${Math.floor(ordinal / 12)}-${String(month).padStart(2, '0')}`;
}

/** Epoch ms at the first instant of month `i`, UTC. `i === VOLUME_MONTHS` is
 *  the instant the record ends — the month after the last one starts. */
export function volumeMonthStart(i: number): number {
  return Date.UTC(START_YEAR, START_MONTH - 1 + i, 1);
}

export { VOLUME_MONTHS, VOLUME_START_MONTH } from './esnet-volume-samples';

/** The record's full extent: the first month's start to the last month's end. */
export const VOLUME_RANGE: readonly [number, number] = [
  volumeMonthStart(0),
  volumeMonthStart(VOLUME_MONTHS),
];

/** Index of the newest month — what "Show most recent month" jumps to. */
export const VOLUME_LAST = VOLUME_MONTHS - 1;

/**
 * The three inbound series as one `TimeSeries`. One series rather than three
 * because the chart reads all of them at one instant: `cursor="line"` prints
 * every column at the hovered month from a single sample.
 */
export function volumeSeries(): TimeSeries<typeof VOLUME_SCHEMA> {
  cache ??= TimeSeries.fromJSON({
    name: 'esnet-volume',
    schema: VOLUME_SCHEMA,
    rows: Array.from({ length: VOLUME_MONTHS }, (_, i) => [
      volumeMonthStart(i),
      TOTAL_IN[i]!,
      LHCONE_IN[i],
      OSCARS_IN[i],
    ]),
  });
  return cache;
}

/** Built once: the Gallery card animates, so the example body runs ~24× a
 *  second and a fresh series identity would re-register every layer. */
let cache: TimeSeries<typeof VOLUME_SCHEMA> | undefined;

/** One month's four numbers, in the order the summary table lists them.
 *  `normal` is **derived**: total − lhcone − oscars, the traffic that is
 *  neither reserved circuits nor LHC overlay. */
export interface VolumeMonth {
  readonly total: number;
  readonly lhcone: number | null;
  readonly oscars: number | null;
  readonly normal: number;
}

/**
 * Month `i`'s numbers. A series that has not started yet reads `null` — and
 * `normal` correctly collapses to the total, because before OSCARS and LHCONE
 * existed every byte was ordinary traffic.
 */
export function volumeAt(i: number): VolumeMonth {
  const total = TOTAL_IN[i]!;
  const lhcone = LHCONE_IN[i] ?? null;
  const oscars = OSCARS_IN[i] ?? null;
  return {
    total,
    lhcone,
    oscars,
    normal: total - (lhcone ?? 0) - (oscars ?? 0),
  };
}
