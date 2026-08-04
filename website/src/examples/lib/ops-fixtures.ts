import { TimeSeries } from 'pond-ts';

/**
 * **Modelled data**, not measured — the Gallery's ops & infrastructure cards
 * other than the CERN network-traffic pair (`cern-traffic.ts`, which is real).
 * Say so on any page that draws these: fleet CPU, request latency percentiles
 * and error-budget burn are all things nobody publishes openly at a useful
 * resolution, so they are simulated here rather than sourced.
 *
 * Modelled means the **process**, not a sine with noise on it (see
 * `src/examples/lib/README.md`). Each generator below carries the structure
 * the real signal has and that the chart exists to show:
 *
 * - a **diurnal** load curve with a genuine trough, not a symmetric wave;
 * - **weekday vs weekend** shape where the window is long enough to have one;
 * - **discrete events** — a deploy, a restart with the gap it leaves in the
 *   scrape, a nightly batch window, a dependency stall that moves the tail
 *   percentile and leaves the median alone;
 * - **noise whose size scales with the signal**, because that is how load
 *   noise behaves.
 *
 * Every generator is seeded (`mulberry32`) and takes its timestamps from a
 * fixed epoch — never `Math.random()`, never `Date.now()` — so a chart renders
 * byte-identically on the server, on the client, and on every visit.
 */

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

