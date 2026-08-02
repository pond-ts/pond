/**
 * **Real, measured data** — three US-government sources, all public domain.
 * The Gallery's weather & climate track (`gallery-c*.tsx`) draws all four of
 * its charts from this one module.
 *
 * ## 1. Seattle-Tacoma Intl (SEA), calendar 2024 — daily
 *
 * Daily maximum / minimum temperature (°C) and precipitation (mm) for GHCN
 * station `USW00024233`, from **NOAA NCEI's GHCN-Daily** `daily-summaries`
 * service (https://www.ncei.noaa.gov/access/services/data/v1), retrieved
 * 2026-08-02. Public domain (a work of the US government).
 *
 * One value per calendar day, so the **index is the day offset** from
 * `SEA_DAY0_MS` — no parallel time array to keep in step. Kept: TMAX, TMIN,
 * PRCP. Dropped: SNOW/SNWD (near-zero at sea level here) and the observation
 * flags, which say how a value was measured rather than what it was.
 *
 * The `null`s are the station's own reporting gaps and stay in rather than
 * being interpolated: **TMIN** is missing 2024-04-25 and
 * **PRCP** 2024-04-24 and 2024-04-25 (TMAX is complete). They are why the
 * temperature band has a one-day hole in it and why the cumulative-rainfall
 * line holds flat across two days — missing data is a thing pond represents,
 * and a docs fixture shouldn't pretend otherwise.
 *
 * The 203 days of `0` in the precipitation channel are equally real:
 * this is a dry-summer climate, and of the 818.0 mm that fell
 * in 2024, the wettest single day (2024-02-28) took
 * 24.1 mm of it.
 *
 * ## 2. The same station, 2024 — hourly wind, binned
 *
 * Hourly METAR (`FM-15`) reports from **NOAA NCEI's Local Climatological
 * Data** service for WBAN `72793024233` — the same airport — retrieved
 * 2026-08-02, also public domain. The 8,735
 * observations were **binned offline into 16 compass sectors × 12 months**
 * (`SEA_WIND_HOURS`), because the chart is a distribution: shipping every
 * hour to draw 16 bars would be silly, and the binning is not the lesson.
 *
 * Two categories have no direction to bin and are kept separately rather than
 * folded into a sector: **calm** (621 hours,
 * reported as direction 000 with zero speed) and **variable**
 * (315 hours of `VRB` — a direction
 * shifting faster than the observation resolves). That leaves
 * 7,799 directed
 * hours in the sector matrix.
 *
 * ## 3. Global annual temperature anomaly, 1880–2025
 *
 * **NASA GISS Surface Temperature Analysis (GISTEMP v4)**, land-ocean index,
 * annual means (the `J-D` column of `GLB.Ts+dSST.csv`), retrieved 2026-08-02.
 * Public domain (NASA). Values are °C relative to the 1951–1980 mean — the
 * series behind the "warming stripes". Only complete years are kept, so the
 * current partial year is absent; GISTEMP revises history as station records
 * are homogenised, hence the retrieval date.
 *
 * Generated once by `website/scripts/fixtures/weather.mjs`, then committed.
 */

/** Midnight UTC on 2024-01-01 — the key of `SEA_*[0]`. */
export const SEA_DAY0_MS = Date.UTC(2024, 0, 1);

/** GHCN station id, WMO/WBAN id, and the station's own name. */
export const SEA_STATION = {
  ghcn: 'USW00024233',
  wban: '72793024233',
  name: 'Seattle-Tacoma International Airport, WA',
} as const;

