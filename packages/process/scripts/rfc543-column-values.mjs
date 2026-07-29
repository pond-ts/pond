/**
 * [PND-PROCCOL] — node values as columns rather than boxed arrays.
 *
 * One mode per process; comparing representations inside one heap gives
 * GC-dominated deltas, and `Float64Array` bytes live in `arrayBuffers`
 * rather than `heapUsed`, so both counters are reported.
 *
 *     node --expose-gc scripts/rfc543-column-values.mjs boxed
 *     node --expose-gc scripts/rfc543-column-values.mjs column
 *     node            scripts/rfc543-column-values.mjs read
 */
import { TimeSeries } from '../../core/dist/index.js';
import { sma } from '../../financial/dist/index.js';
import { packColumn, columnBytes } from '../dist/index.js';

const mode = process.argv[2] ?? 'read';
const N = 500_000;
const STUDIES = 20;

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'px', kind: 'number' },
];
const rows = new Array(N);
for (let i = 0; i < N; i += 1)
  rows[i] = [Date.UTC(2020, 0, 1) + i * 300_000, 100 + Math.sin(i / 900) * 12];
const base = TimeSeries.fromJSON({ name: 'px', schema, rows });

const mem = (label) => {
  global.gc?.();
  const m = process.memoryUsage();
  console.log(
    `  ${label.padEnd(28)} heap ${(m.heapUsed / 1048576).toFixed(0).padStart(4)} MB` +
      `   buffers ${(m.arrayBuffers / 1048576).toFixed(0).padStart(4)} MB` +
      `   rss ${(m.rss / 1048576).toFixed(0).padStart(4)} MB`,
  );
};

/** What the naive adapter does: unpack the study's packed column. */
function boxedValues(column) {
  const out = new Array(column.length).fill(undefined);
  column.scan(
    (v, i) => {
      out[i] = v;
    },
    { skipInvalid: true },
  );
  return out;
}

if (mode === 'boxed' || mode === 'column') {
  const held = [];
  for (let k = 0; k < STUDIES; k += 1) {
    const widened = sma(base, { column: 'px', period: 10 + k, output: 'o' });
    const col = widened.column('o');
    held.push(mode === 'boxed' ? boxedValues(col) : col);
  }
  mem(`${STUDIES} studies as ${mode}`);
  if (mode === 'column')
    console.log(
      `  columnBytes reports ${(held.reduce((s, c) => s + columnBytes(c), 0) / 1048576).toFixed(0)} MB` +
        ` across ${held.length} values — a budget can bound that`,
    );
  else
    console.log(
      '  a boxed array has no knowable size — a byte budget cannot bound it',
    );
}

if (mode === 'read') {
  // The MCP hot path: a fact is a fold over a node value. Boxed reads
  // re-box on every access; a column scans its buffer.
  const widened = sma(base, { column: 'px', period: 20, output: 'o' });
  const col = widened.column('o');
  const boxed = boxedValues(col);
  const packed = packColumn(boxed);

  const time = (label, fn) => {
    fn();
    const t = process.hrtime.bigint();
    let acc = 0;
    for (let r = 0; r < 20; r += 1) acc += fn();
    const ms = Number(process.hrtime.bigint() - t) / 1e6 / 20;
    console.log(`  ${label.padEnd(28)} ${ms.toFixed(2).padStart(6)} ms/fold`);
    return acc;
  };

  const a = time('max over boxed array', () => {
    let m = -Infinity;
    for (let i = 0; i < boxed.length; i += 1)
      if (boxed[i] !== undefined && boxed[i] > m) m = boxed[i];
    return m;
  });
  const b = time('max over column.scan', () => {
    let m = -Infinity;
    packed.scan((v) => {
      if (v > m) m = v;
    });
    return m;
  });
  // `scan` takes a callback per cell. Is the cost the representation, or
  // the call? Read the buffer directly and check the validity bit inline.
  const buf = packed.toFloat64Array();
  const bits = packed.validity?.bits;
  const c = time('max over buffer + bitmap', () => {
    let m = -Infinity;
    for (let i = 0; i < buf.length; i += 1) {
      if (bits !== undefined && (bits[i >> 3] & (1 << (i & 7))) === 0) continue;
      if (buf[i] > m) m = buf[i];
    }
    return m;
  });
  console.log(`  identical result: ${a === b && b === c}`);
}
