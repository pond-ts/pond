/**
 * `<Legend>` support — the swatch vocabulary, the per-layer registration hook,
 * and the pure ordering/dedup pipeline the component renders from.
 *
 * The mechanism ([PND-LEGEND], #508 item 2): each draw layer registers its
 * **resolved** style as a {@link SwatchSpec} alongside its readout identity, so
 * a legend can never drift from the plot — the property an app-side legend
 * only gets by manually sharing a palette. The legend renders the registry;
 * layers self-describe.
 */

import { useContext, useEffect, useRef } from 'react';
import { RowContext, type ContainerFrame } from './context.js';

/**
 * A legend row's **swatch** — the layer's resolved style, in the mark's own
 * vocabulary (a line shows stroke + dash, a band shows its translucent fill, a
 * candle shows its up/down pair). Resolved means post-theme: the exact values
 * the canvas draws with, so the swatch and the mark can never disagree.
 */
export type SwatchSpec =
  | {
      readonly kind: 'line';
      readonly color: string;
      readonly width: number;
      readonly dash?: readonly number[] | undefined;
    }
  | {
      readonly kind: 'area';
      readonly line: string;
      readonly fill: string;
      readonly fillOpacity: number;
    }
  | { readonly kind: 'band'; readonly fill: string; readonly opacity: number }
  | {
      readonly kind: 'scatter';
      readonly color: string;
      readonly radius: number;
      readonly outline?: string | undefined;
    }
  | {
      readonly kind: 'box';
      readonly whisker: string;
      readonly whiskerWidth: number;
    }
  | { readonly kind: 'bar'; readonly fill: string }
  | { readonly kind: 'candle'; readonly up: string; readonly down: string };

/**
 * One row as a layer registers it (and as `<Legend items>` accepts it):
 * the display `label` (the layer's readout identity `as ?? column`, or its
 * `legend="name"` override), the resolved {@link SwatchSpec}, and — when the
 * layer is interactive — its selection `id`.
 */
export interface LegendRowInput {
  readonly label: string;
  readonly swatch: SwatchSpec;
  /** The layer's selection identity (its `id` prop) — gates the legend's
   *  default hover/select interactions, and keys dedup ahead of `label`. */
  readonly id?: string | undefined;
}

/** A registered legend row: the input plus its place in the chart (chart row,
 *  declaration index, position within the layer), which drives display order. */
export interface LegendItemSpec extends LegendRowInput {
  readonly rowKey: symbol;
  readonly index: number;
  /** Position within a multi-row layer (a stacked bar registers one row per
   *  column, in stack order) — `0` for the single-row marks. */
  readonly subIndex: number;
}

/**
 * Order + dedup the registered rows for display: chart-row order first (the
 * container's top-to-bottom `rowOrder`), declaration `index` within a row —
 * the existing z-order convention — then `subIndex` (stack order within a
 * multi-row layer), then label as a final stable tiebreak. Dedup keys on
 * `id ?? label` (the A2.2 selection model: `id` is the series identity; a
 * theme-role label can repeat) — the first row in display order stands for
 * the group, exactly as the tracker readout merges keys.
 */
export function orderLegendRows(
  items: Iterable<LegendItemSpec>,
  rowOrder: readonly symbol[],
): LegendItemSpec[] {
  const rowPos = new Map<symbol, number>();
  rowOrder.forEach((k, i) => rowPos.set(k, i));
  const sorted = [...items].sort(
    (a, b) =>
      (rowPos.get(a.rowKey) ?? rowOrder.length) -
        (rowPos.get(b.rowKey) ?? rowOrder.length) ||
      a.index - b.index ||
      a.subIndex - b.subIndex ||
      a.label.localeCompare(b.label),
  );
  const seen = new Set<string>();
  const out: LegendItemSpec[] = [];
  for (const it of sorted) {
    const key = it.id ?? it.label;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/**
 * Resolve a layer's `legend` prop + identity into what it registers:
 * `false` ⇒ `null` (opt out — no row); a string ⇒ that display name; omitted /
 * `true` ⇒ the layer's own readout identity. Kept as a helper so every mark
 * resolves the prop identically.
 */
export function legendLabelFor(
  legend: boolean | string | undefined,
  identity: string,
): string | null {
  if (legend === false) return null;
  return typeof legend === 'string' && legend.length > 0 ? legend : identity;
}

/**
 * Register this layer instance's legend row(s) — one for the single-row marks,
 * one per column for a stacked bar — keyed off the layer's per-instance
 * `slot` (row *i* registers under a derived per-index key, so the layer's rows
 * live and die together); unregister all on unmount. Pass `rows: null` (or
 * `[]`) to register nothing (the layer opted out via `legend={false}`).
 * `rows` must be **memoised by the caller** (like `useRegisterAnnotation`'s
 * `xs`) so the effect re-runs only when a swatch / label genuinely changes,
 * not every render. Reads the enclosing chart row's key itself — a layer
 * outside a `<ChartRow>` (impossible today) simply doesn't register.
 */
export function useLegendItems(
  container: ContainerFrame,
  slot: symbol,
  index: number,
  rows: readonly LegendRowInput[] | null,
): void {
  const rowFrame = useContext(RowContext);
  const rowKey = rowFrame?.rowKey;
  const { registerLegendItem, unregisterLegendItem } = container;
  // Stable per-subIndex child keys, grown lazily; `slot` itself keys row 0 so
  // the common single-row mark registers exactly one symbol.
  const childKeys = useRef<symbol[]>([slot]);
  useEffect(() => {
    const keys = childKeys.current;
    return () => keys.forEach((k) => unregisterLegendItem(k));
  }, [unregisterLegendItem]);
  useEffect(() => {
    const keys = childKeys.current;
    const want = rowKey === undefined ? [] : (rows ?? []);
    while (keys.length < want.length) {
      keys.push(Symbol(`legend-${keys.length}`));
    }
    want.forEach((row, i) =>
      registerLegendItem(keys[i]!, {
        ...row,
        rowKey: rowKey!,
        index,
        subIndex: i,
      }),
    );
    // Drop rows beyond the current count (a stack that lost a column).
    for (let i = want.length; i < keys.length; i += 1) {
      unregisterLegendItem(keys[i]!);
    }
  }, [registerLegendItem, unregisterLegendItem, slot, rows, rowKey, index]);
}
