import { parentPort, workerData } from 'node:worker_threads';
const x = new Float64Array(workerData.x);
const y = new Float64Array(workerData.y);
const carry = new Float64Array(workerData.carry); // per-chunk [local_last, A]

// Phase 1: local EMA assuming the incoming value is 0, plus A = a^len.
function phase1(s, e, a, alpha) {
  let v = 0, A = 1;
  for (let i = s; i < e; i += 1) { v = a * v + alpha * x[i]; y[i] = v; A *= a; }
  return [v, A];
}
// Phase 3: fold in this chunk's true incoming value.
function phase3(s, e, a, incoming) {
  let p = a;
  for (let i = s; i < e; i += 1) { y[i] += p * incoming; p *= a; }
}

parentPort.on('message', (m) => {
  if (m.kind === 'ping') return parentPort.postMessage({ id: m.id });
  if (m.kind === 'p1') {
    const [last, A] = phase1(m.s, m.e, m.a, m.alpha);
    carry[m.c * 2] = last; carry[m.c * 2 + 1] = A;
  } else if (m.kind === 'p3') {
    if (m.incoming !== 0) phase3(m.s, m.e, m.a, m.incoming);
  }
  parentPort.postMessage({ id: m.id });
});
