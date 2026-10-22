/**
 * Type-level test for the chain-friendly options: `rolling(…, { append: true })`
 * keeps the source columns in the type, and `diff`/`rate`/`pctChange` with
 * `{ output }` add an optional number column and keep the source as it was.
 */
import { TimeSeries } from '../src/index.js';

const series = new TimeSeries({
  name: 's',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'host', kind: 'string' },
    { name: 'v', kind: 'number' },
  ] as const,
  rows: [],
});

// rolling append: source columns still typed, output column typed.
const rolled = series.rolling(
  '10s',
  { vAvg: { from: 'v', using: 'avg' } },
  { append: true },
);
const host: string | undefined = rolled.at(0)!.get('host');
const v: number = rolled.at(0)!.get('v');
const vAvg: number | undefined = rolled.at(0)!.get('vAvg');
// @ts-expect-error — a rolled column can hold gaps
const vAvgPlain: number = rolled.at(0)!.get('vAvg');
void vAvgPlain;
void host;
void v;
void vAvg;
// The chain can keep naming source columns after rolling.
rolled.diff('v');

// Without append the source columns are gone from the type.
const plainRolled = series.rolling('10s', {
  vAvg: { from: 'v', using: 'avg' },
});
// @ts-expect-error — 'v' is not in a non-append rolling result
plainRolled.diff('v');

// diff / rate / pctChange with output: source kept, new column optional.
for (const out of [
  series.diff('v', { output: 'dv' }),
  series.rate('v', { output: 'dv' }),
  series.pctChange('v', { output: 'dv', drop: true }),
]) {
  const kept: number = out.at(0)!.get('v');
  const change: number | undefined = out.at(0)!.get('dv');
  // @ts-expect-error — the new column can hold gaps
  const plain: number = out.at(0)!.get('dv');
  void kept;
  void change;
  void plain;
}

// @ts-expect-error — output takes one source column, not a list
series.diff(['v'], { output: 'dv' });

// Per partition too.
const parts = series
  .partitionBy('host')
  .diff('v', { output: 'dv' })
  .rolling('10s', { dvAvg: { from: 'dv', using: 'avg' } }, { append: true })
  .collect();
const partV: number = parts.at(0)!.get('v');
const partDv: number | undefined = parts.at(0)!.get('dv');
void partV;
void partDv;

// `append: false` is accepted on both, giving the usual result.
series.rolling('10s', { vAvg: { from: 'v', using: 'avg' } }, { append: false });
series
  .partitionBy('host')
  .rolling('10s', { vAvg: { from: 'v', using: 'avg' } }, { append: false });
