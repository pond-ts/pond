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
   * Upper edge — **always finite, always `> start`**. The top band is
   * open-ended (see {@link ZoneTime.openEnded}); its `end` is drawn out to the
   * highest value observed, never `Infinity`.
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
  return labels.map((label, z) => {
    const start = edges[z]!;
    const rawEnd = edges[z + 1] ?? SENTINEL;
    const openEnded = rawEnd >= SENTINEL;
    return {
      zone: z + 1,
      label,
      start,
      // The open-ended top band has no real upper edge. Draw it out to the
      // highest value observed, and never narrower than the band below it —
      // a zero-width bin is what `byColumn` rejects as unrepresentable, and
      // it would vanish from a chart even while holding time.
      end: openEnded
        ? Math.max(observedMax, start + openTopWidth(edges, z))
        : rawEnd,
      openEnded,
      seconds: secs[z] ?? 0,
      fraction: (secs[z] ?? 0) / total,
    };
  });
}

/**
 * A drawable width for the open-ended top band when the data doesn't supply
 * one: the width of the band below it, falling back to 1 unit when there is no
 * band below (or it too is degenerate). Guarantees `end > start`.
 */
function openTopWidth(edges: ReadonlyArray<number>, z: number): number {
  const below = z > 0 ? edges[z]! - edges[z - 1]! : 0;
  return below > 0 ? below : 1;
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
