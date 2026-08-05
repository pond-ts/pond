import { TimeSeries } from 'pond-ts';

/**
 * Household electricity demand — whole-house active power, in kilowatts,
 * sampled once a minute. The dataset behind the `@pond-ts/charts` landing
 * chart.
 *
 * Shaped after the UCI *Individual household electric power consumption* set
 * (Hebrail & Berard, CC BY 4.0) — one house near Paris, one-minute
 * `Global_active_power` in kW, 2,075,259 rows over Dec 2006 – Nov 2010, about
 * 1.25% of them missing. That's the reference for the *structure* here: the
 * columns, the cadence, the units, the value range, and the dropouts.
 *
 * **Modelled, not measured.** No rows of the original are redistributed. The
 * numbers are generated from the way domestic load actually forms, which is
 * the reason this reads as noisy where a river gauge or a temperature record
 * doesn't:
 *
 * - **Standby** — a flat ~0.22 kW floor of things never switched off.
 * - **The fridge** — a compressor duty-cycling ~0.13 kW on a ~47-minute
 *   period, all day and all night. It's the reason the overnight floor is a
 *   square wave rather than a line.
 * - **Appliance events** — discrete, brief and large relative to the floor: a
 *   kettle is 2.6 kW for three minutes. Demand at one-minute resolution is
 *   not a smooth signal plus noise; it's a *sum of rectangles*, and that's
 *   what makes a scatter of the raw minutes the honest way to draw it.
 * - **Multi-stage cycles** — the washing machine and dishwasher draw a hot
 *   fill, then a long low tumble, then a spin. One appliance, three levels.
 * - **A daily rhythm** that emerges from when those events are scheduled
 *   rather than being imposed as a sine: quiet overnight, a sharp morning
 *   peak, a broad cooking-hours evening peak.
 * - **Measurement noise** — ±1.5%. The smallest term by far. Almost all the
 *   visible scatter is load, not instrument error.
 * - **A recorder outage** — one ninety-minute gap, carried as `null` on the
 *   way in and read back as `undefined`, because the source set has them and
 *   zero is a lie the chart would happily draw.
 *
 * Deterministic — a seeded PRNG, never `Math.random()` or `Date.now()` — so a
 * live-embedded chart renders identically on the server and the client (no
 * hydration mismatch) and looks the same on every visit.
 */

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

/** Two days — 2,880 minutes. Enough for the rhythm to repeat and differ. */
const DAYS = 2;
const SAMPLES = DAYS * DAY_MINUTES;

/** A Monday inside the source record's span. */
const BASE = Date.UTC(2010, 10, 8, 0, 0, 0);

const STANDBY_KW = 0.22;
const FRIDGE_KW = 0.13;
const FRIDGE_PERIOD = 47;
const FRIDGE_ON = 18;

/** A tiny deterministic PRNG (mulberry32) — no external dependency. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One appliance run: a rectangle of `kw` starting at `at`, `mins` long. */
interface Run {
  readonly at: number;
  readonly mins: number;
  readonly kw: number;
}

/**
 * A day's appliance schedule, in minutes past midnight. Multi-stage cycles are
 * written as consecutive runs of the same appliance at different levels —
 * a washing machine is a hot fill, a long tumble, then a spin.
 */
function daySchedule(startMin: number, jitter: () => number): Run[] {
  const j = (spread: number) => Math.round((jitter() - 0.5) * spread);
  const at = (h: number, m: number, spread = 20) =>
    startMin + h * 60 + m + j(spread);

  return [
    { at: at(6, 40), mins: 3, kw: 2.6 }, // kettle
    { at: at(6, 46), mins: 4, kw: 1.3 }, // toaster
    { at: at(7, 8), mins: 22, kw: 2.0 }, // water heater — shower
    { at: at(7, 52), mins: 3, kw: 2.6 }, // kettle
    { at: at(8, 5), mins: 14, kw: 2.1 }, // washer — hot fill
    { at: at(8, 19, 0), mins: 38, kw: 0.35 }, // washer — tumble
    { at: at(8, 57, 0), mins: 7, kw: 0.62 }, // washer — spin
    { at: at(12, 30), mins: 6, kw: 1.4 }, // microwave
    { at: at(13, 2), mins: 3, kw: 2.6 }, // kettle
    { at: at(17, 45, 30), mins: 45, kw: 2.3 }, // oven
    { at: at(18, 12, 25), mins: 20, kw: 1.6 }, // hob
    { at: at(19, 34), mins: 17, kw: 2.0 }, // dishwasher — wash
    { at: at(19, 51, 0), mins: 28, kw: 0.3 }, // dishwasher — dry
    { at: at(20, 18), mins: 3, kw: 2.6 }, // kettle
    { at: at(22, 4), mins: 25, kw: 1.9 }, // water heater
  ];
}

/** Evening and early-morning lighting — a soft shoulder, not an event. */
function lighting(minuteOfDay: number): number {
  if (minuteOfDay >= 6 * 60 && minuteOfDay < 8 * 60) return 0.1;
  if (minuteOfDay >= 17 * 60 && minuteOfDay < 23 * 60) return 0.16;
  return 0;
}

/** A ninety-minute recorder outage on the first afternoon. The source set's
 *  missing 1.25% arrives in contiguous blocks like this, not as lone minutes. */
const DROPOUT_FROM = 14 * 60 + 22;
const DROPOUT_TO = DROPOUT_FROM + 90;

export const POWER_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'kw', kind: 'number', required: false },
] as const;

/**
 * The demand record — 2,880 samples on a one-minute grid, in kW. Dense and
 * genuinely spiky: a scatter of the raw minutes is a cloud, and the shape only
 * appears once something is rolled through it.
 */
export function householdPower(): TimeSeries<typeof POWER_SCHEMA> {
  const rand = mulberry32(0x5eed1234);

  const runs: Run[] = [];
  for (let day = 0; day < DAYS; day++) {
    for (const run of daySchedule(day * DAY_MINUTES, rand)) {
      // Skip an event now and then so the days aren't carbon copies.
      if (rand() < 0.12) continue;
      runs.push(run);
    }
  }

  const rows: { time: number; kw: number | null }[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const time = BASE + i * MINUTE;

    if (i >= DROPOUT_FROM && i < DROPOUT_TO) {
      rows.push({ time, kw: null });
      continue;
    }

    let kw = STANDBY_KW + lighting(i % DAY_MINUTES);
    if (i % FRIDGE_PERIOD < FRIDGE_ON) kw += FRIDGE_KW;
    for (const run of runs) {
      if (i >= run.at && i < run.at + run.mins) kw += run.kw;
    }

    kw *= 1 + (rand() - 0.5) * 0.03;
    rows.push({ time, kw: Math.round(kw * 1000) / 1000 });
  }

  return TimeSeries.fromJSON({ name: 'demand', schema: POWER_SCHEMA, rows });
}