/** Daily maximum temperature, °C. One per calendar day of 2024. */
// prettier-ignore
export const SEA_TMAX_C: ReadonlyArray<number | null> = [
  8.3, 8.3, 10, 7.8, 8.3, 6.7, 5, 9.4, 8.9, 5, 7.2, -3.8, -5.5, -0.5, 3.3,
  2.2, 4.4, 3.9, 8.3, 10.6, 8.9, 10.6, 11.1, 10.6, 10.6, 11.7, 13.9, 16.1,
  16.1, 16.1, 15.6, 14.4, 12.2, 10.6, 10, 7.2, 7.8, 8.9, 8.3, 9.4, 10, 11.1,
  8.3, 9.4, 9.4, 6.7, 10, 12.2, 10, 8.9, 12.2, 10.6, 13.3, 11.1, 10, 10,
  6.7, 7.8, 10, 6.1, 6.1, 6.7, 6.1, 7.2, 7.2, 7.2, 8.3, 12.2, 11.7, 10, 9.4,
  9.4, 11.1, 13.9, 16.7, 23.3, 21.7, 18.9, 17.8, 10.6, 13.3, 11.7, 11.7,
  14.4, 11.1, 12.8, 11.7, 12.2, 15, 14.4, 16.1, 16.1, 19.4, 11.7, 7.8, 11.1,
  8.3, 12.2, 11.7, 12.8, 14.4, 12.8, 13.9, 17.2, 18.3, 13.3, 12.2, 15, 17.8,
  20, 22.2, 14.4, 16.1, 21.1, 12.2, 11.7, 16.1, 11.1, 11.7, 12.2, 13.3,
  14.4, 18.9, 18.9, 12.8, 10.6, 12.8, 15, 17.8, 23.3, 28.9, 28.3, 23.9,
  17.2, 21.7, 23.9, 17.8, 17.2, 14.4, 16.7, 17.8, 11.1, 15.6, 16.1, 13.9,
  16.1, 15, 19.4, 15.6, 17.2, 17.2, 22.2, 17.2, 15, 15, 16.7, 18.9, 22.2,
  25, 25.6, 21.7, 21.1, 19.4, 19.4, 20, 17.8, 15.6, 17.8, 16.1, 19.4, 26.1,
  28.9, 30, 23.9, 19.4, 21.1, 26.7, 21.1, 18.9, 21.7, 23.9, 24.4, 24.4,
  21.7, 24.4, 28.3, 31.7, 32.8, 33.9, 35, 36.7, 31.1, 28.3, 28.3, 31.1,
  28.3, 26.7, 31.1, 28.3, 28.3, 28.9, 31.1, 25, 20, 24.4, 25, 22.8, 25.6,
  25.6, 20.6, 20.6, 24.4, 26.7, 30.6, 30, 27.8, 29.4, 25, 21.1, 26.7, 30.6,
  28.9, 25, 21.7, 22.8, 21.7, 25, 23.3, 23.9, 26.1, 25.6, 25, 20, 20.6,
  21.1, 15, 16.7, 22.8, 21.7, 20, 21.1, 26.1, 28.3, 28.9, 27.8, 21.1, 22.2,
  25.6, 32.2, 31.1, 25, 23.9, 19.4, 21.7, 19.4, 20, 17.8, 18.9, 17.8, 20,
  17.2, 21.1, 20, 17.8, 21.1, 21.1, 22.8, 25.6, 18.3, 20, 18.9, 16.7, 17.2,
  19.4, 20, 17.2, 18.9, 16.1, 17.8, 19.4, 23.9, 18.9, 16.1, 15, 14.4, 18.9,
  22.2, 18.9, 15, 16.1, 12.8, 11.7, 18.3, 18.9, 12.2, 13.9, 11.7, 12.8, 15,
  16.1, 13.9, 12.8, 12.2, 10.6, 10.6, 10.6, 11.7, 11.1, 12.8, 11.7, 12.8,
  15, 16.1, 11.7, 12.8, 11.1, 11.7, 12.8, 10, 8.9, 7.8, 9.4, 6.1, 8.9, 12.8,
  10, 15, 10, 7.8, 8.9, 7.2, 7.2, 6.1, 6.1, 6.7, 8.9, 13.3, 6.1, 3.3, 10.6,
  9.4, 10.6, 8.3, 8.9, 6.7, 11.1, 7.8, 7.8, 10, 8.3, 9.4, 13.3, 12.8, 12.8,
  15, 14.4, 11.7, 12.8, 10.6, 7.2, 10.6, 8.9, 10, 8.3, 7.2, 7.2,
];

