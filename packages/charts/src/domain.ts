import { scaleLinear } from 'd3-scale';
import type { YScaleKind } from './context.js';

/**
 * Resolve a y-axis `[lo, hi]` domain from its explicit bounds and the extents of
 * the layers linked to it. An `undefined` bound auto-fits the data: with no
 * finite data the domain is `[0, 1]`, a flat extent gets ±1 of headroom (so a
 * constant line sits mid-row, not on an edge).
 *
 * A **fully auto-fit** domain (both bounds `undefined`) is rounded out to nice
 * boundaries (d3 `.nice()`) — headroom so peaks / whisker caps don't sit on the
 * plot edge, plus rounder tick values. An explicit bound (full or partial) is
 * left **exact**: the caller's number is never nice'd or moved.
 *
 * Guarantees an **ascending, non-degenerate** domain whenever a bound was
 * auto-fit — a partial explicit bound with no (or flat) data on the other side
 * can otherwise invert it (e.g. `min=5` with no data would naively give
 * `[5, 1]`). Two explicit bounds are returned as-is (an inverted explicit domain
 * is a deliberate axis flip; we don't second-guess it).
 *
 * `pad` (fractional, default `0`) expands the resolved domain outward by
 * `pad × span` on each side — headroom without hand-computing bounds, useful to
 * lift a tight **explicit** domain off the plot edges. Applied last, to whatever
 * domain was resolved (explicit or auto); `0` is a no-op.
 */
export function resolveYDomain(
  min: number | undefined,
  max: number | undefined,
  extents: Iterable<readonly [number, number] | null>,
  pad = 0,
  scale: YScaleKind = 'linear',
): [number, number] {
  if (scale === 'log') return resolveLogDomain(min, max, extents, pad);
  const result = resolveBase(min, max, extents);
  if (pad) {
    const [lo, hi] = result;
    const p = pad * (hi - lo);
    return [lo - p, hi + p];
  }
  return result;
}

/** Smallest positive value a log domain will fall back to when the data offers
 *  nothing positive at all. Arbitrary but finite — a log scale has no natural
 *  zero to anchor on, and `[0, 1]` (the linear empty-data domain) maps to
 *  `[-Infinity, 0]`, which poisons every coordinate drawn against it. */
const LOG_EMPTY_LO = 1;
const LOG_EMPTY_HI = 10;

/**
 * The log analog of {@link resolveBase} + padding.
 *
 * Two things differ from linear, and both are consequences of the same fact —
 * that a log axis has no position for zero:
 *
 * - **Non-positive bounds are unusable.** Auto-fit takes the smallest
 *   *positive* extent rather than the smallest, so one zero sample doesn't
 *   collapse the axis; an explicit non-positive `min`/`max` is ignored in
 *   favour of the data (a caller asking for `min={0}` on a log axis has asked
 *   for `-Infinity`, which we will not hand to a scale).
 * - **Padding is multiplicative.** `pad` is a *fraction of the domain*, and on
 *   a log axis the domain's span is a ratio, not a difference. Padding
 *   additively would add a constant number of bytes to a decade — invisible at
 *   the top, enormous at the bottom. Applying it in log space adds the same
 *   *fraction of a decade* at both ends, which is what the linear behaviour
 *   looks like to the eye.
 */
function resolveLogDomain(
  min: number | undefined,
  max: number | undefined,
  extents: Iterable<readonly [number, number] | null>,
  pad: number,
): [number, number] {
  const explicitLo = min !== undefined && min > 0 ? min : undefined;
  const explicitHi = max !== undefined && max > 0 ? max : undefined;

  let dataLo = Infinity;
  let dataHi = -Infinity;
  for (const e of extents) {
    if (!e) continue;
    // The low end walks both ends of the extent: a series whose min is 0 or
    // negative can still have a positive max, and that max is the only
    // positive floor it can offer.
    if (e[0] > 0 && e[0] < dataLo) dataLo = e[0];
    else if (e[1] > 0 && e[1] < dataLo) dataLo = e[1];
    if (e[1] > dataHi) dataHi = e[1];
  }

  let lo = explicitLo ?? (dataLo === Infinity ? LOG_EMPTY_LO : dataLo);
  let hi = explicitHi ?? (dataHi > 0 ? dataHi : LOG_EMPTY_HI);
  if (hi <= lo) hi = lo * 10;

  if (pad) {
    // A fraction of the *decades* spanned, added at each end.
    const decades = Math.log10(hi / lo) * pad;
    lo = lo / 10 ** decades;
    hi = hi * 10 ** decades;
  }
  return [lo, hi];
}

function resolveBase(
  min: number | undefined,
  max: number | undefined,
  extents: Iterable<readonly [number, number] | null>,
): [number, number] {
  // Both bounds explicit: trust them verbatim (allows an intentional flip).
  if (min !== undefined && max !== undefined) return [min, max];

  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const e of extents) {
    if (e) {
      if (e[0] < dataMin) dataMin = e[0];
      if (e[1] > dataMax) dataMax = e[1];
    }
  }
  if (dataMin === Infinity) {
    dataMin = 0; // no finite data yet
    dataMax = 1;
  } else if (dataMin === dataMax) {
    dataMin -= 1; // flat — give it room
    dataMax += 1;
  }

  let lo = min ?? dataMin;
  let hi = max ?? dataMax;
  // A partial explicit bound can sit at/above the auto-fit other side (explicit
  // min above empty-data's max, or explicit max below the data). Keep the axis
  // ascending by moving the *auto-fit* side — never discard the caller's
  // explicit bound. Exactly one side is explicit here: both-explicit returned
  // early, and a both-auto domain can't invert after the empty/flat guards.
  if (lo >= hi) {
    if (min === undefined)
      lo = hi - 1; // max is explicit → preserve it
    else hi = lo + 1; // min is explicit → preserve it
  }
  // Fully auto-fit → round the domain out for headroom + nicer ticks. A
  // partial/full explicit bound is left exact (returned as-is below).
  if (min === undefined && max === undefined) {
    return scaleLinear().domain([lo, hi]).nice().domain() as [number, number];
  }
  return [lo, hi];
}
