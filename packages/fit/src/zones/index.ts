/**
 * Time-in-zone over a **value axis** — the engine behind the power, heart-rate,
 * and pace zone distributions. Each is "how long did this channel spend in each
 * band," i.e. bucket the per-sample value by the zone edges and sum each
 * sample's duration. That's pond `byColumn` over the value column, summing a
 * gap-clamped `dt` weight — the same shape the power distribution uses,
 * generalized so HR and pace share one tested core.
 */
import { TimeSeries } from 'pond-ts';
import type { ZoneDef } from '../profile/index.js';
import { intervals } from '../intervals.js';

const BIN_SCHEMA = [
  { name: 'time', kind: 'time' },
  // optional so a non-finite sample rides as `undefined` and byColumn drops it.
  { name: 'val', kind: 'number', required: false },
  { name: 'dt', kind: 'number' },
] as const;

const SENTINEL = 1e9; // the open-top edge ZoneDef carries

/**
 * One zone's time + share.
 *
 * Carries pond's canonical bin edges (`start` / `end`) so the array feeds
 * `@pond-ts/charts` (`<BarChart bins>` / `stacksFromBins`) with no mapping
 * step — the same `{ start, end, …aggregates }` shape core's `byColumn`
 * returns, and the same guarantee core enforces: **finite, with
 * `end > start`.** (An infinite edge blows up a chart's axis domain; a
 * zero-width bin is what `byColumn` itself rejects as unrepresentable.)
 */
export interface ZoneTime {
  /** 1-based zone number (Z1 = the lowest band). */
  zone: number;
  label: string;
  /**
   * Lower edge, in the value axis (watts / bpm / m·s⁻¹). Bands are
   * **inclusive-upper** (`(start, end]`), so this edge belongs to the band
   * below — except on Z1, whose floor is inclusive.
   */
  start: number;
  /**
   * Upper edge — **always finite, always `> start`**. On a closed band this is
   * the real edge. The open-ended band has none, so `end` is a **drawable
   * stand-in**, never `Infinity`: wide enough to cover the highest value
   * observed, and at least as wide as the band below. Treat it as a drawing
   * bound, not as data — it can exceed anything actually recorded (and a
   * device's out-of-range sentinel sample will stretch it).
   */
  end: number;
  /**
   * `true` on the open-ended top band, whose real upper edge is unbounded —
   * `end` is a drawable stand-in. Label it `"{start}+"` rather than as a range.
   */
  openEnded: boolean;
  seconds: number;
  /** Share of total in-zone time, [0, 1]. */
  fraction: number;
}

/**
 * Time spent in each zone, bucketing `values` by the ascending `edges` and
 * summing per-sample `dt`. pond `byColumn({ edges, inclusive: '(]' })` over the
 * value axis — Coggan-style **inclusive-upper** bins natively (a sample exactly
 * on a boundary counts in the lower zone), no ε-nudge. Non-finite values are
 * dropped (can't be placed); sub-zero clamps to the bottom zone. pond 0.30 made
 * the floor edge of `'(]'` inclusive (the `include_lowest` convention), so a 0
 * sample (a stop / coast) lands in zone 1 with the edges passed as-is — no
 * floor-push needed (F-inclusive-floor, resolved in 0.30).
 */
export function zoneDistributionByValue(
  values: ArrayLike<number>,
  dt: ArrayLike<number>,
  zones: ZoneDef,
): ZoneTime[] {
  const { edges, labels } = zones;
  const rows: Array<[number, number | undefined, number]> = [];
  // Track the highest value actually seen (clamped the same way it's binned) —
  // it's the finite upper edge we give the open-top zone so it can be drawn.
  let observedMax = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    const clamped = Number.isFinite(v) ? Math.max(0, v) : undefined;
    if (clamped !== undefined && clamped > observedMax) observedMax = clamped;
    rows.push([i, clamped, dt[i] ?? 0]);
  }
  const bins = new TimeSeries({
    name: 'zones',
    schema: BIN_SCHEMA,
    rows,
  }).byColumn(
    'val',
    { edges, inclusive: '(]' },
    { seconds: { from: 'dt', using: 'sum' } },
  );
  const secs = bins.map((b) => (b.seconds as number) ?? 0);
  const total = secs.reduce((a, b) => a + b, 0) || 1;
  const last = labels.length - 1;
  return labels.map((label, z) => {
    const start = edges[z]!;
    const rawEnd = edges[z + 1] ?? SENTINEL;
    // Only the FINAL band can be open-ended. The sentinel is a magnitude, so a
    // caller whose real edges reach past it would otherwise flag an interior
    // band open too — and then overlap the band above it.
    const openEnded = z === last && rawEnd >= SENTINEL;
    return {
      zone: z + 1,
      label,
      start,
      end: openEnded ? openTopEnd(start, edges, z, observedMax) : rawEnd,
      openEnded,
      seconds: secs[z] ?? 0,
      fraction: (secs[z] ?? 0) / total,
    };
  });
}

/**
 * A finite, drawable upper edge for the open-ended top band, which has no real
 * one. Wide enough to cover the highest value observed, and never narrower than
 * the band below it — a zero-width bin is what `byColumn` rejects as
 * unrepresentable, and it would vanish from a chart even while holding time.
 */
function openTopEnd(
  start: number,
  edges: ReadonlyArray<number>,
  z: number,
  observedMax: number,
): number {
  const below = z > 0 ? start - edges[z - 1]! : 0;
  const end = Math.max(observedMax, start + (below > 0 ? below : 1));
  // At absurd magnitudes (≥2^53) adding a width is a no-op, so fall back to the
  // next representable double — `end > start` is a guarantee, not a best effort.
  return end > start ? end : nextUp(start);
}

/** The smallest double strictly greater than `x` (`x >= 0`). */
function nextUp(x: number): number {
  if (x === 0) return Number.MIN_VALUE;
  const up = x * (1 + Number.EPSILON);
  return up > x ? up : x + Math.abs(x) * Number.EPSILON * 2;
}

/** Time in each HR zone (bpm axis). `hrZones` from `profile.profileAsOf`. */
export function hrZoneDistribution(
  timeSec: Float64Array,
  heartrate: ArrayLike<number>,
  hrZones: ZoneDef,
): ZoneTime[] {
  return zoneDistributionByValue(heartrate, intervals(timeSec), hrZones);
}

/** Time in each pace zone. We bucket the **speed** channel (m/s) against
 *  speed-axis edges (Z1 = slowest) so a stop doesn't blow the reciprocal up;
 *  the UI labels the bands as paces. `paceZones` from `profile.profileAsOf`. */
export function paceZoneDistribution(
  timeSec: Float64Array,
  speed: ArrayLike<number>,
  paceZones: ZoneDef,
): ZoneTime[] {
  return zoneDistributionByValue(speed, intervals(timeSec), paceZones);
}
