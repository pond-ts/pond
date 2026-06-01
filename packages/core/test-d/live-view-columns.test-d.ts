/**
 * Type tests for the LiveView column-read surface (experimental, §A
 * pull/read). The durable compile-time guards for the dashboard's
 * friction #1 (partition key narrows to `string`) and #2 (`column()`
 * rejects non-numeric columns at compile time).
 */
import { LiveSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const view = new LiveSeries({ name: 's', schema }).window(10);

// column() narrows to numeric names; the result carries the numeric
// reduction surface.
const _mean: number | undefined = view.column('cpu').mean();
void _mean;

// keyColumn().begin is a Float64Array.
const _xs: Float64Array = view.keyColumn().begin;
void _xs;

// Negative (friction #2): non-numeric column names are rejected at
// compile time, not at runtime.
// @ts-expect-error 'host' is a string column, not numeric
view.column('host');
// @ts-expect-error 'nope' is not in the schema
view.column('nope');

// partitionBy().toMap() keys narrow to `string` (friction #1 — mirrors
// TimeSeries; no cast needed at the consumer).
const grouped = view
  .partitionBy('host')
  .toMap((g) => g.column('cpu').toFloat64Array());
const _grouped: Map<string, Float64Array> = grouped;
void _grouped;

// The group's column() narrows to numeric too.
view.partitionBy('host').toMap((g) => {
  const _gMean: number | undefined = g.column('cpu').mean();
  void _gMean;
  // @ts-expect-error 'host' is a string column inside the group
  g.column('host');
  return g.length;
});
