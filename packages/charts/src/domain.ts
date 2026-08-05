import { scaleLinear, scaleLog } from 'd3-scale';
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
 *
 * `scale` selects the spacing. `'log'` delegates to {@link resolveLogDomain},
 * which applies **every policy above** — verbatim explicit bounds, an auto-fit
 * side that moves rather than a caller's bound being discarded, `.nice()` on a
 * fully auto-fit domain — and differs only where a log axis forces it to: a
 * non-positive bound has no position and is refused, and `pad` is a fraction of
 * the *decades* spanned rather than of the difference.
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
 *  zero to anchor on, and `[0, 1]` (the linear empty-data domain) has no
 *  position for its own low end: `scaleLog().domain([0, 1])(x)` is `NaN` for
 *  every `x`, which poisons every coordinate drawn against it. */
const LOG_EMPTY_LO = 1;
const LOG_EMPTY_HI = 10;

/**
 * The log analog of {@link resolveBase} + padding.
 *
 * The **policy** is deliberately identical to linear's, so `scale="log"` changes
 * how a domain is spaced and not what the props mean:
 *
 * - **Two explicit bounds are verbatim** (an inverted pair is a deliberate axis
 *   flip; we don't second-guess it).
 * - **A partial explicit bound is never discarded.** When one side is explicit
 *   and the resolved domain would invert, the **auto-fit** side moves — exactly
 *   as {@link resolveBase} does. (This inverted the caller's policy until the
 *   log-axis review: `resolveLogDomain(undefined, 100, [[1000, 2000]])` returned
 *   `[1000, 10000]`, silently throwing away the requested `max` and putting the
 *   axis three decades from where it was asked to be.)
 * - **A fully auto-fit domain is `.nice()`d**, the promise {@link resolveYDomain}
 *   already documents. `scaleLog().nice()` extends to whole powers of ten, so
 *   the extremes get headroom instead of sitting clipped against the plot edge
 *   and the decade ticks land on the domain bounds.
 *
 * Two things differ from linear, and both are consequences of the same fact —
 * that a log axis has no position for zero:
 *
 * - **Non-positive bounds are unusable.** Auto-fit takes the smallest
 *   *positive* extent rather than the smallest, so one zero sample doesn't
 *   collapse the axis; an explicit non-positive `min`/`max` is ignored in
 *   favour of the data (a caller asking for `min={0}` on a log axis has asked
 *   for `NaN` — see {@link logAxisWarning} — which we will not hand to a scale).
 *   A bound refused this way is treated as *absent* from here on, so the side
 *   that survives is still honoured as an explicit bound.
 * - **Padding is multiplicative.** `pad` is a *fraction of the domain*, and on
 *   a log axis the domain's span is a ratio, not a difference. Padding
 *   additively would add a constant number of bytes to a decade — invisible at
 *   the top, enormous at the bottom. Applying it in log space adds the same
 *   *fraction of a decade* at both ends, which is what the linear behaviour
 *   looks like to the eye. (The expression is sign-correct on a flipped domain
 *   for the same reason linear's is: `log10(hi/lo)` goes negative, so both ends
 *   still move outward.)
 */
function resolveLogDomain(
  min: number | undefined,
  max: number | undefined,
  extents: Iterable<readonly [number, number] | null>,
  pad: number,
): [number, number] {
  // A non-positive explicit bound is refused, and from here on is simply absent
  // — so `max={1e6}` with a refused `min={0}` still behaves as "explicit top,
  // auto-fit floor" rather than falling into the both-explicit branch.
  const explicitLo = min !== undefined && min > 0 ? min : undefined;
  const explicitHi = max !== undefined && max > 0 ? max : undefined;

  const [lo, hi] = resolveLogBase(explicitLo, explicitHi, extents);
  if (!pad) return [lo, hi];
  // A fraction of the *decades* spanned, added at each end.
  const decades = Math.log10(hi / lo) * pad;
  return [lo / 10 ** decades, hi * 10 ** decades];
}

/** {@link resolveLogDomain} minus the padding — the domain itself. */
function resolveLogBase(
  explicitLo: number | undefined,
  explicitHi: number | undefined,
  extents: Iterable<readonly [number, number] | null>,
): [number, number] {
  // Both bounds explicit (and positive): trust them verbatim, matching
  // `resolveBase` — including an intentional flip.
  if (explicitLo !== undefined && explicitHi !== undefined) {
    return [explicitLo, explicitHi];
  }

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
  if (dataLo === Infinity || !(dataHi > 0)) {
    // Nothing positive to fit — the log counterpart of linear's `[0, 1]`.
    dataLo = LOG_EMPTY_LO;
    dataHi = LOG_EMPTY_HI;
  } else if (dataLo === dataHi) {
    // Flat — give it room, so a constant line sits mid-row rather than on an
    // edge (linear's ±1, expressed as a ratio: half a decade each way).
    dataLo /= 10 ** 0.5;
    dataHi *= 10 ** 0.5;
  }

  let lo = explicitLo ?? dataLo;
  let hi = explicitHi ?? dataHi;
  // A partial explicit bound can sit at or past the auto-fit other side. Keep
  // the axis ascending by moving the *auto-fit* side — never discard the
  // caller's explicit bound. Exactly one side is explicit here: both-explicit
  // returned early, and a both-auto domain can't invert after the guards above.
  if (lo >= hi) {
    if (explicitLo === undefined)
      lo = hi / 10; // hi is explicit → preserve it
    else hi = lo * 10; // lo is explicit → preserve it
  }
  // Fully auto-fit → round out to whole powers of ten, for headroom and so the
  // decade ticks reach the domain bounds. A partial/full explicit bound is left
  // exact, exactly as `resolveBase` leaves it.
  if (explicitLo === undefined && explicitHi === undefined) {
    return scaleLog().domain([lo, hi]).nice().domain() as [number, number];
  }
  return [lo, hi];
}

