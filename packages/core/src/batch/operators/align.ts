import {
  type Column,
  ColumnarStore,
  type ColumnSchema,
  Float64Column,
  type KeyColumn,
  TimeKeyColumn,
} from '../../columnar/index.js';

/**
 * **Column-native `align` / `materialize`** ([PND-ALIGNHOLD],
 * [PND-DEDUPEMAP]). Both used to build one `Event` (or one data object) per
 * grid bucket and then send the rows back through row intake. Here each
 * bucket picks a **source row number** (`-1` = no row), and every output
 * column is one `sliceByIndices` over those numbers; a `-1` slot comes out
 * missing. Linear alignment also records, per bucket, the second row and the
 * ratio, and number columns are interpolated straight from the columns.
 *
 * **The picks are the old event walk's, exactly.**
 *
 * - `hold` was `series.atOrBefore(new Time(t))`: a binary search for the
 *   first row whose key is not less than `Time(t)` under `compareEventKeys`,
 *   that row if its key equals `Time(t)`, else the row before. That order is
 *   restated over the key buffers (`begin`, then `end`, then the key kind's
 *   name against `'time'`), and only a time key can equal `Time(t)`. Sample
 *   times rise strictly (a `BoundedSequence` is sorted, non-overlapping,
 *   positive-length), so a forward cursor finds the same row as the binary
 *   search.
 * - `linear` keeps the old cursor (it only moves forward, past rows with
 *   `begin < t`) and its three cases: a row exactly at `t`; the row before
 *   when there is no row after or the two share a time; otherwise the
 *   interpolation `prev + (next − prev) · ratio` for number columns where
 *   both cells are present, the earlier cell for everything else.
 * - `materialize` keeps its cursor and its `first` / `last` / `nearest`
 *   scans over `begin`.
 *
 * Row intake stored a non-finite computed number as missing
 * ([PND-NANREP]); an interpolation that overflows is written as `NaN` here,
 * which reads back the same way.
 */

/** Per-bucket picks for `align`. `next[i] >= 0` marks an interpolated bucket. */
interface AlignPicks {
  readonly row: Int32Array;
  readonly next: Int32Array | undefined;
  readonly ratio: Float64Array | undefined;
}

function holdPicks(keys: KeyColumn, times: Float64Array): AlignPicks {
  const n = keys.length;
  const begin = keys.begin;
  const end = keys.end;
  const isTime = keys.kind === 'time';
  // `compareEventKeys` breaks a begin/end tie on `type().localeCompare`.
  const kindBeforeTime = keys.kind.localeCompare('time') < 0;
  const row = new Int32Array(times.length);
  let idx = 0;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i]!;
    // Advance past rows whose key compares below `Time(t)`.
    while (idx < n) {
      const b = begin[idx]!;
      if (b < t) {
        idx += 1;
        continue;
      }
      if (b === t) {
        const e = end[idx]!;
        if (e < t || (e === t && kindBeforeTime)) {
          idx += 1;
          continue;
        }
      }
      break;
    }
    row[i] = isTime && idx < n && begin[idx] === t ? idx : idx - 1;
  }
  return { row, next: undefined, ratio: undefined };
}

function linearPicks(keys: KeyColumn, times: Float64Array): AlignPicks {
  const n = keys.length;
  const begin = keys.begin;
  const len = times.length;
  const row = new Int32Array(len);
  let next: Int32Array | undefined;
  let ratio: Float64Array | undefined;
  let idx = 0;
  for (let i = 0; i < len; i += 1) {
    const t = times[i]!;
    while (idx < n && begin[idx]! < t) idx += 1;
    if (idx < n && begin[idx] === t) {
      row[i] = idx;
      continue;
    }
    if (idx === 0) {
      row[i] = -1;
      continue;
    }
    const prev = idx - 1;
    row[i] = prev;
    if (idx >= n || begin[prev] === begin[idx]) continue;
    if (next === undefined) {
      next = new Int32Array(len).fill(-1);
      ratio = new Float64Array(len);
    }
    next[i] = idx;
    ratio![i] = (t - begin[prev]!) / (begin[idx]! - begin[prev]!);
  }
  return { row, next, ratio };
}

