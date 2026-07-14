import { ValueSeries } from 'pond-ts';

/** A synthetic strike, used by both the native-`fromColumns` and dual-x-axis
 *  value-axis examples so the two live embeds plot the same smile. */
export const SPOT = 100;

const smileSchema = [
  { name: 'strike', kind: 'value' },
  { name: 'fair', kind: 'number' },
] as const;

/** An options chain: rows are naturally keyed by strike, never by time —
 *  there's no time column to project from, so `ValueSeries.fromColumns`
 *  builds the value-keyed series directly. */
export function smileChain() {
  const strikes: number[] = [];
  const fair: number[] = [];
  for (let k = 80; k <= 120; k += 2.5) {
    const m = k - SPOT;
    strikes.push(k);
    fair.push(0.24 + 0.00042 * m * m - 0.0016 * m);
  }
  return ValueSeries.fromColumns({
    name: 'smile',
    schema: smileSchema,
    columns: { strike: strikes, fair },
  });
}
