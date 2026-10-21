import type { ReducerDef, RollingReducerState } from './types.js';
import { rollingSortedArray } from './rolling.js';

export const difference: ReducerDef = {
  outputKind: 'number',
  reduce(_d, numeric) {
    if (numeric.length === 0) return undefined;
    let lo = numeric[0]!;
    let hi = numeric[0]!;
    for (let i = 1; i < numeric.length; i++) {
      const v = numeric[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  },
  bucketState() {
    let lo: number | undefined;
    let hi: number | undefined;
    return {
      add(v) {
        if (typeof v !== 'number') return;
        if (lo === undefined || v < lo) lo = v;
        if (hi === undefined || v > hi) hi = v;
      },
      snapshot() {
        return lo !== undefined && hi !== undefined ? hi - lo : undefined;
      },
    };
  },
  rollingState() {
    return rollingDifferenceDeques();
  },
};

// Drop the used front of a deque once it is this long and at least half the
// array: rarely enough that the copy is cheap per row, even on tiny windows.
const COMPACT_AT = 1024;

/**
 * [PND-ROLLDIFF] Rolling `difference` (largest minus smallest in the window)
 * from two monotone deques (the method `min` and `max` use), so a row costs
 * the same whatever the window size. Like theirs, it assumes rows leave the
 * window in the order they entered; {@link rollingDifferenceSorted} covers
 * the sources where they don't (`rollingStateFor`'s `'sorted'` order).
 *
 * **Zero signs.** The sorted-array version this replaced answered `-0`, not
 * `0`, for one kind of window: every value a zero, with the zero it kept last
 * being a `-0` and the one it kept first a `+0`. Its zeros entered and left
 * at the front of their run, i.e. last in, first out, so the stack below
 * replays exactly that, and the answers stay identical bit for bit.
 */
export function rollingDifferenceDeques(): RollingReducerState {
  // The two deques as parallel arrays of row index and value, read from
  // `head`: plain numbers, so a row allocates nothing (an entry object per
  // row made small windows slower than the sorted array they replace).
  const loIdx: number[] = [];
  const loVal: number[] = [];
  let loHead = 0;
  const hiIdx: number[] = [];
  const hiVal: number[] = [];
  let hiHead = 0;
  // `true` = the zero was `-0`. Only read when the window is all zeros.
  const zeroSigns: boolean[] = [];
  return {
    add(index, value) {
      if (typeof value !== 'number') return;
      // Smallest: drop larger values behind; they can never be the answer.
      while (loIdx.length > loHead && loVal[loVal.length - 1]! > value) {
        loIdx.pop();
        loVal.pop();
      }
      loIdx.push(index);
      loVal.push(value);
      while (hiIdx.length > hiHead && hiVal[hiVal.length - 1]! < value) {
        hiIdx.pop();
        hiVal.pop();
      }
      hiIdx.push(index);
      hiVal.push(value);
      if (value === 0) zeroSigns.push(Object.is(value, -0));
    },
    remove(index, value) {
      if (typeof value !== 'number') return;
      if (loHead < loIdx.length && loIdx[loHead] === index) {
        loHead += 1;
        if (loHead === loIdx.length) {
          loIdx.length = 0;
          loVal.length = 0;
          loHead = 0;
        } else if (loHead >= COMPACT_AT && loHead * 2 >= loIdx.length) {
          loIdx.splice(0, loHead);
          loVal.splice(0, loHead);
          loHead = 0;
        }
      }
      if (hiHead < hiIdx.length && hiIdx[hiHead] === index) {
        hiHead += 1;
        if (hiHead === hiIdx.length) {
          hiIdx.length = 0;
          hiVal.length = 0;
          hiHead = 0;
        } else if (hiHead >= COMPACT_AT && hiHead * 2 >= hiIdx.length) {
          hiIdx.splice(0, hiHead);
          hiVal.splice(0, hiHead);
          hiHead = 0;
        }
      }
      if (value === 0) zeroSigns.pop();
    },
    snapshot() {
      if (loHead >= loIdx.length) return undefined;
      const top = hiVal[hiHead]!;
      const bottom = loVal[loHead]!;
      if (top === 0 && bottom === 0) {
        // All zeros: the old sorted array's last zero minus its first.
        const last = zeroSigns[0] ? -0 : 0;
        const first = zeroSigns[zeroSigns.length - 1] ? -0 : 0;
        return last - first;
      }
      return top - bottom;
    },
  };
}

/**
 * Rolling `difference` over a sorted array: values leave by value, so it is
 * exact whatever order they leave in, at O(window) per row (a `splice`).
 * Selected only for sources whose eviction order is not arrival order
 * (`reorder` + retention), as `min` / `max` swap to `rollingSortedExtreme`.
 */
export function rollingDifferenceSorted(): RollingReducerState {
  const arr = rollingSortedArray();
  return {
    add: arr.add,
    remove: arr.remove,
    snapshot() {
      return arr.sorted.length === 0
        ? undefined
        : arr.sorted[arr.sorted.length - 1]! - arr.sorted[0]!;
    },
  };
}