/** A number column interpolated at the buckets `next` marks. */
function interpolatedColumn(col: Column, picks: AlignPicks): Float64Column {
  const { row, next, ratio } = picks;
  const len = row.length;
  const out = new Float64Array(len);
  let allFinite = true;
  for (let i = 0; i < len; i += 1) {
    const r = row[i]!;
    let v: number;
    if (r < 0) {
      v = NaN;
    } else {
      const pv = col.read(r) as number | undefined;
      const j = next![i]!;
      if (j >= 0 && pv !== undefined) {
        const nv = col.read(j) as number | undefined;
        v = nv === undefined ? pv : pv + (nv - pv) * ratio![i]!;
      } else {
        v = pv === undefined ? NaN : pv;
      }
    }
    if (v - v !== 0) {
      v = NaN;
      allFinite = false;
    }
    out[i] = v;
  }
  return new Float64Column(out, len, allFinite);
}

function gatherColumns(
  source: ColumnarStore<ColumnSchema>,
  outSchema: ColumnSchema,
  keys: KeyColumn,
  picks: AlignPicks,
): ColumnarStore<ColumnSchema> {
  const columns = new Map<string, Column>();
  for (let c = 1; c < outSchema.length; c += 1) {
    const spec = outSchema[c]!;
    const col = source.columns.get(spec.name)!;
    columns.set(
      spec.name,
      picks.next !== undefined && spec.kind === 'number'
        ? interpolatedColumn(col, picks)
        : col.sliceByIndices(picks.row),
    );
  }
  return ColumnarStore.fromTrustedStore(outSchema, keys, columns);
}

/**
 * `align` over a time / time-range / interval keyed store. `times` are the
 * buckets' sample points (strictly rising); `keys` the output interval keys.
 */
export function alignOp(
  source: ColumnarStore<ColumnSchema>,
  outSchema: ColumnSchema,
  outKeys: KeyColumn,
  times: Float64Array,
  method: 'hold' | 'linear',
): ColumnarStore<ColumnSchema> {
  const picks =
    method === 'linear'
      ? linearPicks(source.keys, times)
      : holdPicks(source.keys, times);
  return gatherColumns(source, outSchema, outKeys, picks);
}

/**
 * `materialize`: one time-keyed row per bucket at its sample point, values
 * from the bucket's `first` / `last` / `nearest` source row by `begin`.
 */
export function materializeOp(
  source: ColumnarStore<ColumnSchema>,
  outSchema: ColumnSchema,
  bucketBegin: Float64Array,
  bucketEnd: Float64Array,
  times: Float64Array,
  select: 'first' | 'last' | 'nearest',
): ColumnarStore<ColumnSchema> {
  const n = source.keys.length;
  const begin = source.keys.begin;
  const len = times.length;
  const row = new Int32Array(len);
  let cursor = 0;
  for (let i = 0; i < len; i += 1) {
    const bStart = bucketBegin[i]!;
    const bEnd = bucketEnd[i]!;
    while (cursor < n && begin[cursor]! < bStart) cursor += 1;
    let pick = -1;
    if (select === 'first') {
      if (cursor < n && begin[cursor]! < bEnd) pick = cursor;
    } else if (select === 'last') {
      let scan = cursor;
      while (scan < n && begin[scan]! < bEnd) {
        pick = scan;
        scan += 1;
      }
    } else {
      const sampleAt = times[i]!;
      let scan = cursor;
      let bestDist = Infinity;
      while (scan < n && begin[scan]! < bEnd) {
        const d = Math.abs(begin[scan]! - sampleAt);
        if (d < bestDist) {
          pick = scan;
          bestDist = d;
        }
        scan += 1;
      }
    }
    row[i] = pick;
  }
  return gatherColumns(source, outSchema, new TimeKeyColumn(times, len), {
    row,
    next: undefined,
    ratio: undefined,
  });
}
