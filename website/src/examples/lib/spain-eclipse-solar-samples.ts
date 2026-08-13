/**
 * **Real measured data.** Spain's solar generation on the day of the
 * **12 August 2026 total solar eclipse**, plus the three days before it —
 * 96 quarter-hours each (midnight to midnight CEST), the API's native
 * 15-minute cadence. Four civil days, one shared index: sample *i* of every
 * array is the same clock time. The three ordinary days exist to be a
 * baseline; on the 12th the Moon took a second, faster sunset out of the
 * middle of the real one.
 *
 * **Source and licence.** energy-charts.info (Fraunhofer ISE) —
 * https://api.energy-charts.info, `/public_power?country=es` (upstream:
 * ENTSO-E). Retrieved 2026-08-13, the morning after the eclipse. The endpoint
 * does not restate a licence per response; Energy-Charts publishes under
 * **CC BY 4.0** site-wide, so the attribution here (Fraunhofer ISE /
 * energy-charts.info, upstream ENTSO-E) is what CC BY asks for. Same source
 * family as `energy-samples.ts`, which documents the licence situation in
 * more detail.
 *
 * **What was kept.** The API's single `Solar` channel, for the four days,
 * converted MW → **GW** at 2 dp (10 MW resolution): `SOLAR_ECLIPSE_DAY_GW`
 * (the 12th) and `SOLAR_AUG09_GW` / `SOLAR_AUG10_GW` / `SOLAR_AUG11_GW`
 * (the ordinary days). ENTSO-E reports Spanish solar as one category, so PV
 * and solar-thermal are not separable here. Everything else — the fourteen
 * other production types, load, the derived shares — belongs to other cards'
 * questions and was dropped.
 *
 * **Quirks.** Drawing the ordinary days on eclipse day's axis means each is
 * plotted one, two or three days forward of when it happened — the
 * same-clock-time overlay is the whole device, and every page that draws it
 * must say so. All four days are complete (no gaps, no nulls; alignment
 * validated to exactly 24 h between consecutive days at every index), and
 * none ever reads zero: each enters the night around **0.5–0.65 GW** and
 * drains to **0.12–0.22 GW** before dawn, because ENTSO-E's single Solar
 * category includes concentrated solar plants discharging thermal storage
 * after dark.
 *
 * Generated once by `website/scripts/fixtures/spain-eclipse-solar.mjs`, then
 * committed — the docs site fetches nothing.
 */

/** First sample: 2026-08-11T22:00:00.000Z (00:00 CEST, 12 Aug). */
export const ECLIPSE_SOLAR_START_MS = 1786485600000;

/** Cadence of every column: the API's native 15 minutes. */
export const ECLIPSE_SOLAR_STEP_MS = 900000;

/** Solar generation on eclipse day (12 August 2026), GW. */
// prettier-ignore
export const SOLAR_ECLIPSE_DAY_GW: readonly number[] = [
  0.62, 0.62, 0.61, 0.61, 0.61, 0.61, 0.61, 0.61, 0.61, 0.61, 0.61, 0.61, 0.61,
  0.61, 0.6, 0.59, 0.56, 0.52, 0.51, 0.5, 0.49, 0.44, 0.44, 0.43, 0.38, 0.3,
  0.25, 0.2, 0.21, 0.26, 0.53, 1.39, 2.97, 5.23, 8, 10.94, 14.48, 17.5, 20.25,
  22.88, 24.43, 24.95, 25.58, 26.1, 27.2, 27.33, 27.94, 27.89, 27.92, 27.88,
  27.94, 28.05, 28.08, 28.44, 27.78, 28.5, 28.84, 29.32, 29.22, 29.67, 29.39,
  29.42, 29.37, 29.27, 29.33, 28.85, 28.26, 28.36, 28.5, 28.02, 26.94, 25.93,
  24.37, 23.05, 21.7, 19.56, 18.03, 15.57, 12.88, 9.31, 4.97, 1.95, 1.04, 1.03,
  0.86, 0.69, 0.64, 0.62, 0.61, 0.61, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6,
];

/** Solar generation on 2026-08-09 — indexed to the same clock time as
 *  `SOLAR_ECLIPSE_DAY_GW`, 3 days earlier. GW. */
