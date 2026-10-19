// pond-ts's answer to the step-4b trial task (prompt.txt), for check.py.
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/agent-trial/q11/reference.mjs data.arrow > reference.json
import { readFileSync } from 'node:fs';
import { tableFromIPC } from 'apache-arrow';
import { TimeSeries } from '../../../../../packages/core/dist/index.js';

const table = tableFromIPC(readFileSync(process.argv[2]));
const time = table.getChild('time');
const symbol = table.getChild('symbol');
const close = table.getChild('close');
const rows = [];
for (let i = 0; i < table.numRows; i++) {
  const c = close.get(i);
  // A row with no close is not a reading: drop it, so each symbol's last
  // row is its latest close and windows hold only real closes.
  if (c === null) continue;
  rows.push([Number(time.get(i)), symbol.get(i), c]);
}
const series = new TimeSeries({
  name: 'panel',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'symbol', kind: 'string' },
    { name: 'close', kind: 'number' },
  ],
  rows,
});
const parts = series
  .partitionBy('symbol')
  .rolling('60m', {
    mean: { from: 'close', using: 'avg' },
    sd: { from: 'close', using: 'stdev' },
    close: 'last',
  })
  .toMap();
const z = [];
for (const [name, s] of parts) {
  const last = s.at(s.length - 1);
  const sd = last.get('sd');
  if (!(sd > 0)) continue;
  z.push({
    symbol: name,
    time: last.begin(),
    z: (last.get('close') - last.get('mean')) / sd,
  });
}
z.sort(
  (a, b) => Math.abs(b.z) - Math.abs(a.z) || (a.symbol < b.symbol ? -1 : 1),
);
console.log(JSON.stringify(z.slice(0, 20), null, 1));
