import {
  type Column,
  ColumnarStore,
  type ColumnSchema,
  Float64Column,
  IntervalKeyColumn,
  type KeyColumn,
  type StringColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  concatValueColumn,
  stringColumnFromArray,
} from '../../columnar/index.js';
import { columnFromValuesByKind } from './column-builders.js';

/**
 * **Column-native `TimeSeries.concat`** ([PND-CONCATSORT]). The old path
 * put every input's `Event`s in one array, sorted it with
 * `compareEventKeys`, and rebuilt the store from the events. Every input is
 * already sorted by that order, so a stable sort of their concatenation is
 * a **k-way merge** in which a tie goes to the earlier input (and, inside
 * one input, to the earlier row). This finds that merge on the key buffers
 * and gathers every column by it.
 *
 * `compareEventKeys` compares `begin`, then `end`, then the key kind's name
 * (the same for every input, since the schemas match). It never looks at
 * an interval's label, so neither does the merge.
 *
 * O(N log K) for N rows over K inputs, every step on typed buffers.
 *
 * Returns, per output row, the input and the row it came from, plus the
 * merged store; `undefined` when the inputs hold no rows, or when interval
 * inputs carry different label kinds (the caller then takes the old path).
 */
export function mergeSortedStores(
  stores: ReadonlyArray<ColumnarStore<ColumnSchema>>,
  outSchema: ColumnSchema,
):
  | { store: ColumnarStore<ColumnSchema>; source: Int32Array; row: Int32Array }
  | undefined {
  const k = stores.length;
  let total = 0;
  for (let s = 0; s < k; s += 1) total += stores[s]!.length;
  if (total === 0) return undefined;
  const keyKind = stores[0]!.keys.kind;
  let labelKind: string | undefined;
  if (keyKind === 'interval') {
    for (let s = 0; s < k; s += 1) {
      const lk = (stores[s]!.keys as IntervalKeyColumn).labelKind;
      if (labelKind === undefined) labelKind = lk;
      else if (lk !== labelKind) return undefined;
    }
  }

  // Every input's keys end to end, with each row's position in that
  // layout (`flat`) — the row number the column gathers use.
  const offsets = new Int32Array(k + 1);
  for (let s = 0; s < k; s += 1)
    offsets[s + 1] = offsets[s]! + stores[s]!.length;
  let beginBuf = new Float64Array(total);
  let endBuf = new Float64Array(total);
  let flat = new Int32Array(total);
  for (let s = 0; s < k; s += 1) {
    const keys = stores[s]!.keys;
    const n = stores[s]!.length;
    const o = offsets[s]!;
    const kb = keys.begin;
    const ke = keys.end;
    // A plain loop: `set(subarray(...))` allocates two views per input,
    // which dominates when there are many small inputs.
    for (let r = 0; r < n; r += 1) {
      beginBuf[o + r] = kb[r]!;
      endBuf[o + r] = ke[r]!;
      flat[o + r] = o + r;
    }
  }

  // Bottom-up merge of the inputs as sorted runs, two neighbours at a time.
  // On a tie the left run wins, and the left run always holds the earlier
  // inputs, so the merge is the stable sort. A pair already in order is
  // copied as is. Run boundaries: the start of each non-empty input, then the end.
  // An input that starts at or after the previous row continues the run
  // before it, so inputs already end to end form one run (no merge pass).
  let runs: number[] = [];
  for (let s = 0; s < k; s += 1) {
    if (stores[s]!.length === 0) continue;
    const at = offsets[s]!;
    if (
      runs.length === 0 ||
      beginBuf[at]! < beginBuf[at - 1]! ||
      (beginBuf[at] === beginBuf[at - 1] && endBuf[at]! < endBuf[at - 1]!)
    ) {
      runs.push(at);
    }
  }
  runs.push(total);
  let nextBegin = new Float64Array(total);
  let nextEnd = new Float64Array(total);
  let nextFlat = new Int32Array(total);
  while (runs.length > 2) {
    const merged: number[] = [];
    const last = runs.length - 1; // runs[last] is the end
    for (let p = 0; p < last; p += 2) {
      const lo = runs[p]!;
      const mid = runs[p + 1]!;
      // An odd run out at the end has no partner: `hi === mid`.
      const hi = p + 2 <= last ? runs[p + 2]! : mid;
      merged.push(lo);
      if (
        hi === mid ||
        // Already in order: the right run's first row is not before the
        // left run's last row.
        !(
          beginBuf[mid]! < beginBuf[mid - 1]! ||
          (beginBuf[mid] === beginBuf[mid - 1] &&
            endBuf[mid]! < endBuf[mid - 1]!)
        )
      ) {
        nextBegin.set(beginBuf.subarray(lo, hi), lo);
        nextEnd.set(endBuf.subarray(lo, hi), lo);
        nextFlat.set(flat.subarray(lo, hi), lo);
      } else {
        let i = lo;
        let j = mid;
        let o = lo;
        while (i < mid && j < hi) {
          const bi = beginBuf[i]!;
          const bj = beginBuf[j]!;
          // Take the right row only when it is strictly before the left.
          const right = bj < bi || (bj === bi && endBuf[j]! < endBuf[i]!);
          const from = right ? j++ : i++;
          nextBegin[o] = beginBuf[from]!;
          nextEnd[o] = endBuf[from]!;
          nextFlat[o] = flat[from]!;
          o += 1;
        }
        for (; i < mid; i += 1, o += 1) {
          nextBegin[o] = beginBuf[i]!;
          nextEnd[o] = endBuf[i]!;
          nextFlat[o] = flat[i]!;
        }
        for (; j < hi; j += 1, o += 1) {
          nextBegin[o] = beginBuf[j]!;
          nextEnd[o] = endBuf[j]!;
          nextFlat[o] = flat[j]!;
        }
      }
    }
    merged.push(total);
    runs = merged;
    [beginBuf, nextBegin] = [nextBegin, beginBuf];
    [endBuf, nextEnd] = [nextEnd, endBuf];
    [flat, nextFlat] = [nextFlat, flat];
  }

  // Input and row of each output row, for the labels and event identity.
  const sourceOfFlat = new Int32Array(total);
  for (let s = 0; s < k; s += 1) {
    sourceOfFlat.fill(s, offsets[s]!, offsets[s + 1]!);
  }
  const source = new Int32Array(total);
  const row = new Int32Array(total);
  for (let o = 0; o < total; o += 1) {
    const s = sourceOfFlat[flat[o]!]!;
    source[o] = s;
    row[o] = flat[o]! - offsets[s]!;
  }

  const keys = mergedKeys(
    stores,
    keyKind,
    labelKind,
    source,
    row,
    beginBuf,
    endBuf,
  );
  const columns = new Map<string, Column>();
  for (let c = 1; c < outSchema.length; c += 1) {
    const def = outSchema[c]!;
    columns.set(
      def.name,
      // A chunked view finds a row's chunk by binary search, and building
      // it costs per input; with many small inputs, read cell by cell.
      k <= 64
        ? concatValueColumn(stores, def.name, def.kind).sliceByIndices(flat)
        : gatherCells(stores, def.name, def.kind, source, row),
    );
  }
  return {
    store: ColumnarStore.fromTrustedStore(outSchema, keys, columns),
    source,
    row,
  };
}

