import { TimeSeries } from 'pond-ts';
import {
  BIOMASS_GW,
  GAS_GW,
  GRID_START_MS,
  GRID_STEP_MS,
  HARD_COAL_GW,
  HYDRO_GW,
  LIGNITE_GW,
  LOAD_GW,
  OTHER_GW,
  PRICE_EUR_MWH,
  PRICE_START_MS,
  PRICE_STEP_MS,
  SOLAR_GW,
  WIND_GW,
} from './energy-samples';

/**
 * The Gallery's **Energy** track (plan §4, track D) — grid mix, renewables
 * against demand, and negative day-ahead prices, all three from one weekend of
 * real German grid data.
 *
 * Provenance, licence and what was kept/dropped live in the header of
 * `energy-samples.ts`, which this module only shapes: numbers there, pond
 * types here. Short version: **real measured data**, energy-charts.info
 * (Fraunhofer ISE), CC BY 4.0, Easter weekend 2025.
 */

/**
 * The eight generation bands **bottom-of-stack first**, which is also the
 * order the sequential ramp steps through (`seq1` darkest at the bottom →
 * `seq8` lightest on top, so solar — the thing that makes this weekend
 * interesting — ends up the brightest slab).
 *
 * Dispatchable conventional generation at the bottom, weather-driven
 * renewables on top: the convention energy-charts itself draws, and the one
 * that makes a mix chart legible, because the volatile bands are the ones
 * whose thickness you want to read against a flat top edge.
 */
export const GRID_BANDS = [
  { column: 'other', label: 'Other' },
  { column: 'lignite', label: 'Lignite' },
  { column: 'hardCoal', label: 'Hard coal' },
  { column: 'gas', label: 'Gas' },
  { column: 'biomass', label: 'Biomass' },
  { column: 'hydro', label: 'Hydro' },
  { column: 'wind', label: 'Wind' },
  { column: 'solar', label: 'Solar' },
] as const;

const gridSchema = [
  { name: 'time', kind: 'time' },
  { name: 'other', kind: 'number' },
  { name: 'lignite', kind: 'number' },
  { name: 'hardCoal', kind: 'number' },
  { name: 'gas', kind: 'number' },
  { name: 'biomass', kind: 'number' },
  { name: 'hydro', kind: 'number' },
  { name: 'wind', kind: 'number' },
  { name: 'solar', kind: 'number' },
  { name: 'load', kind: 'number' },
] as const;

/**
 * German generation by band plus total load, **GW at 15-minute cadence**, over
 * Easter weekend 2025 (288 rows, Sat 19 – Mon 21 April, CEST).
 *
 * One series carries both the eight generation bands and `load` because every
 * card in the track asks the same data a different question: D1 stacks the
 * bands, D2 puts `wind + solar` against `load`, and D3's prices are the
 * consequence of the gap between them.
 */
export function gridMix() {
  const rows: Array<
    [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ]
  > = [];
  for (let i = 0; i < LOAD_GW.length; i += 1) {
    rows.push([
      GRID_START_MS + i * GRID_STEP_MS,
      OTHER_GW[i]!,
      LIGNITE_GW[i]!,
      HARD_COAL_GW[i]!,
      GAS_GW[i]!,
      BIOMASS_GW[i]!,
      HYDRO_GW[i]!,
      WIND_GW[i]!,
      SOLAR_GW[i]!,
      LOAD_GW[i]!,
    ]);
  }
  return new TimeSeries({ name: 'german-grid', schema: gridSchema, rows });
}

/** `[begin, end]` of {@link gridMix} — the whole weekend, in ms. */
export function gridMixRange(): [number, number] {
  return [GRID_START_MS, GRID_START_MS + (LOAD_GW.length - 1) * GRID_STEP_MS];
}

/** Local midnight (CEST) that starts Easter Sunday, the day everything happens
 *  on: the demand trough, the wind+solar crossover, the −52.42 EUR/MWh hour. */
export const EASTER_SUNDAY_MS = GRID_START_MS + 96 * GRID_STEP_MS;

const priceSchema = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'price', kind: 'number' },
] as const;

/**
 * DE-LU **day-ahead** price, EUR/MWh, one row per auction hour (72 rows over
 * the same weekend). Keyed by the hour's `timeRange` rather than by an instant,
 * because a day-ahead price *is* a span — and because that is what gives
 * `<BarChart>` a bar width to draw.
 *
 * Eight of the 72 hours clear **below zero**: more must-run generation than
 * demand, so sellers pay to deliver.
 */
export function dayAheadPrice() {
  const rows: Array<[{ start: number; end: number }, number]> =
    PRICE_EUR_MWH.map((price, i) => [
      {
        start: PRICE_START_MS + i * PRICE_STEP_MS,
        end: PRICE_START_MS + (i + 1) * PRICE_STEP_MS,
      },
      price,
    ]);
  return new TimeSeries({ name: 'de-lu-day-ahead', schema: priceSchema, rows });
}

/** `[begin, end]` of {@link dayAheadPrice} — the whole weekend, in ms. */
export function dayAheadPriceRange(): [number, number] {
  return [
    PRICE_START_MS,
    PRICE_START_MS + PRICE_EUR_MWH.length * PRICE_STEP_MS,
  ];
}
