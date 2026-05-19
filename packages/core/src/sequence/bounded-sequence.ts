import { Interval } from '../core/interval.js';
import { TimeRange } from '../core/time-range.js';

function validateIntervals(intervals: ReadonlyArray<Interval>): void {
  for (let index = 0; index < intervals.length; index += 1) {
    const current = intervals[index]!;

    if (current.end() <= current.begin()) {
      throw new TypeError(
        'bounded sequence intervals must have positive duration',
      );
    }

    if (index === 0) {
      continue;
    }

    const previous = intervals[index - 1]!;
    if (current.begin() < previous.begin()) {
      throw new TypeError(
        'bounded sequence intervals must be sorted by start time',
      );
    }

    if (current.begin() < previous.end()) {
      throw new TypeError('bounded sequence intervals must not overlap');
    }
  }
}

/**
 * A finite ordered list of `Interval` buckets.
 *
 * Use `BoundedSequence` when you already have an explicit interval list, or use
 * `Sequence.bounded(...)` to realize a finite run from an unbounded grid definition.
 */
export class BoundedSequence {
  readonly #intervals: ReadonlyArray<Interval>;

  /** Example: `new BoundedSequence([intervalA, intervalB])`. Creates a finite interval sequence from an explicit list. */
  constructor(intervals: ReadonlyArray<Interval>) {
    validateIntervals(intervals);
    this.#intervals = Object.freeze(intervals.slice());
    Object.freeze(this);
  }

  /** Example: `bounded.length`. Returns the number of intervals in the bounded sequence. */
  get length(): number {
    return this.#intervals.length;
  }

  /** Example: `bounded.at(0)`. Returns the interval at the supplied position, if present. */
  at(index: number): Interval | undefined {
    return this.#intervals[index];
  }

  /** Example: `bounded.first()`. Returns the first interval, if present. */
  first(): Interval | undefined {
    return this.at(0);
  }

  /** Example: `bounded.last()`. Returns the last interval, if present. */
  last(): Interval | undefined {
    return this.#intervals.length === 0
      ? undefined
      : this.#intervals[this.#intervals.length - 1];
  }

  /** Example: `bounded.timeRange()`. Returns the finite temporal extent of this bounded sequence, if any. */
  timeRange(): TimeRange | undefined {
    const first = this.first();
    const last = this.last();
    if (!first || !last) {
      return undefined;
    }
    return new TimeRange({ start: first.begin(), end: last.end() });
  }

  /** Example: `bounded.slice(0, 10)`. Returns a positional half-open slice of the bounded sequence. */
  slice(beginIndex?: number, endIndex?: number): BoundedSequence {
    return new BoundedSequence(this.#intervals.slice(beginIndex, endIndex));
  }

  /** Example: `bounded.intervals()`. Returns the finite explicit intervals represented by this bounded sequence. */
  intervals(): ReadonlyArray<Interval> {
    return this.#intervals;
  }
}
