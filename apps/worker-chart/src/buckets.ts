/**
 * One bucket per device-pixel column of the chart's time window, holding the
 * first, lowest, highest and last price that fell in it. Each tick updates
 * the newest bucket (or opens the next one) as it arrives, and a frame draws
 * the buckets, not the ticks. So memory and drawing cost depend on the number
 * of columns, not on how many ticks the window holds.
 */
export class Buckets {
  readonly ms: number; // time covered by one bucket
  readonly cap: number;
  // Ring buffers, one slot per bucket.
  readonly k: Float64Array; // bucket number: floor(time / ms)
  readonly lo: Float64Array;
  readonly hi: Float64Array;
  readonly first: Float64Array;
  readonly last: Float64Array;
  readonly n: Float64Array; // ticks in the bucket
  head = 0;
  len = 0;

  constructor(windowMs: number, columns: number) {
    this.ms = windowMs / columns;
    this.cap = columns + 2; // the window plus the partly visible edges
    this.k = new Float64Array(this.cap);
    this.lo = new Float64Array(this.cap);
    this.hi = new Float64Array(this.cap);
    this.first = new Float64Array(this.cap);
    this.last = new Float64Array(this.cap);
    this.n = new Float64Array(this.cap);
  }

  add(time: number, value: number): void {
    const k = Math.floor(time / this.ms);
    if (this.len > 0) {
      const i = (this.head + this.len - 1) % this.cap;
      if (this.k[i] === k) {
        if (value < this.lo[i]!) this.lo[i] = value;
        if (value > this.hi[i]!) this.hi[i] = value;
        this.last[i] = value;
        this.n[i]!++;
        return;
      }
    }
    if (this.len === this.cap) this.dropOldest();
    const i = (this.head + this.len++) % this.cap;
    this.k[i] = k;
    this.lo[i] = this.hi[i] = this.first[i] = this.last[i] = value;
    this.n[i] = 1;
  }

  /** Drop buckets that end before `cutoff`. */
  evictBefore(cutoff: number): void {
    const kc = Math.floor(cutoff / this.ms);
    while (this.len > 0 && this.k[this.head]! < kc) this.dropOldest();
  }

  /** The newest value, or undefined when empty. */
  newest(): number | undefined {
    if (this.len === 0) return undefined;
    return this.last[(this.head + this.len - 1) % this.cap];
  }

  /** Lowest and highest value held, or undefined when empty. */
  range(): [number, number] | undefined {
    if (this.len === 0) return undefined;
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = 0; j < this.len; j++) {
      const i = (this.head + j) % this.cap;
      if (this.lo[i]! < lo) lo = this.lo[i]!;
      if (this.hi[i]! > hi) hi = this.hi[i]!;
    }
    return [lo, hi];
  }

  private dropOldest(): void {
    this.head = (this.head + 1) % this.cap;
    this.len--;
  }
}

/**
 * One polyline through every bucket: first, low, high, last. A pixel column
 * can't show more than its lowest and highest point, so this should look
 * close to a line through every tick (not compared image to image).
 */
export function drawBuckets(
  ctx: OffscreenCanvasRenderingContext2D,
  b: Buckets,
  x: (time: number) => number,
  y: (value: number) => number,
): void {
  ctx.beginPath();
  for (let j = 0; j < b.len; j++) {
    const i = (b.head + j) % b.cap;
    const px = x((b.k[i]! + 0.5) * b.ms);
    if (j === 0) ctx.moveTo(px, y(b.first[i]!));
    else ctx.lineTo(px, y(b.first[i]!));
    if (b.n[i]! > 1) {
      ctx.lineTo(px, y(b.lo[i]!));
      ctx.lineTo(px, y(b.hi[i]!));
      ctx.lineTo(px, y(b.last[i]!));
    }
  }
  ctx.stroke();
}
