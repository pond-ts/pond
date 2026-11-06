/**
 * Three **modelled** activities for the @pond-ts/fit guides: a ride with
 * power, a run of intervals and a pool swim. Made up from scratch, not
 * anyone's recording, so they can be published and changed freely.
 *
 * - **Where it came from.** Generated here, by the seeded model below
 *   (`mulberry32`, the house PRNG), so the server render and the browser
 *   build byte-identical activities. No licence question: nothing is copied.
 * - **What it models.** The ride holds its power to a plan (steady on the
 *   flat, tempo on the first climb, hard on the second, coasting on the
 *   descents) and its speed comes from that power and the road's slope. Heart
 *   rate follows the effort a little late and drifts up over the ride. The
 *   run is a warm-up, six 800 m repeats with a standing-then-jogging recovery,
 *   and a cool-down, with a button lap for each part. The swim is a set of
 *   lengths in a 25 m pool with rests at the wall.
 * - **The quirks kept on purpose.** The ride stops at a traffic light for
 *   45 s with the recording running, pauses the timer for six minutes at a
 *   café, and loses its power meter twice (8 s and 15 s with no power). GPS
 *   wanders a metre or two and its error drifts slowly, as real fixes do.
 * - **How it is published.** `website/scripts/fit-fixtures/write.mts` writes
 *   the same activities as `.fit` files (with the Garmin FIT SDK) and as CSV,
 *   to `website/static/data/fit/`, for the TypeScript and Python examples.
 *   Every value here is rounded to what a FIT file can hold, so reading the
 *   `.fit` file gives the same activity as {@link hillRide} and the others
 *   (`website/scripts/check-fit-guides.mts` checks it).
 */
import type { ImportedActivity, Lap, SwimLength } from '@pond-ts/fit';

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

/** Roughly normal noise, mean 0, spread about 1. */
function gauss(rand: () => number): number {
  return (rand() + rand() + rand() + rand() - 2) * 1.73;
}

/** One sample, as a FIT `record` message holds it. */
export interface FixtureRecord {
  /** Whole seconds from the start. */
  t: number;
  lat?: number;
  lng?: number;
  altitude?: number;
  heartRate?: number;
  power?: number;
  cadence?: number;
  /** The watch's own distance, metres (only the swim keeps it). */
  distance?: number;
}

export interface FixtureLap {
  from: number;
  to: number;
  /** Metres the watch measured for the lap. */
  distance: number;
  /** Time the timer ran in the lap (less than `to - from` across a pause). */
  timer: number;
}

export interface FixtureLength {
  from: number;
  seconds: number;
  active: boolean;
  strokes?: number;
  stroke?: string;
}

/** One activity as the FIT writer and the record builder both read it. */
export interface FixtureRecording {
  /** File name, without the extension. */
  slug: string;
  name: string;
  sport: 'cycling' | 'running' | 'swimming';
  subSport: 'road' | 'street' | 'lapSwimming';
  /** Strava-style label, as the FIT reader gives it. */
  sportType: 'Ride' | 'Run' | 'Swim';
  startMs: number;
  records: FixtureRecord[];
  /** Timer pauses: [stopped at, started again at], seconds from the start. */
  pauses: Array<[number, number]>;
  laps: FixtureLap[];
  /** Seconds the timer ran, as the session states it. */
  timer: number;
  /** Seconds from the start to the end of the session. */
  elapsed: number;
  /** Metres for the whole session, as the watch measured them. */
  distance: number;
  lengths?: FixtureLength[];
  poolMeters?: number;
}

// ---------------------------------------------------------------------------
// FIT precision, so the published files read back to these exact values
// ---------------------------------------------------------------------------

/** Degrees through FIT's semicircles and back. */
const semicircle = (deg: number) =>
  (Math.round((deg * 2 ** 31) / 180) * 180) / 2 ** 31;
/** FIT altitude: scale 5, offset 500. */
const fitAltitude = (m: number) => Math.round((m + 500) * 5) / 5 - 500;

// ---------------------------------------------------------------------------
// The course: a closed loop, placed somewhere quiet. Positions are the loop's
// shape; the slope comes from the course profile, by distance.
// ---------------------------------------------------------------------------

const ORIGIN = { lat: 44.12, lng: 6.98 };
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

/**
 * A path you can walk by distance: `shape(u)` traces it for `u` in [0, 1],
 * and `at(d)` gives the point `d` metres along it, the path scaled so it is
 * exactly `length` metres long. So the GPS line measures what the model rode.
 */
