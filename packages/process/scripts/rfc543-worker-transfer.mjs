/**
 * Worker topology — what does it cost to get a result off the worker?
 *
 * If the graph lives in a long-lived worker (browser or node), every
 * answer crosses a thread boundary. That boundary has very different
 * costs depending on how a node value is represented, which turns out to
 * be a second, independent argument for [PND-PROCCOL]:
 *
 *   - a packed `Float64Array` can be TRANSFERRED (zero-copy — the buffer
 *     changes owner) or structured-cloned as one memcpy;
 *   - a boxed `Array<number | undefined>` must be structured-cloned
 *     element by element, boxing each one again on the far side.
 *
 * Also measures the thing the topology is FOR: that a long compute on
 * the worker leaves the main thread responsive.
 *
 * Throwaway. Not package API, not published.
 *     node scripts/rfc543-worker-transfer.mjs
 */
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const N = 500_000;

// ── worker side ──────────────────────────────────────────────
if (!isMainThread) {
  const packed = new Float64Array(N);
  for (let i = 0; i < N; i += 1) packed[i] = 100 + Math.sin(i / 900) * 12;
  const boxed = new Array(N);
  for (let i = 0; i < N; i += 1) boxed[i] = i < 200 ? undefined : packed[i];

  parentPort.on('message', (msg) => {
    if (msg.kind === 'boxed') {
      parentPort.postMessage({ kind: 'boxed', values: boxed, t: Date.now() });
    } else if (msg.kind === 'clone') {
      // Structured clone of a typed array: one buffer copy.
      parentPort.postMessage({ kind: 'clone', values: packed, t: Date.now() });
    } else if (msg.kind === 'transfer') {
      // Zero-copy: the buffer changes owner. Send a fresh copy each time
      // so the worker keeps its own (a transferred buffer is detached).
      const copy = packed.slice();
      parentPort.postMessage(
        { kind: 'transfer', values: copy, t: Date.now() },
        [copy.buffer],
      );
    } else if (msg.kind === 'busy') {
      // Occupy the worker so the main thread can prove it stayed free.
      const until = Date.now() + msg.ms;
      let acc = 0;
      while (Date.now() < until) acc += Math.sqrt(acc + 1);
      parentPort.postMessage({ kind: 'busy', acc });
    } else if (msg.kind === 'stop') {
      parentPort.close();
    }
  });
  parentPort.postMessage({ kind: 'ready' });
}

// ── main side ────────────────────────────────────────────────
if (isMainThread) {
  const worker = new Worker(fileURLToPath(import.meta.url));
  const once = (predicate) =>
    new Promise((resolve) => {
      const on = (m) => {
        if (predicate(m)) {
          worker.off('message', on);
          resolve(m);
        }
      };
      worker.on('message', on);
    });

  await once((m) => m.kind === 'ready');

  const round = async (kind, reps = 5) => {
    // Warm once, then time.
    worker.postMessage({ kind });
    await once((m) => m.kind === kind);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < reps; i += 1) {
      worker.postMessage({ kind });
      const m = await once((x) => x.kind === kind);
      if (m.values.length !== N) throw new Error('length mismatch');
    }
    return Number(process.hrtime.bigint() - t0) / 1e6 / reps;
  };

  console.log(`\n${N.toLocaleString()} values across the worker boundary\n`);
  const boxed = await round('boxed');
  const clone = await round('clone');
  const transfer = await round('transfer');
  console.log(
    `  boxed Array<number|undefined>   ${boxed.toFixed(1).padStart(7)} ms/message`,
  );
  console.log(
    `  Float64Array, structured clone  ${clone.toFixed(1).padStart(7)} ms/message`,
  );
  console.log(
    `  Float64Array, transferred       ${transfer.toFixed(1).padStart(7)} ms/message`,
  );
  console.log(
    `  -> clone ${(boxed / clone).toFixed(0)}x, transfer ${(boxed / transfer).toFixed(0)}x cheaper than boxed`,
  );
  console.log(
    '     A boxed array is cloned element by element and re-boxed on arrival;',
  );
  console.log(
    '     a packed column is one buffer. This is a SECOND argument for',
  );
  console.log('     [PND-PROCCOL], independent of the memory one.');

  // ── the point of the topology: the main thread stays free ──
  console.log(
    '\n  main thread responsiveness while the worker computes 600 ms:',
  );
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 10);
  const t0 = process.hrtime.bigint();
  worker.postMessage({ kind: 'busy', ms: 600 });
  await once((m) => m.kind === 'busy');
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  clearInterval(timer);
  console.log(
    `    worker busy ${elapsed.toFixed(0)} ms, main thread ticked ${ticks}x ` +
      `(~${((ticks / (elapsed / 10)) * 100).toFixed(0)}% of a free 10 ms timer)`,
  );
  console.log(
    "    -> decode / ingest / resolve off the main thread is the topology's",
  );
  console.log('       actual product, and it is independent of where it runs.');

  worker.postMessage({ kind: 'stop' });
  await worker.terminate();
}
