/**
 * Type-level test for `TimeSeries.scan(…, { output })` [PND-SCANREQ]: the new
 * column can hold gaps (rows before the first value, non-finite outputs), so
 * reading it gives `number | undefined`, on a series and per partition.
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

const run = series.scan('v', (a, v) => [a + v, a + v], 0, { output: 'run' });
const value: number | undefined = run.at(0)!.get('run');
// @ts-expect-error — the column can hold gaps, so it is not a plain number
const plain: number = run.at(0)!.get('run');
void value;
void plain;

const parts = series
  .partitionBy('host')
  .scan('v', (a, v) => [a + v, a + v], 0, { output: 'run' })
  .collect();
// @ts-expect-error — optional per partition too
const partPlain: number = parts.at(0)!.get('run');
void partPlain;
