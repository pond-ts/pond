// pond-ts's answer to the R2 step-5 trial task (prompt.txt), for check.py.
//
//     npm run build --workspace=pond-ts
//     npm run build --workspace=@pond-ts/financial
//     node crates/pond-rs/bench/agent-trial/r2/reference.mjs data.arrow > reference.json
import { readFileSync } from 'node:fs';
import { tableFromIPC } from 'apache-arrow';
import { TimeSeries } from '../../../../../packages/core/dist/index.js';
import {
  TradingCalendar,
  bollinger,
  rsi,
  sessionVwap,
} from '../../../../../packages/financial/dist/index.js';

const table = tableFromIPC(readFileSync(process.argv[2]));
const names = ['open', 'high', 'low', 'close', 'volume'];
const cols = names.map((n) => table.getChild(n));
const time = table.getChild('time');
const rows = [];
for (let i = 0; i < table.numRows; i++) {
  rows.push([Number(time.get(i)), ...cols.map((c) => c.get(i))]);
}
const bars = new TimeSeries({
  name: 'bars',
  schema: [
    { name: 'time', kind: 'time' },
    ...names.map((name) => ({ name, kind: 'number' })),
  ],
  rows,
});
const calendar = TradingCalendar.fromRules(
  { timeZone: 'America/New_York', open: '09:30', close: '16:00' },
  { from: '2024-03-04', to: '2024-03-15' },
);
const out = sessionVwap(bollinger(rsi(bars), { period: 20 }), {
  sessions: calendar,
  output: 'vwap',
});
const column = (name) =>
  Array.from({ length: out.length }, (_, i) => out.column(name).at(i) ?? null);
console.log(
  JSON.stringify({
    time: rows.map((r) => r[0]),
    rsi: column('rsi'),
    bbUpper: column('bbUpper'),
    bbLower: column('bbLower'),
    vwap: column('vwap'),
  }),
);