/** Daily minimum temperature, °C. */
// prettier-ignore
export const SEA_TMIN_C: ReadonlyArray<number | null> = [
  1.1, 3.3, 5, 5, 4.4, 2.2, 2.2, 2.8, 2.8, 1.7, -3.8, -9.3, -9.3, -7.1, -6,
  -5.5, -1, 1.1, 2.8, 1.7, 5.6, 6.7, 6.1, 6.1, 5.6, 6.7, 8.9, 10.6, 10.6,
  10.6, 10, 8.3, 6.1, 2.8, 3.9, 5, 5, 3.9, 4.4, 2.8, 2.2, 5.6, 6.1, 4.4,
  2.8, 1.7, 1.1, 5.6, 5.6, 3.9, 5.6, 7.2, 5.6, 1.7, 5, 3.3, 0, -1.6, 5, 1.1,
  1.7, 1.1, 1.7, 0.6, -0.5, -2.1, -1, 3.3, 5, 6.1, 5, 3.9, 3.9, 1.7, 4.4,
  6.7, 8.3, 6.7, 6.1, 7.8, 7.8, 8.3, 7.8, 7.8, 7.8, 6.7, 6.1, 5.6, 5, 4.4,
  4.4, 6.1, 7.2, 5.6, 5, 5, 6.1, 5.6, 5, 7.8, 3.9, 5.6, 7.2, 5.6, 6.1, 6.7,
  4.4, 2.2, 3.9, 7.2, 7.2, 5.6, 6.1, 6.7, 7.8, null, 9.4, 8.3, 6.1, 3.9, 5,
  4.4, 5.6, 7.8, 9.4, 8.3, 7.2, 5.6, 5.6, 7.2, 11.1, 12.8, 10.6, 11.1, 9.4,
  10.6, 9.4, 7.2, 8.3, 6.1, 7.2, 7.8, 7.8, 8.3, 8.9, 8.3, 8.9, 10.6, 9.4,
  8.9, 8.9, 8.3, 12.2, 12.2, 10, 9.4, 8.9, 10, 11.7, 12.2, 11.7, 10, 11.1,
  10.6, 9.4, 8.9, 8.9, 8.3, 10, 9.4, 9.4, 13.3, 14.4, 13.3, 12.2, 11.1,
  12.2, 12.8, 12.8, 12.2, 12.8, 15, 15, 12.2, 11.7, 13.3, 13.9, 16.1, 16.7,
  19.4, 17.8, 16.1, 13.9, 13.3, 15.6, 14.4, 13.3, 14.4, 16.1, 13.9, 13.9,
  16.7, 15, 13.9, 14.4, 12.2, 13.9, 11.1, 13.9, 13.3, 14.4, 16.1, 15, 16.7,
  17.2, 13.9, 13.9, 13.3, 13.3, 12.2, 13.9, 16.1, 14.4, 15, 13.9, 15, 15.6,
  14.4, 15, 13.3, 15.6, 13.3, 14.4, 14.4, 15, 12.8, 12.8, 13.3, 12.8, 12.2,
  10, 11.7, 14.4, 15.6, 16.1, 15, 15, 13.3, 15, 16.1, 17.2, 14.4, 14.4,
  12.2, 11.7, 12.8, 11.1, 13.3, 11.7, 10, 11.7, 12.8, 11.1, 11.7, 8.3, 10.6,
  15.6, 14.4, 12.8, 10.6, 11.1, 9.4, 9.4, 8.9, 7.8, 10, 6.7, 8.9, 9.4, 7.8,
  9.4, 12.2, 11.7, 8.3, 8.3, 7.2, 10, 12.8, 10.6, 8.3, 7.2, 6.7, 11.1, 10,
  8.9, 6.7, 6.1, 7.2, 6.1, 11.7, 8.3, 8.3, 6.7, 5.6, 5, 7.2, 7.2, 7.2, 6.7,
  5.6, 5, 3.3, 7.2, 8.3, 8.9, 8.3, 8.3, 8.9, 6.1, 2.8, 2.2, 4.4, 3.9, 2.2,
  5.6, 5, 6.1, 5, 5.6, 6.1, 5, 2.8, 0, 1.1, 1.1, 0.6, -1, -2.1, -1.6, -1,
  2.8, 6.7, 5.6, 2.2, 0, 2.2, 2.2, 5, 3.9, 3.9, 3.9, 5.6, 7.8, 6.7, 7.2,
  6.7, 6.1, 7.2, 4.4, 3.3, 6.1, 6.1, 7.2, 3.9, 3.9, 1.7,
];

