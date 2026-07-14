/**
 * Tick layout for a **derived-unit axis** — a second labeling of the same
 * scale (`<XAxis transform>`): strike relabelled as moneyness, std-moneyness
 * relabelled as BS delta. The transform may be nonlinear, which stretches or
 * compresses the derived unit across the pixel range — so a single uniform
 * step can't work (uniform delta ticks pile up mid-axis and leave the
 * stretched wings empty). Instead: a **pixel-aware multi-resolution fill** —
 * walk nice step sizes (the 1-2-5 ladder) coarsest→finest, admitting each
 * candidate tick wherever it keeps `minPx` of room from every tick already
 * placed. A compressed span ends up with coarse ticks, a stretched span picks
 * up finer ones (the reference look: `0.10`-step deltas mid-axis, `0.45 /
 * 0.49` out in the wings). A linear transform degenerates to ordinary
 * evenly-spaced nice ticks through the same code path.
 */

/** A derived-unit transform: `to`/`from` are monotonic inverses (either
 *  direction — a decreasing transform is fine); they may be nonlinear. */
export interface AxisTransform {
  /** Axis value → derived unit (e.g. strike → moneyness). */
  to(value: number): number;
  /** Derived unit → axis value (inverse of {@link to}). */
  from(unit: number): number;
}

/** One derived tick: its value in the derived unit and its plot pixel. */
export interface DerivedTick {
  readonly u: number;
  readonly x: number;
}

/** The largest 1-2-5 nice step ≤ `span` (so the coarsest level yields at
 *  least one interval across the domain). */
function firstStep(span: number): number {
  const pow = 10 ** Math.floor(Math.log10(span));
  for (const m of [5, 2, 1]) {
    if (m * pow <= span) return m * pow;
  }
  return pow / 2; // span < pow can't happen (pow ≤ span), belt-and-braces
}

/** The next step down the 1-2-5 ladder: 5→2→1→0.5→0.2→0.1… */
function nextFiner(step: number): number {
  const pow = 10 ** Math.floor(Math.log10(step));
  const m = Math.round(step / pow);
  if (m === 5) return 2 * pow;
  if (m === 2) return pow;
  return pow / 2;
}

/** Per-level enumeration cap — a backstop against a pathological transform
 *  requesting a step so fine the candidate walk explodes. Generous: the
 *  reference delta axis enumerates ~100 candidates at its finest level. */
const MAX_CANDIDATES = 4000;

/**
 * Compute the derived-unit ticks: nice values in `transform.to`-space at
 * mixed 1-2-5 step sizes, greedily admitted coarsest-first wherever the
 * mapped pixel keeps `minPx` from every tick already placed (and stays inside
 * `[0, plotWidth]`). Returns ticks sorted by pixel. Pure — unit-testable
 * without a DOM.
 */
export function derivedTicks(
  transform: AxisTransform,
  domain: readonly [number, number],
  toPixel: (value: number) => number,
  plotWidth: number,
  minPx: number,
): DerivedTick[] {
  const ua = transform.to(domain[0]);
  const ub = transform.to(domain[1]);
  const u0 = Math.min(ua, ub);
  const u1 = Math.max(ua, ub);
  if (
    !Number.isFinite(u0) ||
    !Number.isFinite(u1) ||
    u1 <= u0 ||
    !(plotWidth > 0)
  ) {
    return [];
  }
  const kept: { u: number; x: number }[] = [];
  const fits = (x: number): boolean =>
    x >= 0 && x <= plotWidth && kept.every((k) => Math.abs(k.x - x) >= minPx);
  // More ticks than the plot has room for can never be admitted.
  const maxTicks = Math.ceil(plotWidth / minPx) + 2;
  let step = firstStep(u1 - u0);
  // An empty level does NOT end the walk: under a nonlinear transform a
  // pixel-wide gap can have a tiny u-span (the delta wings — no 0.1-grid
  // value lands in [0.4, 0.4987], but 0.45 on the 0.05 grid does), so finer
  // levels may fill where a coarser one placed nothing. Several *consecutive*
  // empty levels mean the remaining gaps' u-spans are being outrun faster
  // than the ladder descends — give up then (plus the enumeration backstop).
  let emptyLevels = 0;
  for (let level = 0; level < 24 && kept.length < maxTicks; level++) {
    const i0 = Math.ceil(u0 / step - 1e-9);
    const i1 = Math.floor(u1 / step + 1e-9);
    if (i1 - i0 > MAX_CANDIDATES) break;
    let added = 0;
    for (let i = i0; i <= i1 && kept.length < maxTicks; i++) {
      // Clean the float (0.3, not 0.30000000000000004) — the raw `u` reaches
      // a caller-supplied format function, so it must be presentable.
      const u = Number((i * step).toPrecision(12));
      const x = toPixel(transform.from(u));
      if (Number.isFinite(x) && fits(x)) {
        kept.push({ u, x });
        added += 1;
      }
    }
    emptyLevels = added === 0 && level > 0 ? emptyLevels + 1 : 0;
    if (emptyLevels >= 3) break;
    step = nextFiner(step);
  }
  return kept.sort((a, b) => a.x - b.x);
}
