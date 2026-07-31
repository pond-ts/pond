import { parentPort, workerData } from 'node:worker_threads';
const x = new Float64Array(workerData.x);
const o = workerData.out.map((b) => new Float64Array(b));

// Rolling mean + population stdev over the OUTPUT range [s,e).
// Each output cell depends on inputs [i-p+1, i], so a chunk reads a
// `p-1` element overlap before its range and is otherwise independent.
// Welford add/remove, matching the shape of pond's rolling kernel: a
// running sum-of-squares would be cheaper and markedly less stable.
function rolling(s, e, p, kind, k) {
  const warm = Math.max(0, s - p + 1);
  let n = 0, mean = 0, m2 = 0;
  const add = (v) => { n += 1; const d = v - mean; mean += d / n; m2 += d * (v - mean); };
  const rem = (v) => {
    if (n <= 1) { n = 0; mean = 0; m2 = 0; return; }
    const d = v - mean; mean -= d / (n - 1); m2 -= d * (v - mean); n -= 1;
    if (m2 < 0) m2 = 0;
  };
  for (let i = warm; i < e; i += 1) {
    add(x[i]);
    if (i - warm >= p) rem(x[i - p]);
    if (i < s) continue;
    if (i < p - 1) { for (const out of o) out[i] = NaN; continue; }
    const sd = Math.sqrt(m2 / n);
    if (kind === 'bollinger') { o[0][i] = mean; o[1][i] = mean + k * sd; o[2][i] = mean - k * sd; }
    else { o[0][i] = sd === 0 ? NaN : (x[i] - mean) / sd; }
  }
}

parentPort.on('message', (m) => {
  if (m.kind !== 'ping') rolling(m.s, m.e, m.p, m.study, m.k);
  parentPort.postMessage({ id: m.id });
});
