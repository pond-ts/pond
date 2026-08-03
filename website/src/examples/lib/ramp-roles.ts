import { SEQ_ROLES, SEQ_STEPS } from '@site/src/theme/useSiteChartTheme';

/**
 * `n` **theme role names** spread evenly across the sequential ramp, darkest
 * first — `rampRoles(7)` → `seq1, seq2, seq3, seq5, seq6, seq7, seq8`.
 *
 * The role-shaped sibling of
 * {@link import('@site/src/theme/useSiteChartTheme').useSequentialRamp}, which
 * returns the same stepping as **colour strings**. Which one you want depends
 * on how the layer takes its styling:
 *
 * - a layer styled by **role** (`<AreaChart as>`, `<LineChart as>`,
 *   `<BarChart as>`) wants these names;
 * - a layer that takes **colours as data** (`<BarChart colors>`, `binColors`,
 *   a scatter encoding) wants `useSequentialRamp()`.
 *
 * Spreading rather than taking the first `n` matters: `seq1…seq7` crowds seven
 * slabs into the dark seven-eighths of the ramp and drops the lightest step
 * entirely, so the top two bands sit almost on top of each other.
 *
 * Reaching past `SEQ_STEPS` clamps — the ramp is eight wide by construction,
 * and a stack that needs more slots than that wants an "other" bucket, not a
 * ninth tone.
 */
export function rampRoles(n: number): string[] {
  const count = Math.max(1, Math.min(n, SEQ_STEPS));
  return Array.from({ length: count }, (_, i) => {
    const step =
      count === 1 ? 0 : Math.round((i * (SEQ_STEPS - 1)) / (count - 1));
    return SEQ_ROLES[step]!;
  });
}
