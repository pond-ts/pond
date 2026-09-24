/**
 * Cursor geometry helpers — pure functions deciding *where* the cursor sits
 * ({@link resolveCursorX}) and which bucket it shades. The marks
 * themselves render as an SVG overlay in `Layers` (no cursor canvas); these
 * helpers stay pure, so they're unit-tested directly.
 */

import { Interval } from 'pond-ts';

/**
 * The interval in the sorted, non-overlapping `buckets` that contains `t`
 * (`begin ≤ t < end`), or `undefined` if `t` falls in no bucket. Binary search —
 * the `region` cursor uses it to find the bucket under the pointer.
 */
export function bucketAt(
  buckets: readonly Interval[],
  t: number,
): Interval | undefined {
  let lo = 0;
  let hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = buckets[mid]!;
    if (t < b.begin()) hi = mid - 1;
    else if (t >= b.end()) lo = mid + 1;
    else return b;
  }
  return undefined;
}

/**
 * The `[start, end)` **span** a region cursor covers, in axis units (not pixels —
 * the drag-release callback reports this):
 *
 * - **Snapping** (`buckets` non-empty, `t1` in a bucket): the bucket at `t1`, or —
 *   with a drag anchor `t2` — the union of the `t1` and `t2` buckets, so a drag
 *   extends **bucket by bucket** either direction. A `t2` in no bucket is ignored.
 * - **Freeform** (`t1` in no bucket — e.g. no `cursorSequence` at all): a drag
 *   spans the raw `[t1, t2]`; without a drag (`t2` omitted) there's nothing to
 *   shade (the cursor renders as a plain line), so it returns `null`.
 */
export function regionSpan(
  buckets: readonly Interval[],
  t1: number,
  t2?: number,
): { start: number; end: number } | null {
  const a = bucketAt(buckets, t1);
  if (a === undefined) {
    // Freeform: no bucket under t1. A drag spans the raw [t1, t2]; a bare hover
    // has nothing to shade (Layers draws a line for the degenerate region cursor).
    return t2 === undefined
      ? null
      : { start: Math.min(t1, t2), end: Math.max(t1, t2) };
  }
  if (t2 === undefined) return { start: a.begin(), end: a.end() };
  const b = bucketAt(buckets, t2);
  if (b === undefined) return { start: a.begin(), end: a.end() };
  return {
    start: Math.min(a.begin(), b.begin()),
    end: Math.max(a.end(), b.end()),
  };
}

/**
 * The pixel band for the `region` cursor: the {@link regionSpan} for `t1` (and an
 * optional drag anchor `t2`), its `[start, end)` mapped through `xScale` and
 * clamped to `[0, plotWidth]`. Returns `null` when there's no span, or when the
 * band has no width — including a span entirely in a **collapsed gap** on a
 * trading-time scale (both edges map to the same pixel), so it draws nothing
 * there rather than a zero-width sliver.
 */
export function bandRect(
  buckets: readonly Interval[],
  t1: number,
  xScale: (value: number) => number,
  plotWidth: number,
  t2?: number,
): { x0: number; x1: number } | null {
  const span = regionSpan(buckets, t1, t2);
  if (span === null) return null;
  const x0 = Math.max(0, xScale(span.start));
  const x1 = Math.min(plotWidth, xScale(span.end));
  return x1 > x0 ? { x0, x1 } : null;
}

/**
 * The unit slots `[i, i+1)` of a category axis, from its band scale's domain
 * (`[0, n]`) — the buckets a `<RangeCursor>` snaps to there when no bar layer
 * has published its own (a bar layer's are the same slots). Empty for an
 * empty axis.
 */
export function categorySlots(domain: readonly unknown[]): Interval[] {
  const lo = Number(domain[0]);
  const n = Math.max(0, Math.round(Number(domain[1]) - lo));
  const out: Interval[] = [];
  for (let i = 0; i < n; i += 1) {
    const b = lo + i;
    out.push(new Interval({ value: b, start: b, end: b + 1 }));
  }
  return out;
}

/**
 * The crosshair's plot-pixel x from the tracker inputs. **A live local pointer
 * always wins:** a chart the user is actively hovering (`hoverX` non-null) shows
 * its own cursor, even when a controlled `trackerPosition` is also supplied.
 * With no local pointer, a controlled `trackerPosition` (epoch ms) maps through
 * this chart's `xScale` — so a pinned/synced time rides with the data and lands
 * at the right pixel even under a different zoom — else there's no cursor.
 *
 * This ordering is what makes **cross-chart cursor sync** compose from the plain
 * props: give every chart the same `trackerPosition={sharedTime}` and wire
 * `onTrackerChanged` back to `sharedTime`. The chart under the pointer favors its
 * own hover (it's the source, and reports out); every other chart has no local
 * pointer, so it follows the shared time. No "which chart is active" bookkeeping.
 *
 * `null` and `undefined` are **equivalent** — both mean "no controlled position"
 * (a hovered chart still tracks its pointer; a non-hovered one shows nothing). To
 * force a chart to never show a cursor at all, mount no cursor component, rather
 * than relying on `trackerPosition={null}`.
 */
export function resolveCursorX(
  trackerPosition: number | null | undefined,
  hoverX: number | null,
  xScale: (time: number) => number,
): number | null {
  if (hoverX !== null) return hoverX;
  if (trackerPosition == null) return null;
  return xScale(trackerPosition);
}

// The cursor's line / dots / flag-staffs render as an SVG overlay in `Layers`
// (DOM, crisp, positioned in plot space) — there is no cursor canvas, so the
// former `drawCrosshair` / `drawTrackerDot` canvas primitives are gone.
