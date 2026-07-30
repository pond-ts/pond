import { parentPort, workerData } from 'node:worker_threads';

const values = new Float64Array(workerData.sab);

// Rolling mean over [start, end), window w, into out. Fresh running sum per
// job, warmed from max(0, start-w+1) — deterministic for a fixed chunk grid,
// but a different rounding history than one continuous sweep (same class of
// last-ulp shift as blocked summation).
function rollingMean(out, start, end, w) {
  let s = 0;
  const from = Math.max(0, start - w + 1);
  for (let i = from; i < Math.min(start, from + w); i += 1) s += values[i];
  for (let i = start; i < end; i += 1) {
    s += values[i];
    if (i >= w) s -= values[i - w];
    out[i] = i >= w - 1 ? s / w : NaN;
  }
}

// Rolling population stdev via the naive two-pass per window? No — running
// sum + sum of squares (fast, familiar shape; fine for a scaling model).
function rollingStd(out, start, end, w) {
  let s = 0,
    s2 = 0;
  const from = Math.max(0, start - w + 1);
  for (let i = from; i < Math.min(start, from + w); i += 1) {
    s += values[i];
    s2 += values[i] * values[i];
  }
  for (let i = start; i < end; i += 1) {
    s += values[i];
    s2 += values[i] * values[i];
    if (i >= w) {
      s -= values[i - w];
      s2 -= values[i - w] * values[i - w];
    }
    if (i >= w - 1) {
      const m = s / w;
      const v = s2 / w - m * m;
      out[i] = v > 0 ? Math.sqrt(v) : 0;
    } else out[i] = NaN;
  }
}

parentPort.on('message', (msg) => {
  if (msg.kind === 'ping') {
    parentPort.postMessage({ id: msg.id });
    return;
  }
  const out = new Float64Array(msg.outSab);
  if (msg.kind === 'mean') rollingMean(out, msg.start, msg.end, msg.w);
  else if (msg.kind === 'std') rollingStd(out, msg.start, msg.end, msg.w);
  parentPort.postMessage({ id: msg.id });
});
