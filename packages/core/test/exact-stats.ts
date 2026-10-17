/**
 * Exact oracles for test assertions: every double is an exact binary
 * fraction, so scaling by 2^1074 turns a list of doubles into `BigInt`s and
 * sums / sums of squares become exact. Only the final conversion back to a
 * double rounds. Slow (fine for test-sized inputs) and independent of every
 * floating-point method in `src/`.
 */

const SCALE = 1074n; // 2^-1074 is the smallest double step

/** `v · 2^1074` exactly. `v` must be finite. */
function toScaled(v: number): bigint {
  if (v === 0) return 0n;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  const bits = view.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  let e = -1074;
  if (exp !== 0) {
    mant |= 1n << 52n;
    e = exp - 1075;
  }
  return sign * (mant << BigInt(e + 1074));
}

/** `x / 2^shift` rounded to a double (≥ 60 significant bits kept first). */
function scaledToNumber(x: bigint, shift: bigint): number {
  if (x === 0n) return 0;
  const neg = x < 0n;
  const abs = neg ? -x : x;
  const drop = Math.max(0, abs.toString(2).length - 64);
  const head = Number(abs >> BigInt(drop));
  const out = head * 2 ** (drop - Number(shift));
  return neg ? -out : out;
}

/** The exact sum of `xs`, rounded once. */
export function exactSum(xs: readonly number[]): number {
  let s = 0n;
  for (const x of xs) s += toScaled(x);
  return scaledToNumber(s, SCALE);
}

/** The exact population stdev of `xs`, rounded (twice: variance, sqrt). */
export function exactStdev(xs: readonly number[]): number {
  const n = BigInt(xs.length);
  let s1 = 0n;
  let s2 = 0n;
  for (const x of xs) {
    const b = toScaled(x);
    s1 += b;
    s2 += b * b;
  }
  // variance = (n·Σx² − (Σx)²) / n² over the 2^2148 scale.
  const variance = scaledToNumber(n * s2 - s1 * s1, 2n * SCALE) / Number(n * n);
  return Math.sqrt(variance);
}