/** Daily precipitation, mm — 818.0 mm over the year. */
// prettier-ignore
export const SEA_PRCP_MM: ReadonlyArray<number | null> = [
  0, 6.1, 2.5, 3.6, 5.8, 10.7, 2.8, 18.8, 6.9, 0.8, 0, 0, 0, 0, 0, 1.8, 7.1,
  9.7, 0.5, 6.6, 11.7, 10.9, 0.3, 10.2, 4.3, 9.7, 18.3, 13.2, 0, 0.5, 3,
  2.3, 0, 0, 0, 3.6, 5.1, 0, 3.3, 0.3, 0, 7.4, 7.9, 0, 1.3, 5.8, 0, 0, 0, 1,
  4.1, 9.7, 0, 0, 0, 4.3, 1.3, 1.3, 24.1, 15, 3.6, 2.3, 2.5, 5.6, 0, 0, 0,
  0, 0.8, 5.3, 5.1, 3.8, 0, 0, 0, 0, 0, 0, 0, 0.8, 2.8, 5.6, 1.8, 0, 0.5, 0,
  13.7, 5.1, 0.8, 0, 0, 0, 0.5, 0, 2.3, 0, 0.8, 0.5, 5.1, 1, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0.8, 0, 0, null, null, 2, 2.3, 1, 5.8, 0.5, 0, 0, 0, 3,
  3.6, 0.3, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 6.1, 0, 0, 16.8, 0, 0, 1.8,
  0.8, 2.5, 0, 0.8, 2.8, 0, 0, 0, 16.5, 8.6, 2.8, 0, 0, 0, 0, 0, 0.3, 0, 0,
  0, 0.3, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.5, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3.3,
  0.8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11.9, 0, 0, 4.3,
  0, 2.5, 11.2, 8.6, 0, 1.5, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  6.1, 0, 1, 2.3, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 2.5, 2, 0.8, 0, 0, 0, 0,
  0, 0, 10.7, 0, 0, 0, 9.1, 0, 0, 0, 0, 0, 0.5, 0.8, 1, 1.3, 1.8, 3.3, 0.8,
  5.1, 0, 0, 0, 0.5, 9.7, 17.3, 0.3, 0, 5.8, 9.4, 15, 3.6, 0.3, 7.6, 0, 0,
  0, 0, 1.5, 8.4, 18.5, 3, 11.9, 5.8, 1.5, 5.6, 0.8, 1.8, 6.9, 2.5, 0.3,
  8.1, 0, 6.6, 12.4, 0, 1.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 14, 1, 0, 0, 0, 0.8,
  13.2, 3, 0, 5.8, 22.4, 8.4, 5.3, 0, 7.9, 7.6, 2, 0.8, 21.8, 4.1, 14, 4.6,
  2.8, 0, 0,
];

/** The 16 compass sectors, clockwise from north — `SEA_WIND_HOURS`' inner axis. */
export const WIND_SECTORS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
] as const;

/**
 * Hourly observations per **[month][sector]** — 12 rows (January first), each
 * 16 counts clockwise from north. Sums to
 * 7,799 directed
 * hours; the calm and variable hours below are the rest of the
 * 8,735 observations, so
 * `sector + calm + variable` is the month's denominator.
 */
