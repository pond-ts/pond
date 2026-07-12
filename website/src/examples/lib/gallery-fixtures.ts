import { TimeSeries } from 'pond-ts';

/**
 * Deterministic seed data for the Gallery's 8 cards (docs plan §5a — the
 * "shop window"). Same discipline as `server-metrics.ts`: a seeded PRNG,
 * never `Math.random()`/`Date.now()`, so every card renders identically on
 * the server and the client and looks the same on every visit.
 */

const BASE = Date.UTC(2026, 0, 12, 9, 0, 0);
const MINUTE = 60_000;
const DAY = 86_400_000;

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

// ---------------------------------------------------------------------------
// Ops dashboard — requests/sec (area) + error rate (line), dual row
// ---------------------------------------------------------------------------

const requestsSchema = [
  { name: 'time', kind: 'time' },
  { name: 'rps', kind: 'number' },
  { name: 'errorRate', kind: 'number' },
] as const;

export function requestMetrics(n = 90) {
  const rand = mulberry32(11);
  const rows: Array<[number, number, number]> = [];
  let rps = 420;
  for (let i = 0; i < n; i += 1) {
    rps += (500 - rps) * 0.05 + (rand() - 0.5) * 40;
    rps = Math.max(80, rps);
    const spike = i > 55 && i < 64 ? 0.05 : 0;
    const errorRate = Math.max(0, 0.004 + spike + (rand() - 0.5) * 0.003);
    rows.push([
      BASE + i * MINUTE,
      Math.round(rps),
      Math.round(errorRate * 10000) / 10000,
    ]);
  }
  return new TimeSeries({ name: 'requests', schema: requestsSchema, rows });
}

// ---------------------------------------------------------------------------
// Financial terminal — daily OHLCV candles
// ---------------------------------------------------------------------------

const ohlcSchema = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
] as const;

export function dailyCandles(n = 42) {
  const rand = mulberry32(23);
  const rows: Array<[number, number, number, number, number]> = [];
  let close = 148;
  for (let i = 0; i < n; i += 1) {
    const open = close;
    const drift = 3.4 * Math.sin(i / 7) + 1.6 * (rand() - 0.5);
    close = Math.max(60, open + drift);
    const wick = 0.8 + 1.4 * Math.abs(rand());
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    rows.push([BASE + i * DAY, open, high, low, close]);
  }
  return new TimeSeries({ name: 'daily', schema: ohlcSchema, rows });
}

export function dailyCandlesRange(n = 42): [number, number] {
  return [BASE - DAY / 2, BASE + (n - 1) * DAY + DAY / 2];
}

// ---------------------------------------------------------------------------
// Activity chart — a ride's elevation profile
// ---------------------------------------------------------------------------

const elevationSchema = [
  { name: 'time', kind: 'time' },
  { name: 'elevation', kind: 'number' },
] as const;

export function elevationProfile(n = 80) {
  const rand = mulberry32(37);
  const rows: Array<[number, number]> = [];
  let elevation = 120;
  for (let i = 0; i < n; i += 1) {
    // Two climbs (a col, then a longer ascent) and a fast descent — the
    // shape of a real ride, not a random walk.
    const climb =
      1.1 * Math.max(0, Math.sin((i / n) * Math.PI * 2 - 0.4)) * 3.2;
    const descent = i > n * 0.75 ? -6.5 : 0;
    elevation = Math.max(40, elevation + climb + descent + (rand() - 0.5) * 3);
    rows.push([BASE + i * MINUTE, Math.round(elevation)]);
  }
  return new TimeSeries({ name: 'elevation', schema: elevationSchema, rows });
}

// ---------------------------------------------------------------------------
// Annotated chart — API latency with an incident region, a deploy marker,
// and an SLA baseline (the two-register annotation model: data vs. marks)
// ---------------------------------------------------------------------------

const latencySchema = [
  { name: 'time', kind: 'time' },
  { name: 'latency', kind: 'number' },
] as const;

export function annotatedLatency(n = 90) {
  const rand = mulberry32(53);
  const rows: Array<[number, number]> = [];
  let latency = 88;
  for (let i = 0; i < n; i += 1) {
    const incident = i >= 40 && i < 58 ? 140 : 0;
    latency += (95 - latency) * 0.08 + (rand() - 0.5) * 6;
    rows.push([
      BASE + i * MINUTE,
      Math.round(Math.max(30, latency + incident)),
    ]);
  }
  return new TimeSeries({ name: 'latency', schema: latencySchema, rows });
}

/** The incident window (`Region`), deploy instant (`Marker`), and SLA target
 *  (`Baseline`) that annotate {@link annotatedLatency}'s time range. */
