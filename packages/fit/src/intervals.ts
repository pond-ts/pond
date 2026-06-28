/**
 * Per-sample time interval `dt`, clamped to `[0, maxGap]` so recording pauses
 * don't inflate time-weighted sums (a stop is a gap, not 20 min at the last
 * value). Shared by every time-weighted reduction — power work/zones and the
 * HR/pace zone distributions. Deliberate modelling choice: it engages on
 * real sampling gaps (e.g. one 13 s gap on the Vineman ride), which is why total
 * work still matches Strava. Conservative; not yet caller-tunable.
 */
export function intervals(timeSec: Float64Array, maxGap = 10): Float64Array {
  const dt = new Float64Array(timeSec.length);
  for (let i = 1; i < timeSec.length; i++) {
    const d = timeSec[i]! - timeSec[i - 1]!;
    dt[i] = d > 0 ? Math.min(d, maxGap) : 0;
  }
  return dt;
}
