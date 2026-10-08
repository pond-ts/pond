import {
  type Column,
  type ColumnSchema,
  type IntervalLabelKind,
  type KeyColumn,
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
  type StringColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  ValueKeyColumn,
  stringColumnFromArray,
} from '../../columnar/index.js';
import { compareIntervalValues } from '../../core/temporal.js';
import type { JoinType } from '../../schema/index.js';

/**
 * **Column-native exact-key `join`** ([PND-JOINCOL]). Merge-walks the two
 * key columns once into a pair of row-match indices — output row `r` takes
 * left row `leftIdx[r]` and right row `rightIdx[r]`, with `-1` meaning "no
 * row on that side" — then builds every output column from those indices:
 *
 * - **Pass-through.** When one side's index is the identity (each of its
 *   rows appears once, in order, with nothing interleaved), that side's
 *   value columns are adopted by reference, and so is its key column. This
 *   is always true of the primary in a `left` join and of the other side in
 *   a `right` join, and it is true of **both** sides when the two keys match
 *   one for one — the `joinMany` over a shared grid case.
 * - **Gather.** Otherwise each column is one `sliceByIndices` over the match
 *   index; a `-1` slot comes out missing through the column's validity, the
 *   substrate's existing out-of-range gather contract.
 *
 * No `Event` is materialised on either side or in the output.
 *
 * **Semantics are the event walk's, exactly.** The key comparison is
 * `compareEventKeys` / `Interval.compare` restated over the buffers —
 * `begin`, then `end`, then (interval keys only) `compareIntervalValues` on
 * the labels — and the walk pairs equal keys **one to one** in order: a key
 * that repeats `a` times on the left and `b` times on the right yields
 * `min(a, b)` matched rows plus `|a − b|` one-sided rows, not `a·b`. A matched
 * row carries the **left** key.
 *
 * Complexity: O(N + M) for the walk, plus O(R) per gathered column (R output
 * rows). Pass-through columns cost nothing.
 *
 * The caller has already checked that the key kinds agree and that no value
 * column name appears on both sides; `outSchema` is the left key column
 * followed by the left then the right value columns.
 */
export function joinOp(
  left: ColumnarStore<ColumnSchema>,
  right: ColumnarStore<ColumnSchema>,
  joinType: JoinType,
  outSchema: ColumnSchema,
): ColumnarStore<ColumnSchema> {
  const lk = left.keys;
  const rk = right.keys;
  const n = lk.length;
  const m = rk.length;
  const keepLeft = joinType === 'left' || joinType === 'outer';
  const keepRight = joinType === 'right' || joinType === 'outer';

  // Exact for left / right (every row of the kept side is emitted once), an
  // upper bound for inner / outer.
  const capacity =
    joinType === 'left'
      ? n
      : joinType === 'right'
        ? m
        : joinType === 'inner'
          ? Math.min(n, m)
          : n + m;
  const leftIdx = new Int32Array(capacity);
  const rightIdx = new Int32Array(capacity);
  const compare = keyComparator(lk, rk);

  let i = 0;
  let j = 0;
  let len = 0;
  let leftOnly = 0;
  let rightOnly = 0;
  while (i < n && j < m) {
    const c = compare(i, j);
    if (c === 0) {
      leftIdx[len] = i;
      rightIdx[len] = j;
      len += 1;
      i += 1;
      j += 1;
    } else if (c < 0) {
      if (keepLeft) {
        leftIdx[len] = i;
        rightIdx[len] = -1;
        len += 1;
        leftOnly += 1;
      }
      i += 1;
    } else {
      if (keepRight) {
        leftIdx[len] = -1;
        rightIdx[len] = j;
        len += 1;
        rightOnly += 1;
      }
      j += 1;
    }
  }
  if (keepLeft) {
    for (; i < n; i += 1) {
      leftIdx[len] = i;
      rightIdx[len] = -1;
      len += 1;
      leftOnly += 1;
    }
  }
  if (keepRight) {
    for (; j < m; j += 1) {
      leftIdx[len] = -1;
      rightIdx[len] = j;
      len += 1;
      rightOnly += 1;
    }
  }

  // A side's index is the identity iff all its rows were emitted and the
  // other side contributed no one-sided rows between them (rows of one side
  // are always emitted in ascending order).
  const leftIdentity = len === n && rightOnly === 0;
  const rightIdentity = len === m && leftOnly === 0;
  const li = leftIdx.subarray(0, len);
  const ri = rightIdx.subarray(0, len);

  // A matched row carries the left key. The right key column can stand in
  // for it only where equal keys are identical, which holds for timestamps
  // but not for interval labels (`compareIntervalValues` uses
  // `localeCompare`, under which distinct strings can compare equal).
  let keys: KeyColumn;
  if (leftIdentity) keys = lk;
  else if (rightIdentity && rk.kind !== 'interval') keys = rk;
  else keys = gatherKeys(lk, rk, li, ri);

  const columns = new Map<string, Column>();
  for (let c = 1; c < left.schema.length; c += 1) {
    const name = left.schema[c]!.name;
    const col = left.columns.get(name)!;
    columns.set(name, leftIdentity ? col : col.sliceByIndices(li));
  }
  for (let c = 1; c < right.schema.length; c += 1) {
    const name = right.schema[c]!.name;
    const col = right.columns.get(name)!;
    columns.set(name, rightIdentity ? col : col.sliceByIndices(ri));
  }

  return ColumnarStore.fromTrustedStore(outSchema, keys, columns);
}

