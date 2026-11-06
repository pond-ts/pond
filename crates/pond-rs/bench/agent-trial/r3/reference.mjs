// pond-ts answer for the R3 step 7 agent trial.
//
//     npm run build --workspace=pond-ts
//     node crates/pond-rs/bench/agent-trial/r3/reference.mjs events.csv expected.csv
//
// One LiveSeries per host (reorder, so late events are kept), each with a
// one-minute LiveAggregation and a 5 s grace; events are pushed one at a
// time in file order, and each closed bucket is written with the row that
// closed it.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  LiveAggregation,
  LiveSeries,
  Sequence,
} from '../../../../../packages/core/dist/index.js';

const [input, output] = process.argv.slice(2);
const lines = readFileSync(input, 'utf8').trim().split('\n').slice(1);
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number', required: false },
];
const minute = Sequence.every('1m');
const hosts = new Map();
const out = ['host,start,avg,max,count,closed_by'];
let row = -1;
const cell = (v) => (v === undefined ? '' : String(v));
for (const line of lines) {
  row++;
  const [t, host, c] = line.split(',');
  let h = hosts.get(host);
  if (!h) {
    const series = new LiveSeries({ name: host, schema, ordering: 'reorder' });
    const agg = new LiveAggregation(
      series,
      minute,
      {
        avg: { from: 'cpu', using: 'avg' },
        max: { from: 'cpu', using: 'max' },
        count: { from: 'cpu', using: 'count' },
      },
      { grace: '5s' },
    );
    agg.on('event', (e) => {
      out.push(
        [
          host,
          e.begin(),
          cell(e.get('avg')),
          cell(e.get('max')),
          cell(e.get('count')),
          row,
        ].join(','),
      );
    });
    h = { series, agg };
    hosts.set(host, h);
  }
  h.series.push([Number(t), c === '' ? undefined : Number(c)]);
}
writeFileSync(output, out.join('\n') + '\n');
console.log(out.length - 1, 'buckets');