function walker(
  shape: (u: number) => { x: number; y: number },
  length: number,
) {
  const n = 20_000;
  const xs = new Float64Array(n + 1);
  const ys = new Float64Array(n + 1);
  const cum = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const p = shape(i / n);
    xs[i] = p.x;
    ys[i] = p.y;
    if (i > 0)
      cum[i] = cum[i - 1]! + Math.hypot(p.x - xs[i - 1]!, p.y - ys[i - 1]!);
  }
  const scale = length / cum[n]!;
  let k = 0;
  return (d: number) => {
    const target = Math.min(Math.max(d / scale, 0), cum[n]!);
    while (k > 0 && cum[k]! > target) k--;
    while (k < n - 1 && cum[k + 1]! < target) k++;
    const f = (target - cum[k]!) / (cum[k + 1]! - cum[k]! || 1);
    return {
      x: (xs[k]! + f * (xs[k + 1]! - xs[k]!)) * scale,
      y: (ys[k]! + f * (ys[k + 1]! - ys[k]!)) * scale,
    };
  };
}

/** A wobbly loop, centred on the origin. */
const loop = (u: number) => {
  const theta = 2 * Math.PI * u;
  const r = 1 + 0.06 * Math.sin(5 * theta);
  return { x: r * Math.cos(theta), y: r * Math.sin(theta) };
};

/** Correlated GPS error: drifts slowly, a metre or two at most. */
function gpsError(rand: () => number) {
  let ex = 0;
  let ey = 0;
  return () => {
    ex = ex * 0.97 + gauss(rand) * 0.12;
    ey = ey * 0.97 + gauss(rand) * 0.12;
    return { ex, ey };
  };
}

function toLatLng(x: number, y: number) {
  return {
    lat: semicircle(ORIGIN.lat + y / M_PER_DEG_LAT),
    lng: semicircle(ORIGIN.lng + x / M_PER_DEG_LNG),
  };
}

// ---------------------------------------------------------------------------
// The ride: "Two climbs loop", about 45 km
// ---------------------------------------------------------------------------

const RIDE_LENGTH_M = 45_000;

/** Height (m) at `d` metres along the ride: flat, a 6 km climb at about 5 %,
 *  its descent, flat, a 4 km climb at about 7 %, its descent, flat home. */
function rideHeight(d: number): number {
  const km = d / 1000;
  const base = 420;
  const ramp = (a: number, b: number, rise: number) =>
    km <= a
      ? 0
      : km >= b
        ? rise
        : rise * (0.5 - 0.5 * Math.cos((Math.PI * (km - a)) / (b - a)));
  return (
    base +
    3 * Math.sin(km * 1.3) +
    ramp(8, 14, 300) -
    ramp(14, 20, 300) +
    ramp(28, 32, 280) -
    ramp(32, 38, 280)
  );
}

/** The rider's plan: target watts at elapsed `t` and slope `grade`. */
function ridePlan(t: number, km: number, grade: number): number {
  if (grade < -0.025) return 0; // coast the descents
  if (t < 600) return 150; // warm up
  if (km >= 8 && km < 14) return 255; // first climb, tempo
  if (km >= 28 && km < 32) return 305; // second climb, hard
  if (km > 42) return 140; // spin home
  return 190;
}

/** Steady speed (m/s) for `watts` on `grade`, from rolling, air and climbing
 *  resistance (80 kg with the bike, CdA 0.32, Crr 0.004, 97 % drivetrain). */
function speedFor(watts: number, grade: number): number {
  const m = 80;
  const g = 9.81;
  const f = (v: number) =>
    (m * g * (0.004 + grade) + 0.5 * 1.2 * 0.32 * v * v) * v - watts * 0.97;
  let lo = 0;
  let hi = 25;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  // brakes on a fast descent
  return Math.min((lo + hi) / 2, 15);
}

