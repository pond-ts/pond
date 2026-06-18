import { useRef } from 'react';

/**
 * A stable, unique key for **this component instance**, used to claim a slot in
 * a parent collection (the axis / layer registries in `ChartRow`).
 *
 * This is *instance identity*, deliberately **not** `useId` and **not** a
 * data-derived value:
 * - `useId` is for SSR-stable accessibility attributes; the React docs
 *   explicitly discourage it as a collection key.
 * - A React reconciliation `key` should come from your data — but that rule is
 *   about rendering *lists of data*. A registry of mounted *component instances*
 *   is a different thing: two `<LineChart>`s with identical props are still two
 *   distinct layers, and an axis's data `id` can legitimately repeat. The
 *   correct identity for "which mounted instance is this" is the instance
 *   itself, which a ref token captures (and which lets the registry update a
 *   slot in place rather than reorder — see `ChartRow`).
 *
 * The token is a `Symbol` created once per instance (lazily, no per-render
 * allocation) and never escapes into rendered output.
 */
export function useSlotKey(): symbol {
  const ref = useRef<symbol | null>(null);
  return (ref.current ??= Symbol('chart-slot'));
}
