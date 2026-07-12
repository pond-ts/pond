import { TimeSeries } from 'pond-ts';

/**
 * The Learn track's running example (docs plan §5): cpu + latency per host,
 * on a 1-minute grid. Deterministic — a seeded PRNG, never `Math.random()`
 * or `Date.now()` — so a live-embedded chart renders identically on the
 * server and the client (no hydration mismatch) and looks the same on every
 * visit.
 */

const BASE = Date.UTC(2026, 0, 12, 9, 0, 0);
const STEP_MS = 60_000;

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

export interface ServerMetricsRow {
  readonly time: number;
  readonly cpu: number;
  readonly latency: number;
  readonly host: string;
}

/**
 * `n` minutes of cpu (0–1 fraction) + latency (ms) for one host, wandering
 * around a per-host baseline with a slow sine drift plus small seeded noise.
 */
function hostRows(
  host: string,
  seed: number,
  n: number,
  cpuBase: number,
  latencyBase: number,
): ServerMetricsRow[] {
  const rand = mulberry32(seed);
  const rows: ServerMetricsRow[] = [];
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 14) * 0.12;
    const cpu = Math.max(
      0.02,
      Math.min(0.98, cpuBase + drift + (rand() - 0.5) * 0.06),
    );
    const latency = Math.max(4, latencyBase + drift * 80 + (rand() - 0.5) * 8);
    rows.push({
      time: BASE + i * STEP_MS,
      cpu: Math.round(cpu * 1000) / 1000,
      latency: Math.round(latency * 10) / 10,
      host,
    });
  }
  return rows;
}

/** The three hosts used throughout the Learn track and its embeds. */
export const HOSTS = ['api-1', 'api-2', 'worker-1'] as const;

/**
 * The full long-form dataset — one row per host per minute, `n` minutes
 * (default 90). Suitable for `partitionBy('host')` in later chapters.
 */
export function serverMetricsRows(n = 90): ServerMetricsRow[] {
  return [
    ...hostRows('api-1', 1, n, 0.35, 42),
    ...hostRows('api-2', 2, n, 0.48, 55),
    ...hostRows('worker-1', 3, n, 0.62, 30),
  ].sort((a, b) => a.time - b.time || a.host.localeCompare(b.host));
}

/** The single-series cut (`api-1` only) — ch. 1's "first chart" dataset. */
export function singleHostSeries(
  n = 90,
): TimeSeries<
  readonly [
    { name: 'time'; kind: 'time' },
    { name: 'cpu'; kind: 'number' },
    { name: 'latency'; kind: 'number' },
  ]
> {
  const rows = hostRows('api-1', 1, n, 0.35, 42);
  return TimeSeries.fromJSON({
    name: 'api-1',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'latency', kind: 'number' },
    ] as const,
    rows: rows.map((r) => ({ time: r.time, cpu: r.cpu, latency: r.latency })),
  });
}

/** The full long-form series across all hosts (`host` as a string column). */
export function allHostsSeries(
  n = 90,
): TimeSeries<
  readonly [
    { name: 'time'; kind: 'time' },
    { name: 'cpu'; kind: 'number' },
    { name: 'latency'; kind: 'number' },
    { name: 'host'; kind: 'string' },
  ]
> {
  return TimeSeries.fromJSON({
    name: 'server-metrics',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'latency', kind: 'number' },
      { name: 'host', kind: 'string' },
    ] as const,
    rows: serverMetricsRows(n),
  });
}
