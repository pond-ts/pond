/**
 * Type tests for `useTimeSeries` schema inference.
 *
 * The dashboard agent's 0.18.0 friction report (#3) found the prior
 * two-generic signature `<S, I extends Parameters<fromJSON<S>>[0]>` lost
 * `S` through the input-wrapper generic, collapsing the result to
 * `TimeSeries<never>` — so `ts.column('cpu')` was `never` and `.mean()`
 * raised TS2339. The fix is the single-generic `<S extends SeriesSchema>`
 * shape. These assertions are the real compile-time guard: they live under
 * `tsconfig.types.json` (`tsc -p` via `npm run test:type`), unlike the
 * runtime `.test.tsx` whose types esbuild strips.
 */
import { useTimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const input = {
  name: 'cpu',
  schema,
  rows: [['2025-01-01T00:00:00Z', 0.42, 'api-1']] as const,
};

const ts = useTimeSeries(input);

// Numeric column narrows to the schema-typed reduction (the regression
// surface — `never.mean()` raised TS2339 under the old signature).
const _mean: number | undefined = ts.column('cpu').mean();
void _mean;

// String column narrows by kind (`.at` is shared across packed/chunked).
const _hostCell: string | undefined = ts.column('host').at(0);
void _hostCell;

// Point access narrows per-column from the schema, too.
const _cell: number | undefined = ts.at(0)?.get('cpu');
void _cell;

// An explicit single type argument is accepted (the form the report showed
// failing with "Expected 2 type arguments, but got 1" under the old sig).
const _explicitMean: number | undefined = useTimeSeries<typeof schema>(input)
  .column('cpu')
  .mean();
void _explicitMean;

// Negative: a column name absent from the schema is rejected.
// @ts-expect-error 'nope' is not a column in the schema
ts.column('nope');
