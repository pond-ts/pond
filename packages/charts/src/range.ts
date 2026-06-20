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
 */
export function barSpanPx(
  beginMs: number,
  endMs: number,
  xScale: (value: number) => number,
  gapPx = 0,
  minWidthPx = 1,
): [number, number] {
  const a = xScale(beginMs);
  const b = xScale(endMs);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const inset = gapPx / 2;
  const x0 = lo + inset;
  const x1 = hi - inset;
  if (x1 - x0 >= minWidthPx) return [x0, x1];
  const mid = (lo + hi) / 2;
  return [mid - minWidthPx / 2, mid + minWidthPx / 2];
}
