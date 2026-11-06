import type { ColumnarStore, ColumnSchema } from '../../columnar/index.js';

/**
 * **Column-native `dedupe`** ([PND-DEDUPEMAP]) for the built-in `keep`
 * policies. Returns the kept row numbers in row order; the caller gathers
 * the columns by them.
 *
 * The old walk built a string per row (`${begin}`, `${begin}:${end}`, or
 * `${begin}:${end}:${String(label)}`), grouped rows by it in a `Map`, and
 * resolved each group in first-appearance order. Rows are sorted by key, so
 * rows with the same `begin` / `end` are next to each other and the groups
 * are runs; this walks the runs instead. Two strings equal exactly when the
 * numbers are equal under `===` (`String(-0)` is `'0'`, and `-0 === 0`).
 *
 * **Interval labels** are the one case where a group need not be a run:
 * inside one span, labels sort with `compareIntervalValues`, which calls two
 * different strings equal when `localeCompare` does (a precomposed and a
 * decomposed `é`), so the same label can come back after a different one.
 * A span holding more than one row is therefore grouped by `String(label)`
 * with a small `Map`, in first-appearance order, as before.
 *
 * Each group is resolved with the old branch order, so an invalid `keep`
 * still throws only once a duplicate is found, with the same error.
 */
export function dedupeRows(
  store: ColumnarStore<ColumnSchema>,
  keep: unknown,
): Int32Array {
  const keys = store.keys;
  const n = keys.length;
  const begin = keys.begin;
  const end = keys.end;
  const kind = keys.kind;
  const out = new Int32Array(n);
  let len = 0;

  const labels =
    kind === 'interval'
      ? (keys as unknown as { labels: { read(i: number): unknown } }).labels
      : undefined;

  const resolve = (group: ArrayLike<number>, keyStr: () => string): void => {
    if (group.length === 1) {
      out[len++] = group[0]!;
      return;
    }
    if (keep === 'first') {
      out[len++] = group[0]!;
      return;
    }
    if (keep === 'last') {
      out[len++] = group[group.length - 1]!;
      return;
    }
    if (keep === 'error') {
      const t = begin[group[0]!]!;
      const detail =
        kind === 'time'
          ? `${new Date(t).toISOString()} (${t})`
          : `key "${keyStr()}"`;
      throw new Error(
        `dedupe: ${group.length} events at ${detail}. ` +
          `Specify a different 'keep' policy or fix upstream.`,
      );
    }
    if (keep === 'drop') return;
    const k = keep as { min?: string; max?: string };
    if ('min' in k || 'max' in k) {
      const isMin = 'min' in k;
      const name = (isMin ? k.min : k.max) as string;
      const col = store.columns.get(name);
      let best = group[0]!;
      let bestVal = col?.read(best) as number | undefined;
      for (let g = 1; g < group.length; g += 1) {
        const candidate = group[g]!;
        const v = col?.read(candidate) as number | undefined;
        if (v === undefined) continue;
        if (bestVal === undefined || (isMin ? v < bestVal : v > bestVal)) {
          best = candidate;
          bestVal = v;
        }
      }
      out[len++] = best;
      return;
    }
    throw new TypeError(
      `dedupe: invalid keep option ${JSON.stringify(keep)}. ` +
        `Expected 'first' | 'last' | 'error' | 'drop' | { min: col } | { max: col } | (events) => Event.`,
    );
  };

  let rowIds: Int32Array | undefined;
  let i = 0;
  while (i < n) {
    const b = begin[i]!;
    const e = end[i]!;
    let j = i + 1;
    while (j < n && begin[j] === b && end[j] === e) j += 1;
    if (j - i === 1) {
      out[len++] = i;
    } else if (labels === undefined) {
      if (rowIds === undefined) {
        rowIds = new Int32Array(n);
        for (let r = 0; r < n; r += 1) rowIds[r] = r;
      }
      resolve(rowIds.subarray(i, j), () =>
        kind === 'time' ? `${b}` : `${b}:${e}`,
      );
    } else {
      const groups = new Map<string, number[]>();
      for (let r = i; r < j; r += 1) {
        const label = String(labels.read(r));
        let group = groups.get(label);
        if (group === undefined) {
          group = [];
          groups.set(label, group);
        }
        group.push(r);
      }
      for (const [label, group] of groups) {
        resolve(group, () => `${b}:${e}:${label}`);
      }
    }
    i = j;
  }
  return out.subarray(0, len);
}
