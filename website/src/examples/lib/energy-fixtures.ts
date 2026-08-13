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
import {
  DEMAND_GW,
  ECLIPSE_START_MS,
  ECLIPSE_STEP_MS,
  FORECAST_GW,
} from './spain-eclipse-samples';
import {
  ECLIPSE_SOLAR_START_MS,
  ECLIPSE_SOLAR_STEP_MS,
  SOLAR_AUG09_GW,
  SOLAR_AUG10_GW,
  SOLAR_AUG11_GW,
  SOLAR_ECLIPSE_DAY_GW,
} from './spain-eclipse-solar-samples';

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
 * order `gallery-grid-mix` paints and colours them in.
 *
 * Dispatchable conventional generation at the bottom, weather-driven
 * renewables on top: the convention energy-charts itself draws, and the one
 * that makes a mix chart legible, because the volatile bands are the ones
 * whose thickness you want to read against a flat top edge. It is also a real
 * split — four thermal sources then four renewable ones — which is why the
 * chart gives each half its own tonal family rather than running one ramp
 * across all eight.
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

const eclipseSchema = [
  { name: 'time', kind: 'time' },
  { name: 'demand', kind: 'number' },
  { name: 'forecast', kind: 'number' },
] as const;

/**
 * Peninsular Spain's demand against REE's own forecast, **GW at 5-minute
 * cadence**, across the evening of the 12 August 2026 total solar eclipse
 * (361 rows, 21:00 CEST on the 11th → 03:00 CEST on the 13th).
 *
 * Provenance and licence live in the header of `spain-eclipse-samples.ts`
 * (short version: **real measured data**, Source: Red Eléctrica,
 * demanda.ree.es, retrieved 2026-08-13). A different grid and a different
 * evening from the Easter-weekend fixture above — this one exists for the
 * ninety minutes where the two columns disagree.
 */
export function eclipseDemand() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < DEMAND_GW.length; i += 1) {
    rows.push([
      ECLIPSE_START_MS + i * ECLIPSE_STEP_MS,
      DEMAND_GW[i]!,
      FORECAST_GW[i]!,
    ]);
  }
  return new TimeSeries({ name: 'spain-demand', schema: eclipseSchema, rows });
}

/** `[begin, end]` of {@link eclipseDemand} — the full thirty hours, in ms. */
export function eclipseDemandRange(): [number, number] {
  return [
    ECLIPSE_START_MS,
    ECLIPSE_START_MS + (DEMAND_GW.length - 1) * ECLIPSE_STEP_MS,
  ];
}

const eclipseSolarSchema = [
  { name: 'time', kind: 'time' },
  { name: 'eclipseDay', kind: 'number' },
  { name: 'aug09', kind: 'number' },
  { name: 'aug10', kind: 'number' },
  { name: 'aug11', kind: 'number' },
] as const;

/**
 * The three ordinary days' columns, **oldest first** — the baseline pool,
 * and the order the spaghetti view draws them in. Kept as data so the
 * example can map over them instead of hard-coding three layers.
 */
export const ECLIPSE_BASELINE_DAYS = ['aug09', 'aug10', 'aug11'] as const;

/**
 * Spain's solar generation on eclipse day plus the three days before it, all
 * at the **same clock time**, GW at 15-minute cadence — one civil day
 * (96 rows, midnight to midnight CEST, 12 August 2026), with each earlier
 * day's curve plotted one, two or three days forward of when it happened so
 * the four evenings overlay.
 *
 * Provenance and licence live in the header of
 * `spain-eclipse-solar-samples.ts` (short version: **real measured data**,
 * energy-charts.info / Fraunhofer ISE, CC BY 4.0, upstream ENTSO-E). The
 * shifted-day overlay is the chart's whole device; any page drawing this
 * series must say the muted curves are earlier days, moved. The baseline
 * itself is deliberately NOT baked in here — computing it is one `collapse`,
 * and that computation belongs to the example so the docs can teach it.
 */
export function eclipseSolar() {
  const rows: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < SOLAR_ECLIPSE_DAY_GW.length; i += 1) {
    rows.push([
      ECLIPSE_SOLAR_START_MS + i * ECLIPSE_SOLAR_STEP_MS,
      SOLAR_ECLIPSE_DAY_GW[i]!,
      SOLAR_AUG09_GW[i]!,
      SOLAR_AUG10_GW[i]!,
      SOLAR_AUG11_GW[i]!,
    ]);
  }
  return new TimeSeries({
    name: 'spain-solar',
    schema: eclipseSolarSchema,
    rows,
  });
}

/** `[begin, end]` of {@link eclipseSolar} — eclipse day, midnight to
 *  midnight CEST, in ms. */
export function eclipseSolarRange(): [number, number] {
  return [
    ECLIPSE_SOLAR_START_MS,
    ECLIPSE_SOLAR_START_MS +
      (SOLAR_ECLIPSE_DAY_GW.length - 1) * ECLIPSE_SOLAR_STEP_MS,
  ];
}

/**
 * The eclipse's local circumstances over Spain, as epoch ms — the annotation
 * layer of the eclipse-demand and eclipse-solar cards. Times are Madrid's
 * (IGN, the Spanish national observatory: partials 19:31–21:22 CEST; the
 * umbra crossed northern Spain 20:27–20:32, Madrid itself a >99% partial).
 * Astronomy, not something derivable from the data columns — which is the
 * point of overlaying it.
 */
export const ECLIPSE_MARKS = {
  /** First contact over Madrid, 19:31 CEST. */
  partialsBegin: 1786555860000,
  /** Mid-totality over the peninsula, 20:29–20:30 CEST. */
  totality: 1786559370000,
  /** Last contact over Madrid, 21:22 CEST. */
  partialsEnd: 1786562520000,
} as const;
