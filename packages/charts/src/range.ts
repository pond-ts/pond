/**
 * Pixel x-span for a range/interval-keyed mark (a bar or a box) spanning
 * `[beginMs, endMs]`, inset by `gapPx` total (half each side) so adjacent marks
 * breathe. Returns `[x0, x1]` with `x0 <= x1`.
 *
 * The chart supplies the range — the key's `begin`/`end` for an interval series,
 * or a derived width for a point-keyed one — plus the gap; this is just the math,
 * so it unit-tests without a canvas. Shared by `BarChart` + `BoxPlot`.
 *
 * A span that the gap would invert (narrower than `minWidthPx` after the inset)
 * collapses to a `minWidthPx` mark centred in the slot, so a too-thin bucket
 * stays visible and the bar never flips inside-out.
 *
 * `maxWidthPx` caps the **ink** and is applied *after* the inset, centred in the
 * slot ([PND-BARWIDTH]). It is the missing half of the width vocabulary: `gapPx`
 * is a *relative* inset, so on its own bar width is always `slot - gap` and
 * fattens with the slot. Two independent sizes — slots spreading to fill the
 * plot, ink pinned to N px — is what makes a measure comparable **between**
 * panes, since a bar that widens with its pane reads as a different weight of
 * the same thing. Expressing that with the relative knob alone requires
 * predicting the slot width and back-solving the gap, which re-derives this
 * function's arithmetic in consumer code.
 *
 * `minWidthPx` still wins: a cap below the floor yields the floor, so the two
 * bounds can never invert the rect.
 */
export function barSpanPx(
  beginMs: number,
  endMs: number,
  xScale: (value: number) => number,
  gapPx = 0,
  minWidthPx = 1,
  maxWidthPx?: number,
): [number, number] {
  const a = xScale(beginMs);
  const b = xScale(endMs);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const inset = gapPx / 2;
  let x0 = lo + inset;
  let x1 = hi - inset;
  // The cap reads on the INSET span, not the raw slot, so `gap` keeps its
  // meaning as the minimum breathing room: a bar is never wider than the gap
  // allows, and never wider than the cap, whichever binds first.
  if (maxWidthPx !== undefined && maxWidthPx > 0 && x1 - x0 > maxWidthPx) {
    const mid = (lo + hi) / 2;
    x0 = mid - maxWidthPx / 2;
    x1 = mid + maxWidthPx / 2;
  }
  if (x1 - x0 >= minWidthPx) return [x0, x1];
  const mid = (lo + hi) / 2;
  return [mid - minWidthPx / 2, mid + minWidthPx / 2];
}