// prettier-ignore
export const SEA_WIND_HOURS: ReadonlyArray<ReadonlyArray<number>> = [
  [38, 15, 25, 25, 110, 86, 70, 65, 106, 45, 33, 15, 9, 5, 5, 3],
  [65, 57, 19, 21, 44, 60, 51, 50, 92, 61, 36, 15, 13, 11, 10, 16],
  [107, 52, 31, 11, 13, 21, 40, 36, 126, 105, 50, 13, 20, 13, 14, 15],
  [93, 48, 29, 7, 12, 15, 21, 29, 104, 141, 60, 34, 13, 13, 11, 32],
  [74, 70, 34, 12, 7, 1, 16, 19, 100, 114, 97, 34, 46, 22, 15, 26],
  [86, 47, 37, 8, 1, 1, 4, 10, 60, 151, 104, 26, 37, 43, 21, 27],
  [127, 65, 16, 11, 0, 1, 0, 2, 44, 76, 75, 48, 55, 65, 33, 38],
  [107, 38, 12, 5, 4, 6, 15, 23, 67, 125, 77, 57, 51, 26, 10, 16],
  [106, 48, 25, 15, 5, 3, 10, 27, 85, 87, 62, 31, 39, 33, 17, 21],
  [61, 36, 21, 10, 10, 23, 51, 73, 154, 109, 34, 18, 13, 15, 12, 15],
  [37, 22, 12, 15, 27, 71, 71, 80, 150, 75, 28, 8, 13, 9, 6, 7],
  [31, 30, 25, 15, 49, 92, 72, 57, 118, 111, 25, 7, 4, 8, 2, 3],
];

/** Hours reported **calm** (direction 000, speed 0), per month. */
// prettier-ignore
export const SEA_WIND_CALM_HOURS: ReadonlyArray<number> = [77, 60, 53, 15, 29, 28, 49, 56, 68, 53, 72, 61];

/** Hours reported **variable** (`VRB`) — a direction too unsteady to fix. */
// prettier-ignore
export const SEA_WIND_VARIABLE_HOURS: ReadonlyArray<number> = [12, 15, 20, 25, 27, 29, 35, 48, 37, 35, 16, 16];

/** The first year of {@link GISTEMP_ANOMALY_C}. */
export const GISTEMP_YEAR0 = 1880;

/**
 * Global mean surface temperature anomaly, °C vs the 1951–1980 base period —
 * one value per year, 1880 → 2025.
 */
// prettier-ignore
export const GISTEMP_ANOMALY_C: ReadonlyArray<number> = [
  -0.18, -0.09, -0.11, -0.18, -0.28, -0.34, -0.32, -0.36, -0.18, -0.11,
  -0.36, -0.23, -0.27, -0.31, -0.3, -0.23, -0.12, -0.11, -0.28, -0.18,
  -0.09, -0.15, -0.28, -0.37, -0.48, -0.27, -0.23, -0.39, -0.43, -0.49,
  -0.44, -0.45, -0.37, -0.35, -0.16, -0.15, -0.36, -0.46, -0.3, -0.28,
  -0.28, -0.19, -0.29, -0.27, -0.27, -0.22, -0.11, -0.22, -0.2, -0.36,
  -0.16, -0.1, -0.16, -0.29, -0.13, -0.2, -0.15, -0.03, 0, -0.02, 0.12,
  0.18, 0.06, 0.09, 0.2, 0.09, -0.07, -0.03, -0.11, -0.11, -0.17, -0.07,
  0.01, 0.08, -0.13, -0.14, -0.19, 0.05, 0.06, 0.03, -0.02, 0.06, 0.03,
  0.05, -0.2, -0.11, -0.06, -0.02, -0.08, 0.05, 0.03, -0.08, 0.01, 0.16,
  -0.07, -0.01, -0.1, 0.18, 0.07, 0.16, 0.25, 0.32, 0.14, 0.31, 0.15, 0.12,
  0.18, 0.32, 0.39, 0.27, 0.45, 0.41, 0.22, 0.23, 0.31, 0.44, 0.33, 0.46,
  0.61, 0.38, 0.39, 0.53, 0.63, 0.61, 0.53, 0.68, 0.64, 0.66, 0.54, 0.66,
  0.72, 0.61, 0.65, 0.68, 0.75, 0.9, 1.01, 0.91, 0.85, 0.98, 1.01, 0.85,
  0.89, 1.17, 1.28, 1.19,
];