export const annotatedLatencyMarks = {
  incidentStart: BASE + 40 * MINUTE,
  incidentEnd: BASE + 58 * MINUTE,
  deployAt: BASE + 40 * MINUTE,
  slaMs: 120,
};

// ---------------------------------------------------------------------------
// Variance band — a rolling latency percentile fan (p5/p25/p50/p75/p95)
// ---------------------------------------------------------------------------

const bandSchema = [
  { name: 'time', kind: 'time' },
  { name: 'p5', kind: 'number' },
  { name: 'p25', kind: 'number' },
  { name: 'p50', kind: 'number' },
  { name: 'p75', kind: 'number' },
  { name: 'p95', kind: 'number' },
] as const;

export function latencyPercentileBand(n = 70) {
  const rows: Array<[number, number, number, number, number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const mid = 90 + 30 * Math.sin(i / 9);
    const spread = 8 + 34 * Math.sin((i / (n - 1)) * Math.PI);
    rows.push([
      BASE + i * MINUTE,
      mid - spread,
      mid - spread / 2,
      mid,
      mid + spread / 2,
      mid + spread,
    ]);
  }
  return new TimeSeries({ name: 'band', schema: bandSchema, rows });
}

// ---------------------------------------------------------------------------
// Response-time distribution — a value-axis histogram (byColumn)
// ---------------------------------------------------------------------------

const responseSampleSchema = [
  { name: 'time', kind: 'time' },
  { name: 'ms', kind: 'number' },
] as const;

/** ~1200 response-time samples, an Ornstein–Uhlenbeck-ish wander around a
 *  120ms mean, then bucketed into 10ms-wide bins by value (not time) — a
 *  classic time-in-band distribution. */
export function responseTimeDistribution() {
  const rand = mulberry32(71);
  const rows: Array<[number, number]> = [];
  let ms = 120;
  for (let i = 0; i < 1200; i += 1) {
    ms += (rand() - 0.5) * 14 + (120 - ms) * 0.05;
    ms = Math.max(10, Math.min(260, ms));
    rows.push([BASE + i * 1000, ms]);
  }
  const samples = new TimeSeries({
    name: 'responses',
    schema: responseSampleSchema,
    rows,
  });
  const count = new Float64Array(samples.length).fill(1);
  return samples
    .withColumn('count', count)
    .byColumn('ms', { width: 10 }, { count: { from: 'count', using: 'sum' } });
}

// ---------------------------------------------------------------------------
// Trade ticks — price scatter, radius=size, colour=up/down
// ---------------------------------------------------------------------------

const tradeSchema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
  { name: 'change', kind: 'number' },
] as const;

export function tradeTicks(n = 60) {
  const rand = mulberry32(89);
  const rows: Array<[number, number, number, number]> = [];
  let price = 148;
  for (let i = 0; i < n; i += 1) {
    const change = (rand() - 0.5) * 1.6;
    price = Math.max(60, price + change);
    const size = Math.round(20 + rand() * 480);
    rows.push([BASE + i * MINUTE, Math.round(price * 100) / 100, size, change]);
  }
  return new TimeSeries({ name: 'trades', schema: tradeSchema, rows });
}

export function tradeTicksRange(n = 60): [number, number] {
  return [BASE, BASE + (n - 1) * MINUTE];
}

// ---------------------------------------------------------------------------
// Latency percentiles — hourly box-and-whisker buckets
// ---------------------------------------------------------------------------

const boxSchema = [
  { name: 'time', kind: 'time' },
  { name: 'p5', kind: 'number' },
  { name: 'p25', kind: 'number' },
  { name: 'p50', kind: 'number' },
  { name: 'p75', kind: 'number' },
  { name: 'p95', kind: 'number' },
] as const;

export function hourlyLatencyBoxes(n = 14) {
  const rand = mulberry32(103);
  const rows: Array<[number, number, number, number, number, number]> = [];
  const HOUR = 3_600_000;
  for (let i = 0; i < n; i += 1) {
    const load = 0.5 + 0.5 * Math.sin((i / n) * Math.PI * 2 - 1.2);
    const median = 60 + 70 * load + (rand() - 0.5) * 6;
    const spread = 12 + 28 * load;
    rows.push([
      BASE + i * HOUR,
      Math.round(median - spread),
      Math.round(median - spread * 0.4),
      Math.round(median),
      Math.round(median + spread * 0.5),
      Math.round(median + spread * 1.3),
    ]);
  }
  return new TimeSeries({ name: 'hourly-latency', schema: boxSchema, rows });
}

export function hourlyLatencyRange(n = 14): [number, number] {
  const HOUR = 3_600_000;
  return [BASE - HOUR / 2, BASE + (n - 1) * HOUR + HOUR / 2];
}