/**
 * Does resolving this axis's domain need its layers' extents walked?
 * `yExtent()` is O(points) per layer, so the caller only pays it when a side
 * actually auto-fits.
 *
 * A log axis **refuses a non-positive bound** ({@link resolveLogDomain}), which
 * means such a bound is not a bound: that side auto-fits and needs the data. The
 * naive `min === undefined || max === undefined` test misses this, and the miss
 * is silent — `<YAxis scale="log" min={0} max={1e6}>` looked fully explicit, so
 * no extents were gathered, so the refused floor fell back to the empty-data
 * placeholder instead of the data's own floor. (`resolveLogDomain`'s unit tests
 * passed throughout: they hand it the extents directly, which is precisely what
 * the component was not doing.)
 */
export function needsExtents(axis: {
  readonly scale: YScaleKind;
  readonly min: number | undefined;
  readonly max: number | undefined;
}): boolean {
  if (axis.scale === 'log') {
    return (
      !(axis.min !== undefined && axis.min > 0) ||
      !(axis.max !== undefined && axis.max > 0)
    );
  }
  return axis.min === undefined || axis.max === undefined;
}

/**
 * The dev-mode complaint a `scale="log"` axis has about its own bounds and the
 * data linked to it, or `null` when it has none. Pure, so the policy is unit
 * tested directly rather than through a rendered console spy.
 *
 * **Every case here is unambiguous**, which is the whole design constraint. The
 * previous version warned whenever a linked extent reached zero, and that fires
 * on *every* `BarChart` — `barExtent` always widens its low end to `0` so a bar
 * can reach its baseline, whether or not the data goes anywhere near it. So the
 * `WithBars` story warned, on strictly positive data, with text asserting
 * something false about it. A dev warning that cries wolf gets muted, and then
 * the real ones are lost too.
 *
 * The cost of that precision is the one genuinely ambiguous shape: an extent of
 * exactly `[0, hi]`, which is what a line touching zero *and* a bar layer on
 * positive data both report. It is not warned about. That case is no longer
 * silent, though — a sample with no position on the axis now renders as a
 * **gap** rather than being bridged straight over, so the picture itself says
 * the data is missing there.
 */
export function logAxisWarning(
  axis: {
    readonly id: string;
    readonly scale: YScaleKind;
    readonly min: number | undefined;
    readonly max: number | undefined;
  },
  extents: readonly (readonly [number, number] | null)[],
): string | null {
  if (axis.scale !== 'log') return null;
  const reasons: string[] = [];
  // `!(x > 0)` rather than `x <= 0` so a NaN bound is caught too — it is refused
  // by the same rule and is just as invisible.
  if (axis.min !== undefined && !(axis.min > 0)) {
    reasons.push(`min={${axis.min}} was ignored (it is not a positive number)`);
  }
  if (axis.max !== undefined && !(axis.max > 0)) {
    reasons.push(`max={${axis.max}} was ignored (it is not a positive number)`);
  }
  const present = extents.filter((e) => e !== null);
  if (present.some((e) => e![0] < 0)) {
    reasons.push('data linked to this axis includes negative values');
  }
  // Independent of the above, not an `else`: an axis whose data is *entirely*
  // non-positive is both negative-valued and undrawable, and the second fact is
  // the one that explains the empty plot.
  if (present.length > 0 && !present.some((e) => e![1] > 0)) {
    // There is data, and none of it is positive — the whole axis is a fallback
    // domain and nothing will be drawn against it.
    reasons.push(
      `no data linked to this axis is positive, so the domain fell back to ` +
        `[${LOG_EMPTY_LO}, ${LOG_EMPTY_HI}]`,
    );
  }
  if (reasons.length === 0) return null;
  return (
    `<YAxis id="${axis.id}" scale="log">: ${reasons.join('; ')}. ` +
    'A log scale has no position for zero or negative numbers (d3 maps them ' +
    'to NaN), so such values are refused as bounds and are not drawn. Filter ' +
    'them out, or use the default linear scale.'
  );
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