/** One column gathered from many inputs by reading each cell. */
function gatherCells(
  stores: ReadonlyArray<ColumnarStore<ColumnSchema>>,
  name: string,
  kind: string,
  source: Int32Array,
  row: Int32Array,
): Column {
  const cols = stores.map((st) => st.columns.get(name)!);
  const total = source.length;
  if (kind === 'number') {
    const out = new Float64Array(total);
    let allFinite = true;
    for (let o = 0; o < total; o += 1) {
      const v = cols[source[o]!]!.read(row[o]!) as number | undefined;
      if (v === undefined) {
        out[o] = NaN;
        allFinite = false;
      } else {
        out[o] = v;
      }
    }
    return new Float64Column(out, total, allFinite);
  }
  const values = new Array<unknown>(total);
  for (let o = 0; o < total; o += 1) {
    values[o] = cols[source[o]!]!.read(row[o]!);
  }
  return columnFromValuesByKind(kind, values);
}

function mergedKeys(
  stores: ReadonlyArray<ColumnarStore<ColumnSchema>>,
  keyKind: string,
  labelKind: string | undefined,
  source: Int32Array,
  row: Int32Array,
  begin: Float64Array,
  end: Float64Array,
): KeyColumn {
  const total = source.length;
  if (keyKind === 'time') return new TimeKeyColumn(begin, total);
  if (keyKind === 'timeRange') return new TimeRangeKeyColumn(begin, end, total);
  const labelCols = stores.map((st) => (st.keys as IntervalKeyColumn).labels);
  let labels: StringColumn | Float64Column;
  if (labelKind === 'string') {
    const gathered = new Array<string | undefined>(total);
    for (let o = 0; o < total; o += 1) {
      gathered[o] = (labelCols[source[o]!] as StringColumn).read(row[o]!);
    }
    labels = stringColumnFromArray(gathered);
  } else {
    const flat = new Float64Array(total);
    for (let o = 0; o < total; o += 1) {
      flat[o] = (labelCols[source[o]!] as Float64Column).read(
        row[o]!,
      ) as number;
    }
    labels = new Float64Column(flat, total);
  }
  return new IntervalKeyColumn(begin, end, labels, total);
}
