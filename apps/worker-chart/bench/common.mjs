// Shared bits for the Node benchmarks behind the guide's sections 7, 8 and 11.
// They feed a LiveSeries the way the render worker does: one pushSeries of
// fresh Float64Arrays every 16 ms of data time.
import { LiveSeries, TimeSeries } from 'pond-ts';

export const schema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
];

/** A LiveSeries plus a push(n) that appends n ticks spread over 16 ms. */
export function feed(options = {}) {
  const live = new LiveSeries({ name: 'ticks', schema, ...options });
  let t = 0;
  let p = 100;
  const push = (n) => {
    const time = new Float64Array(n);
    const price = new Float64Array(n);
    const size = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t += 16 / n;
      p += Math.random() - 0.5;
      time[i] = t;
      price[i] = p;
      size[i] = 1;
    }
    const start = performance.now();
    live.pushSeries(
      TimeSeries.fromColumns({
        name: 'ticks',
        schema,
        columns: { time, price, size },
      }),
    );
    return performance.now() - start;
  };
  return { live, push, now: () => t };
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};
export const range = (xs, digits = 1) =>
  `${Math.min(...xs).toFixed(digits)}–${Math.max(...xs).toFixed(digits)}`;