/** Sum of two uniforms − 1: a cheap triangular ≈ normal, in `[-1, 1]`. */
function noise(rand: () => number): number {
  return rand() + rand() - 1;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// A2 — fleet CPU, one line per host from `partitionBy('host')`
// ---------------------------------------------------------------------------

/** Midnight UTC on a Wednesday, so the 24 h window is an ordinary weekday. */
const FLEET_START = Date.UTC(2026, 4, 13, 0, 0, 0);
const FLEET_STEP = 2 * MINUTE;
const FLEET_COUNT = 720; // 24 h

/** The hosts in the modelled fleet, in the order the legend should list them. */
export const FLEET_HOSTS = ['web-01', 'web-02', 'api-01', 'batch-01'] as const;

export type FleetHost = (typeof FLEET_HOSTS)[number];

/** How long `web-02` is off the air when the node is recycled, in minutes. */
const RESTART_MINUTES = 24;

/**
 * Traffic-shaped load for the hour-of-day `h` (fractional), 0–1. Not a sine:
 * a broad daytime plateau with a slow morning ramp and a faster evening
 * decay, bottoming out around 04:00 — which is the shape a request-driven
 * service actually has, and the reason the batch window is scheduled where it
 * is.
 */
function diurnal(h: number): number {
  const ramp = 1 / (1 + Math.exp(-(h - 8) / 1.1)); // wakes up ~08:00
  const decay = 1 / (1 + Math.exp((h - 20) / 1.6)); // winds down ~20:00
  return ramp * decay;
}

const fleetSchema = [
  { name: 'time', kind: 'time' },
  // `required: false` is what lets a scrape be **missing** rather than zero —
  // the restart gap below depends on it, and a `number` column without it
  // rejects the row outright.
  { name: 'cpu', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
] as const;

type FleetRow = [number, number | null, string];

/**
 * 24 hours of CPU utilisation (0–1) across a four-host fleet on a 2-minute
 * scrape, long-form — one row per host per scrape, ready for
 * `partitionBy('host')`.
 *
 * The four hosts are deliberately four *different shapes*, because a fleet
 * chart that shows four copies of one curve teaches nothing:
 *
 * - **`web-01` / `web-02`** sit behind the same load balancer, so they track
 *   each other's diurnal curve with independent jitter.
 * - **`api-01`** runs hotter and is where the noisy-neighbour burst lands
 *   (14:00–14:30).
 * - **`batch-01`** is the opposite shape: near-idle all day, pinned during
 *   the nightly batch window (02:00–04:30) that is scheduled into the traffic
 *   trough.
 *
 * Two events worth pointing at from a page:
 *
 * - **A deploy at 15:20** recycles `web-02`'s node. Its scrapes go **missing
 *   for 24 minutes** — absent, not zero, because the collector got nothing,
 *   which is a different fact from "the CPU was idle" — and it comes back at
 *   a lower baseline because the deploy fixed a leak.
 * - **A noisy neighbour on `api-01` at 14:00** lifts it for half an hour with
 *   no matching move on the web tier — the give-away that it isn't load.
 */
export function fleetCpuRows(): FleetRow[] {
  const rows: FleetRow[] = [];
  const rand = mulberry32(4113);

  // Per-host state so each walk is smooth rather than independent per sample.
  const jitter: Record<string, number> = {
    'web-01': 0,
    'web-02': 0,
    'api-01': 0,
    'batch-01': 0,
  };

  const deployAt = 15 * 60 + 20; // minutes into the day
  const deployBack = deployAt + RESTART_MINUTES;

  for (let i = 0; i < FLEET_COUNT; i += 1) {
    const t = FLEET_START + i * FLEET_STEP;
    const mins = (i * FLEET_STEP) / MINUTE;
    const h = mins / 60;
    const load = diurnal(h);

    for (const host of FLEET_HOSTS) {
      // Noise scales with the signal — an idle box is quiet, a busy one isn't.
      let base: number;
      if (host === 'batch-01') {
        // Nightly batch: a plateau with ramped edges, 02:00 → 04:30.
        const inWindow = h >= 2 && h <= 4.5;
        const edge = inWindow ? Math.min(1, (h - 2) / 0.2, (4.5 - h) / 0.3) : 0;
        base = 0.04 + 0.82 * Math.max(0, edge);
      } else if (host === 'api-01') {
        const neighbour = h >= 14 && h < 14.5 ? 0.26 : 0;
        base = 0.22 + 0.44 * load + neighbour;
      } else {
        // The two web boxes: same curve, and web-02 drops a step after the
        // deploy fixes its leak.
        const leak = host === 'web-02' && mins < deployAt ? 0.09 : 0;
        base = 0.14 + 0.5 * load + leak;
      }

      jitter[host] = jitter[host]! * 0.75 + noise(rand) * 0.035;
      const cpu = Math.max(
        0.01,
        Math.min(0.99, base + jitter[host]! * (0.4 + base)),
      );

      const restarting =
        host === 'web-02' && mins >= deployAt && mins < deployBack;
      rows.push([t, restarting ? null : Math.round(cpu * 1000) / 1000, host]);
    }
  }
  return rows;
}

/** {@link fleetCpuRows} as one long-form `TimeSeries` — `partitionBy('host')`
 *  splits it into the four per-host series a multi-line chart draws. */
export function fleetCpu(): TimeSeries<typeof fleetSchema> {
  fleetCache ??= TimeSeries.fromJSON({
    name: 'fleet-cpu',
    schema: fleetSchema,
    rows: fleetCpuRows(),
  });
  return fleetCache;
}

/**
 * Built once and reused. The Gallery cards animate, so an example's body runs
 * ~24 times a second; regenerating thousands of rows per frame is wasteful,
 * and a fresh series identity each frame re-registers every chart layer.
 */
let fleetCache: TimeSeries<typeof fleetSchema> | undefined;

/** The events the fleet-CPU page points at, as epoch ms. */
export const FLEET_EVENTS = {
  /** `web-02`'s node recycle — {@link RESTART_MINUTES} of missing scrapes. */
  deployAt: FLEET_START + (15 * 60 + 20) * MINUTE,
  deployBack: FLEET_START + (15 * 60 + 20 + RESTART_MINUTES) * MINUTE,
  /** Nightly batch window on `batch-01`. */
  batchFrom: FLEET_START + 2 * HOUR,
  batchTo: FLEET_START + 4.5 * HOUR,
  /** Noisy-neighbour burst on `api-01`. */
  neighbourFrom: FLEET_START + 14 * HOUR,
  neighbourTo: FLEET_START + 14.5 * HOUR,
} as const;

/** The fleet window as `[begin, end]`. */
export const FLEET_RANGE: readonly [number, number] = [
  FLEET_START,
  FLEET_START + (FLEET_COUNT - 1) * FLEET_STEP,
];

// ---------------------------------------------------------------------------
// A3 — request-latency percentiles, a nested envelope around the median
// ---------------------------------------------------------------------------

const LATENCY_START = Date.UTC(2026, 4, 13, 6, 0, 0);
const LATENCY_STEP = MINUTE;
const LATENCY_COUNT = 540; // 9 h

const latencySchema = [
  { name: 'time', kind: 'time' },
  { name: 'p50', kind: 'number' },
  { name: 'p75', kind: 'number' },
  { name: 'p90', kind: 'number' },
  { name: 'p99', kind: 'number' },
] as const;

/**
 * Nine hours of per-minute request-latency percentiles (ms) for one service:
 * `p50`, `p75`, `p90`, `p99`.
 *
 * Modelled as a **queue**, which is why the percentiles move differently from
 * one another — the whole point of plotting them together. Service time is
 * roughly flat; latency is service time divided by the headroom left
 * (`1 − utilisation`), so as load climbs the median creeps and the tail
 * runs away. The spread between p50 and p99 is therefore widest exactly when
 * the service is busiest, which no independent-percentile generator produces.
 *
 * Two events sit on top of it:
 *
 * - **A dependency stall at 11:12, lasting 9 minutes.** A downstream cache
 *   goes cold: a small fraction of requests block, so at the worst minute
 *   **`p99` is 5.7× its pre-stall level (185 → 1052 ms) while `p50` moves
 *   1.23× (52 → 64 ms)** — the canonical "your average is lying to you"
 *   shape, and the reason a single mean line is not a latency chart.
 * - **A steady climb through the morning** as utilisation rises, which moves
 *   every percentile but the tail most: `p50` runs 19 → 57 ms across the
 *   window while `p99` runs 74 → 211 ms.
 */
export function latencyPercentiles(): TimeSeries<typeof latencySchema> {
  if (latencyCache) return latencyCache;
  const rand = mulberry32(9077);
  const rows: Array<[number, number, number, number, number]> = [];
  let drift = 0;

  for (let i = 0; i < LATENCY_COUNT; i += 1) {
    const t = LATENCY_START + i * LATENCY_STEP;
    const h = 6 + (i * LATENCY_STEP) / HOUR;

    // Utilisation follows the same daytime curve the fleet does, 0.30 → 0.82.
    const util = 0.3 + 0.52 * diurnal(h);
    drift = drift * 0.9 + noise(rand) * 0.012;
    const rho = Math.max(0.15, Math.min(0.93, util + drift));

    // M/M/1-ish: response time scales as 1 / (1 − ρ). Service time ~14 ms.
    const service = 14;
    const wait = service / (1 - rho);

    // The stall: a fraction of requests park behind a cold cache. It shows in
    // the tail long before it shows in the middle.
    const mins = (i * LATENCY_STEP) / MINUTE;
    const stall = mins >= 312 && mins < 321 ? 1 : 0; // 11:12 → 11:21
    const stallEdge = stall * Math.min(1, (mins - 311) / 2, (321 - mins) / 2);

    // The stall lands almost entirely in the tail: a small fraction of
    // requests block, so p50 shifts a few ms and p99 multiplies.
    const p50 = wait * (0.82 + 0.06 * noise(rand)) + 5 * stallEdge;
    const p75 = p50 * (1.28 + 0.05 * noise(rand)) + 22 * stallEdge;
    const p90 = p75 * (1.42 + 0.07 * noise(rand)) + 95 * stallEdge;
    const p99 = p90 * (2.1 + 0.18 * noise(rand)) + 520 * stallEdge;

    const r = (x: number) => Math.round(x * 10) / 10;
    rows.push([t, r(p50), r(p75), r(p90), r(p99)]);
  }

  latencyCache = TimeSeries.fromJSON({
    name: 'request-latency',
    schema: latencySchema,
    rows,
  });
  return latencyCache;
}

let latencyCache: TimeSeries<typeof latencySchema> | undefined;

/** Points of interest on {@link latencyPercentiles}. */
export const LATENCY_EVENTS = {
  /** The cold-cache stall — p99 runs away, p50 hardly notices. */
  stallFrom: LATENCY_START + 312 * MINUTE,
  stallTo: LATENCY_START + 321 * MINUTE,
  /** The service's p99 objective, ms. */
  sloMs: 400,
} as const;

/** The latency window as `[begin, end]`. */
export const LATENCY_RANGE: readonly [number, number] = [
  LATENCY_START,
  LATENCY_START + (LATENCY_COUNT - 1) * LATENCY_STEP,
];

// ---------------------------------------------------------------------------
// A4 — a week of error-budget burn, with the incidents that spent it
// ---------------------------------------------------------------------------

/** Monday 00:00 UTC — the window is a full Mon–Sun week. */
const SLA_START = Date.UTC(2026, 4, 11, 0, 0, 0);
const SLA_STEP = HOUR;
const SLA_COUNT = 168; // 7 days

const slaSchema = [
  { name: 'time', kind: 'time' },
  { name: 'errorRate', kind: 'number' },
  { name: 'budgetLeft', kind: 'number' },
] as const;

/**
 * A week of hourly **error rate** for one service, plus the **error budget**
 * it leaves — the two columns an SLA review actually argues over.
 *
 * The budget is the honest arithmetic rather than a second invented series:
 * a 99.9% availability objective allows 0.1% of requests to fail over the
 * window, so `budgetLeft` starts at 1 and each hour subtracts that hour's
 * share of failures against the allowance. It is a monotonically falling
 * line, which is what makes it readable — the slope *is* the burn rate.
 *
 * Shape: a ~0.024% weekday baseline, a **weekend** that carries about a third
 * of the request volume — which shows as a flatter budget slope rather than a
 * lower error *rate*, since a rate is already normalised by volume — and two
 * incidents that do most of the damage:
 *
 * - **Tuesday 09:00–12:00**, a bad deploy: the error rate peaks at **1.58%**
 *   and those three hours alone cost **32.9 points** of budget (81.3% → 48.4%).
 * - **Friday 22:00–23:00**, a brief upstream DNS wobble at ~0.5%.
 *
 * The week ends with **26%** of the budget unspent — a bad week, survived.
 *
 * Three deploys land in the window (Mon 10:00, Tue 09:00 — the bad one — and
 * Wed 11:00), which is what the `Marker`s point at.
 */
export function errorBudget(): TimeSeries<typeof slaSchema> {
  if (budgetCache) return budgetCache;
  const rand = mulberry32(6631);

  // Pass 1: the hourly error rate, and the request volume behind it.
  const rates: number[] = [];
  const volumes: number[] = [];
  for (let i = 0; i < SLA_COUNT; i += 1) {
    const dayOfWeek = Math.floor(i / 24); // 0 = Monday
    const h = i % 24;
    const weekend = dayOfWeek >= 5;

    volumes.push((weekend ? 0.35 : 1) * (0.25 + 0.75 * diurnal(h)));

    const badDeploy = dayOfWeek === 1 && h >= 9 && h < 12;
    const dnsWobble = dayOfWeek === 4 && h === 22;
    let rate = 0.00022 + 0.00016 * Math.abs(noise(rand));
    if (badDeploy) rate = 0.016 + 0.003 * noise(rand);
    if (dnsWobble) rate = 0.005 + 0.001 * noise(rand);
    rates.push(rate);
  }

  // Pass 2: the budget. A 99.9% objective allows 0.1% of the window's
  // requests to fail; `budgetLeft` is the unspent fraction of that allowance,
  // so it starts at 1, only ever falls, and its slope is the burn rate.
  const allowed = SLO_TARGET * volumes.reduce((a, b) => a + b, 0);
  const rows: Array<[number, number, number]> = [];
  let spent = 0;
  for (let i = 0; i < SLA_COUNT; i += 1) {
    spent += rates[i]! * volumes[i]!;
    rows.push([
      SLA_START + i * SLA_STEP,
      Math.round(rates[i]! * 1e6) / 1e6,
      Math.round(Math.max(0, 1 - spent / allowed) * 1000) / 1000,
    ]);
  }

  budgetCache = TimeSeries.fromJSON({
    name: 'error-budget',
    schema: slaSchema,
    rows,
  });
  return budgetCache;
}

let budgetCache: TimeSeries<typeof slaSchema> | undefined;

/** The availability objective the budget is measured against: 99.9%, i.e.
 *  0.1% of requests may fail over the window. */
const SLO_TARGET = 0.001;

/** The annotations the SLA page places — incidents, deploys, the objective. */
export const SLA_MARKS = {
  /** Tuesday 09:00–12:00: the bad deploy's blast radius. */
  incidentFrom: SLA_START + (24 + 9) * HOUR,
  incidentTo: SLA_START + (24 + 12) * HOUR,
  /** Friday 22:00–23:00: the DNS wobble. */
  wobbleFrom: SLA_START + (4 * 24 + 22) * HOUR,
  wobbleTo: SLA_START + (4 * 24 + 23) * HOUR,
  /** Deploys, in order. The middle one is the bad one. */
  deploys: [
    SLA_START + 10 * HOUR,
    SLA_START + (24 + 9) * HOUR,
    SLA_START + (2 * 24 + 11) * HOUR,
  ] as const,
  /** The 99.9% objective, as an error rate. */
  sloErrorRate: 0.001,
} as const;

/** The SLA window as `[begin, end]`. */
export const SLA_RANGE: readonly [number, number] = [
  SLA_START,
  SLA_START + (SLA_COUNT - 1) * SLA_STEP,
];

// ---------------------------------------------------------------------------
// A5 — the live tail: a generator, not a table
// ---------------------------------------------------------------------------

/** The schema the live-tail card pushes into its `LiveSeries`. */
export const tailSchema = [
  { name: 'time', kind: 'time' },
  { name: 'rps', kind: 'number' },
] as const;

/**
 * A seeded generator for the live-tail card — requests/sec on one service,
 * as a mean-reverting walk with occasional short bursts (a retry storm, a
 * cache flush). Not a fixture table: the card pushes these into a
 * `LiveSeries` as it goes, so there is nothing to commit but the rule.
 *
 * `seed` fixes the whole sequence, so two readers on the same card see the
 * same trace at the same tick — the same determinism the table fixtures give,
 * applied to a stream.
 */
export function requestRateSource(seed = 1729): () => number {
  const rand = mulberry32(seed);
  let rps = 480;
  let burst = 0;
  return () => {
    if (burst > 0) burst -= 1;
    else if (rand() < 0.012) burst = 6 + Math.floor(rand() * 10);
    const target = burst > 0 ? 1150 : 480;
    rps += (target - rps) * 0.18 + noise(rand) * 26;
    rps = Math.max(60, rps);
    return Math.round(rps);
  };
}

/** Seconds between live-tail samples, so the page and the card agree. */
export const TAIL_STEP_MS = 1000;

/** How long the live tail keeps — 3 minutes at {@link TAIL_STEP_MS}. */
export const TAIL_RETENTION = 180;