/**
 * The event walk's key order (`compareEventKeys`, plus `Interval.compare`'s
 * label tiebreak) over the raw key buffers. Both columns are the same kind.
 */
function keyComparator(
  lk: KeyColumn,
  rk: KeyColumn,
): (i: number, j: number) => number {
  const lb = lk.begin;
  const rb = rk.begin;
  if (lk.kind === 'time' || lk.kind === 'value') {
    return (i, j) => lb[i]! - rb[j]!;
  }
  const le = lk.end;
  const re = rk.end;
  if (lk.kind === 'timeRange') {
    return (i, j) => {
      const d = lb[i]! - rb[j]!;
      return d !== 0 ? d : le[i]! - re[j]!;
    };
  }
  const ll = lk.labels;
  const rl = (rk as IntervalKeyColumn).labels;
  return (i, j) => {
    const d = lb[i]! - rb[j]!;
    if (d !== 0) return d;
    const e = le[i]! - re[j]!;
    if (e !== 0) return e;
    return compareIntervalValues(ll.read(i)!, rl.read(j)!);
  };
}

/**
 * Builds the output key column row by row from whichever side has the row,
 * preferring the left. Every `(begin, end, label)` triple is copied whole
 * from one already-validated source row, so the per-row invariants (finite,
 * `begin <= end`, defined label) hold by construction and the trusted
 * factories skip re-checking them.
 */
function gatherKeys(
  lk: KeyColumn,
  rk: KeyColumn,
  li: Int32Array,
  ri: Int32Array,
): KeyColumn {
  const len = li.length;
  const lb = lk.begin;
  const rb = rk.begin;
  const begin = new Float64Array(len);
  if (lk.kind === 'time' || lk.kind === 'value') {
    for (let r = 0; r < len; r += 1) {
      const a = li[r]!;
      begin[r] = a >= 0 ? lb[a]! : rb[ri[r]!]!;
    }
    return lk.kind === 'time'
      ? TimeKeyColumn.fromValidatedSubarray(begin, len)
      : new ValueKeyColumn(begin, len);
  }
  const le = lk.end;
  const re = rk.end;
  const end = new Float64Array(len);
  for (let r = 0; r < len; r += 1) {
    const a = li[r]!;
    if (a >= 0) {
      begin[r] = lb[a]!;
      end[r] = le[a]!;
    } else {
      const b = ri[r]!;
      begin[r] = rb[b]!;
      end[r] = re[b]!;
    }
  }
  if (lk.kind === 'timeRange') {
    return TimeRangeKeyColumn.fromValidatedSubarray(begin, end, len);
  }
  const { labels, labelKind } = gatherLabels(
    lk,
    rk as IntervalKeyColumn,
    li,
    ri,
  );
  return IntervalKeyColumn.fromValidatedSubarray(
    begin,
    end,
    labels,
    labelKind,
    len,
  );
}

function gatherLabels(
  lk: IntervalKeyColumn,
  rk: IntervalKeyColumn,
  li: Int32Array,
  ri: Int32Array,
): { labels: StringColumn | Float64Column; labelKind: IntervalLabelKind } {
  const len = li.length;
  let fromLeft = 0;
  for (let r = 0; r < len; r += 1) if (li[r]! >= 0) fromLeft += 1;
  if (fromLeft === len) {
    return {
      labels: lk.labels.sliceByIndices(li) as StringColumn | Float64Column,
      labelKind: lk.labelKind,
    };
  }
  if (fromLeft === 0) {
    return {
      labels: rk.labels.sliceByIndices(ri) as StringColumn | Float64Column,
      labelKind: rk.labelKind,
    };
  }
  // Mixed-type labels never match (`compareIntervalValues` orders numbers
  // before strings), so this is an outer join keeping one-sided rows from
  // both. The event path rejected the same output when re-columnarising it.
  if (lk.labelKind !== rk.labelKind) {
    throw new RangeError(
      `join: cannot combine interval keys with ${lk.labelKind} labels and interval keys with ${rk.labelKind} labels — an interval-keyed series must use one label type throughout`,
    );
  }
  if (lk.labelKind === 'number') {
    const lv = (lk.labels as Float64Column)._values;
    const rv = (rk.labels as Float64Column)._values;
    const out = new Float64Array(len);
    for (let r = 0; r < len; r += 1) {
      const a = li[r]!;
      out[r] = a >= 0 ? lv[a]! : rv[ri[r]!]!;
    }
    // Numeric interval labels are validated finite at construction.
    return {
      labels: new Float64Column(out, len, undefined, true),
      labelKind: lk.labelKind,
    };
  }
  const ll = lk.labels;
  const rl = rk.labels;
  const out = new Array<string>(len);
  for (let r = 0; r < len; r += 1) {
    const a = li[r]!;
    out[r] = (a >= 0 ? ll.read(a) : rl.read(ri[r]!)) as string;
  }
  return {
    labels: stringColumnFromArray(out, { forceDict: true }),
    labelKind: lk.labelKind,
  };
}
