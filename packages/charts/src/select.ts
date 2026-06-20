import type { LayerEntry, SelectInfo } from './context.js';

/**
 * Resolve a click at plot-pixel `(px, py)` to the selected mark, or `null`.
 * Walks the row's layers **top-down** (reverse z-order — the topmost mark wins,
 * matching what the user sees) and returns the first `hitTest` hit. A layer with
 * no `hitTest` (line / band / area) or no resolvable y-scale is skipped.
 *
 * Pure, given the row's `xScale` and a per-axis y-scale lookup — so the click
 * dispatch in `Layers` unit-tests without a DOM. (Layers passes its sorted
 * z-stack, the shared `xScale`, and its `axisId → yScale` resolver.)
 */
export function resolveSelection(
  entries: readonly LayerEntry[],
  px: number,
  py: number,
  xScale: (value: number) => number,
  yScaleFor: (
    axisId: string | undefined,
  ) => ((value: number) => number) | undefined,
): SelectInfo | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    const yScale = yScaleFor(entry.axisId);
    if (yScale === undefined) continue;
    const hit = entry.layer.hitTest?.(px, py, xScale, yScale);
    if (hit) return hit;
  }
  return null;
}