// prettier-ignore
export const SOLAR_AUG09_GW: readonly number[] = [
  0.54, 0.52, 0.48, 0.44, 0.42, 0.42, 0.42, 0.42, 0.42, 0.42, 0.41, 0.38, 0.38,
  0.36, 0.36, 0.36, 0.36, 0.33, 0.3, 0.28, 0.26, 0.22, 0.16, 0.14, 0.14, 0.13,
  0.12, 0.12, 0.24, 0.44, 0.8, 1.72, 3.21, 5.41, 8.15, 11.3, 14.46, 17.21, 19.51,
  20.78, 22.3, 23.22, 24.5, 24.22, 24.02, 24.58, 24.75, 24.91, 24.92, 25.1,
  25.42, 25.37, 25.27, 24.83, 25.22, 25.12, 25.4, 25.25, 25.44, 25.02, 24.54,
  24.71, 25.08, 24.33, 23.68, 23.59, 23.81, 23.84, 23.52, 23.28, 23.35, 22.71,
  21.58, 21.08, 20.52, 19.4, 17.99, 16.42, 13.88, 11.22, 8.88, 6.51, 4.24, 2.52,
  1.35, 0.86, 0.72, 0.69, 0.68, 0.67, 0.66, 0.65, 0.65, 0.66, 0.65, 0.65,
];

/** Solar generation on 2026-08-10 — indexed to the same clock time as
 *  `SOLAR_ECLIPSE_DAY_GW`, 2 days earlier. GW. */
// prettier-ignore
export const SOLAR_AUG10_GW: readonly number[] = [
  0.65, 0.65, 0.64, 0.57, 0.56, 0.54, 0.54, 0.54, 0.54, 0.53, 0.51, 0.48, 0.43,
  0.38, 0.33, 0.29, 0.29, 0.28, 0.27, 0.26, 0.24, 0.22, 0.2, 0.17, 0.16, 0.14,
  0.12, 0.12, 0.23, 0.32, 0.66, 1.54, 3.05, 5.27, 7.96, 11.07, 14.32, 17.28,
  20.11, 22.34, 23.7, 24.72, 25.59, 26.57, 26.9, 27.53, 27.48, 27.3, 26.56,
  26.52, 26.82, 26.58, 26.65, 26.99, 27.14, 27.3, 27.66, 27.78, 27.53, 27.15,
  26.63, 26.27, 25.82, 25.25, 25.6, 25.01, 24.51, 23.67, 22.84, 22.33, 22, 21.49,
  20.85, 20.06, 19.26, 18.18, 17.2, 15.29, 13.1, 11.1, 8.52, 5.94, 3.82, 2.23,
  1.23, 0.78, 0.62, 0.59, 0.58, 0.58, 0.57, 0.57, 0.56, 0.53, 0.51, 0.51,
];

/** Solar generation on 2026-08-11 — indexed to the same clock time as
 *  `SOLAR_ECLIPSE_DAY_GW`, 1 day earlier. GW. */
// prettier-ignore
export const SOLAR_AUG11_GW: readonly number[] = [
  0.51, 0.5, 0.5, 0.49, 0.49, 0.48, 0.45, 0.46, 0.46, 0.46, 0.46, 0.46, 0.45,
  0.46, 0.46, 0.46, 0.45, 0.43, 0.43, 0.42, 0.41, 0.38, 0.37, 0.34, 0.33, 0.3,
  0.26, 0.22, 0.33, 0.38, 0.69, 1.58, 3.21, 5.64, 8.52, 11.73, 15.05, 18.33,
  21.04, 23.25, 24.66, 25.7, 26.32, 26.85, 27.14, 27.11, 27.38, 27.67, 27.54,
  27.61, 28.12, 28.02, 27.65, 27.76, 28.26, 28.44, 28.54, 28.64, 28.66, 28.32,
  28.55, 28.26, 28.24, 27.96, 28.5, 28.68, 28.89, 28.84, 28.54, 28.01, 27.56,
  26.89, 25.38, 24.67, 23.74, 22.7, 20.74, 18.45, 15.25, 11.96, 9.08, 6.42, 4.02,
  2.3, 1.36, 0.93, 0.77, 0.72, 0.71, 0.71, 0.71, 0.7, 0.67, 0.64, 0.64, 0.63,
];