/** Two climbs loop: a 45 km ride with a power meter. */
export function hillRideRecording(): FixtureRecording {
  const rand = mulberry32(2026);
  const err = gpsError(rand);
  const records: FixtureRecord[] = [];
  const pauses: Array<[number, number]> = [];
  const laps: FixtureLap[] = [];

  let d = 0;
  let v = 0;
  let wattsDrift = 0;
  let hr = 92;
  let effort = 120; // a minute-scale average of power, what HR answers to
  let lapFrom = 0;
  let lapStartD = 0;
  let nextLapAt = 10_000;
  let lightUntil = -1;
  let lightDone = false;
  let cafeDone = false;
  let t = 0;
  let paused = 0;

  const course = walker(loop, RIDE_LENGTH_M);
  while (d < RIDE_LENGTH_M) {
    // the café: the timer stops for six minutes, no samples are written
    if (!cafeDone && d >= 22_000) {
      cafeDone = true;
      pauses.push([t, t + 360]);
      t += 360;
      paused += 360;
      v = 0;
      hr = 96;
      effort = 110;
    }
    // the traffic light: 45 s stood still, the recording running
    if (!lightDone && d >= 5_200) {
      lightDone = true;
      lightUntil = t + 45;
    }
    const stopped = t < lightUntil;

    const km = d / 1000;
    const grade = (rideHeight(d + 5) - rideHeight(d - 5)) / 10;
    let watts = 0;
    if (!stopped) {
      const target = ridePlan(t, km, grade);
      if (target > 0) {
        wattsDrift = wattsDrift * 0.9 + gauss(rand) * 6;
        watts = Math.max(0, target + wattsDrift + gauss(rand) * 22);
      } else if (rand() < 0.04) {
        watts = 60 + rand() * 80; // a few pedal strokes on the descent
      }
    }
    const vTarget = stopped ? 0 : speedFor(watts, grade);
    v += (vTarget - v) / (stopped ? 2 : 6);
    if (stopped && v < 0.3) v = 0;
    d += v;

    effort += (watts - effort) / 60;
    const hrTarget = 62 + 0.36 * effort + 0.0011 * t;
    hr += (hrTarget - hr) / 25;

    const p = course(d);
    const e = err();
    const pos = toLatLng(p.x + e.ex, p.y + e.ey);
    const dropout = (t >= 2_400 && t < 2_408) || (t >= 4_100 && t < 4_115);
    const pedalling = watts > 0;
    const rec: FixtureRecord = {
      t,
      lat: pos.lat,
      lng: pos.lng,
      altitude: fitAltitude(rideHeight(d) + gauss(rand) * 0.25),
      heartRate: Math.round(hr + gauss(rand) * 0.8),
      cadence: pedalling
        ? Math.round((grade > 0.03 ? 78 : 88) + gauss(rand) * 3)
        : 0,
    };
    if (!dropout) rec.power = Math.round(watts);
    records.push(rec);

    // auto-lap every 10 km of the watch's distance
    if (d >= nextLapAt || d >= RIDE_LENGTH_M) {
      laps.push({
        from: lapFrom,
        to: t,
        distance: Math.round((d - lapStartD) * 100) / 100,
        timer: t - lapFrom,
      });
      lapFrom = t;
      lapStartD = d;
      nextLapAt += 10_000;
    }
    t += 1;
  }
  // the café pause sits inside lap 3 (20 km to 30 km)
  for (const lap of laps)
    for (const [a, b] of pauses)
      if (a >= lap.from && b <= lap.to) lap.timer = lap.to - lap.from - (b - a);

  const last = records[records.length - 1]!.t;
  return {
    slug: 'hill-ride',
    name: 'Two climbs loop',
    sport: 'cycling',
    subSport: 'road',
    sportType: 'Ride',
    startMs: Date.UTC(2026, 5, 14, 7, 30, 0),
    records,
    pauses,
    laps,
    timer: last - paused,
    elapsed: last,
    distance: Math.round(d * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// The run: "Six by 800 m", about 10 km
// ---------------------------------------------------------------------------

interface RunPart {
  label: string;
  /** Metres to cover, or 0 for a part measured by time. */
  meters: number;
  /** Seconds, for a part measured by time. */
  seconds: number;
  /** Speed held, m/s (time parts: standing for `stand` s, then jogging). */
  speed: number;
  stand?: number;
}

const RUN_PARTS: RunPart[] = [
  { label: 'Warm-up', meters: 2_400, seconds: 0, speed: 3.0 },
  ...Array.from({ length: 6 }, (_, i): RunPart[] => [
    { label: 'Repeat', meters: 800, seconds: 0, speed: 4.4 - i * 0.03 },
    ...(i < 5
      ? [{ label: 'Recovery', meters: 0, seconds: 90, speed: 1.6, stand: 30 }]
      : []),
  ]).flat(),
  { label: 'Cool-down', meters: 2_000, seconds: 0, speed: 2.8 },
];

/** Six by 800 m: a run of repeats with a lap button press for each part. */
export function intervalRunRecording(): FixtureRecording {
  const rand = mulberry32(800);
  const err = gpsError(rand);
  const records: FixtureRecord[] = [];
  const laps: FixtureLap[] = [];
  const routeLength = 10_400;

  // out along a riverside path and back the same way
  const path = walker(
    (u) => ({ x: u, y: 0.03 * Math.sin(u * 9) }),
    routeLength / 2,
  );
  let d = 0;
  let v = 0;
  let hr = 88;
  let t = 0;
  // each lap starts where the one before ended, on the same sample
  let lapFrom = 0;
  for (const part of RUN_PARTS) {
    const fromD = d;
    const done = () =>
      part.meters > 0 ? d - fromD >= part.meters : t - lapFrom >= part.seconds;
    while (!done()) {
      const standing = part.stand !== undefined && t - lapFrom < part.stand;
      const target = standing ? 0 : part.speed + gauss(rand) * 0.08;
      v += (target - v) / (standing ? 2 : 4);
      if (standing && v < 0.25) v = 0;
      d += v;
      const hrTarget = 70 + 21.5 * Math.max(v, 0.6) + 0.0015 * t;
      hr += (hrTarget - hr) / (hrTarget > hr ? 22 : 35);
      const p = path(d <= routeLength / 2 ? d : routeLength - d);
      const e = err();
      const pos = toLatLng(p.x + e.ex, p.y + e.ey);
      records.push({
        t,
        lat: pos.lat,
        lng: pos.lng,
        altitude: fitAltitude(35 + 6 * Math.sin(d / 900) + gauss(rand) * 0.2),
        heartRate: Math.round(hr + gauss(rand) * 0.8),
      });
      t += 1;
    }
    const to = t - 1;
    laps.push({
      from: lapFrom,
      to,
      distance: Math.round((d - fromD) * 100) / 100,
      timer: to - lapFrom,
    });
    lapFrom = to;
  }
  const last = records[records.length - 1]!.t;
  return {
    slug: 'interval-run',
    name: 'Six by 800 m',
    sport: 'running',
    subSport: 'street',
    sportType: 'Run',
    startMs: Date.UTC(2026, 5, 16, 18, 0, 0),
    records,
    pauses: [],
    laps,
    timer: last,
    elapsed: last,
    distance: Math.round(d * 100) / 100,
  };
}

/** The labels of the run's laps, in order (FIT laps carry no names). */
export const RUN_LAP_LABELS: readonly string[] = RUN_PARTS.map((p) => p.label);

// ---------------------------------------------------------------------------
// The swim: "Pool, 6 × 100", 1,300 m in a 25 m pool
// ---------------------------------------------------------------------------

interface SwimBlock {
  lengths: number;
  /** Seconds per length at the start of the block. */
  pace: number;
  stroke: string;
  /** Strokes per length, or 0 for none counted (kick). */
  strokes: number;
  /** Rest at the wall after it, seconds. */
  rest: number;
}

const SWIM_BLOCKS: SwimBlock[] = [
  { lengths: 12, pace: 25, stroke: 'freestyle', strokes: 17, rest: 40 },
  ...Array.from(
    { length: 6 },
    (): SwimBlock => ({
      lengths: 4,
      pace: 22.5,
      stroke: 'freestyle',
      strokes: 16,
      rest: 20,
    }),
  ),
  ...Array.from(
    { length: 4 },
    (): SwimBlock => ({
      lengths: 2,
      pace: 34,
      stroke: 'drill',
      strokes: 0,
      rest: 15,
    }),
  ),
  { lengths: 8, pace: 27, stroke: 'freestyle', strokes: 18, rest: 0 },
];

/** Pool, 6 × 100: a pool swim with lengths, rests and repeats. */
export function poolSwimRecording(): FixtureRecording {
  const rand = mulberry32(25);
  const records: FixtureRecord[] = [{ t: 0, distance: 0 }];
  const lengths: FixtureLength[] = [];
  const laps: FixtureLap[] = [];
  let t = 0;
  let dist = 0;
  let fatigue = 0;
  SWIM_BLOCKS.forEach((block, b) => {
    const from = t;
    const fromD = dist;
    for (let i = 0; i < block.lengths; i++) {
      fatigue += 0.04;
      const secs = Math.round(
        block.pace + fatigue * 0.3 + i * 0.4 + gauss(rand) * 0.6,
      );
      const len: FixtureLength = {
        from: t,
        seconds: secs,
        active: true,
        stroke: block.stroke,
      };
      if (block.strokes > 0)
        len.strokes = Math.round(block.strokes + i * 0.5 + gauss(rand) * 0.7);
      lengths.push(len);
      t += secs;
      dist += 25;
      records.push({ t, distance: dist });
    }
    laps.push({ from, to: t, distance: dist - fromD, timer: t - from });
    if (block.rest > 0 && b < SWIM_BLOCKS.length - 1) {
      lengths.push({ from: t, seconds: block.rest, active: false });
      laps.push({
        from: t,
        to: t + block.rest,
        distance: 0,
        timer: block.rest,
      });
      t += block.rest;
      records.push({ t, distance: dist });
    }
  });
  return {
    slug: 'pool-swim',
    name: 'Pool, 6 × 100',
    sport: 'swimming',
    subSport: 'lapSwimming',
    sportType: 'Swim',
    startMs: Date.UTC(2026, 5, 18, 6, 45, 0),
    records,
    pauses: [],
    laps,
    timer: t,
    elapsed: t,
    distance: dist,
    lengths,
    poolMeters: 25,
  };
}

// ---------------------------------------------------------------------------
// As records, the shape `Activity.from` takes (what the FIT reader produces)
// ---------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();

/** The plain record the FIT reader makes from `rec`'s `.fit` file. */
export function toImported(rec: FixtureRecording): ImportedActivity {
  const { records, startMs } = rec;
  const gps = records.some((r) => r.lat !== undefined);
  const col = (k: keyof FixtureRecord) =>
    records.some((r) => r[k] !== undefined)
      ? records.map((r) => (r[k] as number | undefined) ?? NaN)
      : undefined;
  const streams: ImportedActivity['streams'] = {
    latlng: gps ? records.map((r) => [r.lat!, r.lng!] as [number, number]) : [],
    timeSeconds: records.map((r) => r.t),
  };
  const alt = col('altitude');
  const hr = col('heartRate');
  const watts = col('power');
  const cad = col('cadence');
  const dist = col('distance');
  if (alt) streams.altitudeMeters = alt;
  if (hr) streams.heartrate = hr;
  if (watts) streams.watts = watts;
  if (cad) streams.cadence = cad;
  if (!gps && dist) streams.distanceMeters = dist;

  let startD = 0;
  const laps: Lap[] = rec.laps.map((l, i) => {
    const lap: Lap = {
      index: i + 1,
      startTimeUtc: iso(startMs + l.from * 1000),
      startDistanceMeters: startD,
      distanceMeters: l.distance,
      elapsedSeconds: l.to - l.from,
      movingSeconds: l.timer,
      timerSeconds: l.timer,
    };
    startD += l.distance;
    return lap;
  });
  const id = `fit:${iso(startMs + records[0]!.t * 1000)}`;
  const out: ImportedActivity = {
    activity: {
      id,
      source: 'file',
      externalId: id,
      name: rec.name,
      startTimeUtc: iso(startMs),
      distanceMeters: 0,
      movingTimeSeconds: 0,
      elapsedTimeSeconds: 0,
      elevationGainMeters: 0,
      sportType: rec.sportType,
    },
    streams,
    laps,
    timerSeconds: rec.timer,
    creator: { manufacturer: 'development', product: 0, name: 'pond fixture' },
  };
  if (rec.lengths) {
    const swum = rec.laps.filter((l) => l.distance > 0);
    out.swim = {
      movingSeconds: swum.reduce((a, l) => a + l.timer, 0),
      pool: { lengthMeters: rec.poolMeters!, unit: 'm' },
      lengths: rec.lengths.map((l): SwimLength => {
        const len: SwimLength = {
          startTimeUtc: iso(startMs + l.from * 1000),
          seconds: l.seconds,
          active: l.active,
        };
        if (l.active && l.strokes !== undefined) len.strokes = l.strokes;
        if (l.active && l.stroke) len.stroke = l.stroke;
        return len;
      }),
    };
  }
  return out;
}

/** The ride, ready for `Activity.from`. */
export const hillRide = (): ImportedActivity => toImported(hillRideRecording());
/** The run, ready for `Activity.from`. */
export const intervalRun = (): ImportedActivity =>
  toImported(intervalRunRecording());
/** The swim, ready for `Activity.from`. */
export const poolSwim = (): ImportedActivity => toImported(poolSwimRecording());
