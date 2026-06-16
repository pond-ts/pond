import type { ColumnSchema, ColumnarStore } from '../columnar/index.js';
import type { RollingReducerState } from '../reducers/types.js';
import { rollingStateFor } from '../reducers/index.js';
import type { ColumnValue } from '../schema/index.js';
import type { AggregateColumnSpec } from './aggregate-columns.js';

/**
 * Window spec for {@link TimeSeries.rollingByColumn}: a **centered** window of
 * half-width `radius`, in the axis column's own units. The window for a row is
 * every row whose axis value lies within `±radius` of it. See
 * `docs/notes/rolling-by-column.md`.
 */
export type WindowSpec = { radius: number };

/** One windowed record: the mapped aggregates over the window centered at a row. */
export type WindowRecord = Record<string, ColumnValue | undefined>;

/**
 * Windowed value-axis aggregation runtime — the sliding-window sibling of
 * {@link computeByColumn}. For each row, reduces (via `columnSpecs`) the rows
 * whose `axisColName` value lies within `±spec.radius` of that row's value,
 * returning one {@link WindowRecord} per row, **positionally aligned with the
 * store** (`out[i]` is the window centered at row `i`).
 *
 * The axis column must be **non-decreasing** — that ordering is what makes a
 * sliding window meaningful (vs `byColumn`'s order-free group-by) and is what
 * lets the window advance as a single O(n) two-pointer rather than a per-row
 * range scan. A row whose axis value is missing / non-finite can't be placed in
 * the ordering: it is excluded from every window, and its own output slot gets
 * each reducer's empty snapshot (so the result stays positionally aligned). The
 * reducer non-finite policy still applies to the *source* columns.
 *
 * Reads straight off the columnar store (`Column.read(i)`, no event
 * materialization). Uses `rollingStateFor` (add/remove/snapshot) rather than the
 * append-only `bucketStateFor`, because the window is a moving multiset; the two
 * pointers `add` rows entering the right edge and `remove` rows leaving the left.
 */
export function computeRollingByColumn(
  store: ColumnarStore<ColumnSchema>,
  axisColName: string,
  spec: WindowSpec,
  columnSpecs: ReadonlyArray<AggregateColumnSpec>,
): WindowRecord[] {
  const axisCol = store.columns.get(axisColName);
  if (axisCol === undefined) {
    throw new RangeError(`rollingByColumn: unknown column '${axisColName}'`);
  }
  if (axisCol.kind !== 'number') {
    throw new TypeError(
      `rollingByColumn: column '${axisColName}' must be a number column (got '${axisCol.kind}')`,
    );
  }
  const { radius } = spec;
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new RangeError(
      'rollingByColumn: radius must be a positive finite number',
    );
  }

  const sourceCols = columnSpecs.map((s) => store.columns.get(s.source)!);
  const n = store.length;

  // Compact the finite-axis rows in row order: `ax[k]` is the axis value, `idx[k]`
  // the real row index. Validate non-decreasing — a sliding window over an
  // unsorted axis is meaningless, and a descending step would break the
  // monotonic two-pointer below (it only ever moves `lo`/`hi` to the right).
  const ax = new Float64Array(n);
  const idx = new Int32Array(n);
  let m = 0;
  for (let i = 0; i < n; i += 1) {
    const av = axisCol.read(i);
    if (typeof av !== 'number' || !Number.isFinite(av)) continue;
    if (m > 0 && av < ax[m - 1]!) {
      throw new RangeError(
        `rollingByColumn: axis column '${axisColName}' must be non-decreasing; row ${i} (${av}) < previous (${ax[m - 1]})`,
      );
    }
    ax[m] = av;
    idx[m] = i;
    m += 1;
  }

  // One shared rolling state per output column, maintained incrementally across
  // the whole sweep — this is what makes it O(n) rather than O(n · window).
  const states: RollingReducerState[] = columnSpecs.map((s) =>
    rollingStateFor(s.reducer),
  );
  const specCount = columnSpecs.length;
  const out: WindowRecord[] = new Array(n);

  let lo = 0;
  let hi = 0; // the window currently holds compact positions [lo, hi)
  for (let i = 0; i < n; i += 1) {
    const av = axisCol.read(i);
    if (typeof av !== 'number' || !Number.isFinite(av)) {
      // No axis position → empty window. A FRESH empty snapshot per row (per
      // spec), not a shared/cached value: an array-kind reducer would otherwise
      // alias one `[]` across rows. Matches byColumn's empty-bin handling.
      const rec: WindowRecord = {};
      for (let c = 0; c < specCount; c += 1) {
        rec[columnSpecs[c]!.output] = rollingStateFor(
          columnSpecs[c]!.reducer,
        ).snapshot();
      }
      out[i] = rec;
      continue;
    }
    const wlo = av - radius;
    const whi = av + radius;
    // Expand the right edge: add finite-axis rows with `ax ≤ center + radius`.
    while (hi < m && ax[hi]! <= whi) {
      const r = idx[hi]!;
      for (let c = 0; c < specCount; c += 1) {
        states[c]!.add(r, sourceCols[c]!.read(r));
      }
      hi += 1;
    }
    // Contract the left edge: drop rows with `ax < center − radius`. The center
    // row itself satisfies `wlo ≤ av ≤ whi`, so `lo` never passes it (`lo < hi`
    // always holds here) and the window is non-empty.
    while (lo < hi && ax[lo]! < wlo) {
      const r = idx[lo]!;
      for (let c = 0; c < specCount; c += 1) {
        states[c]!.remove(r, sourceCols[c]!.read(r));
      }
      lo += 1;
    }
    const rec: WindowRecord = {};
    for (let c = 0; c < specCount; c += 1) {
      rec[columnSpecs[c]!.output] = states[c]!.snapshot();
    }
    out[i] = rec;
  }
  return out;
}
