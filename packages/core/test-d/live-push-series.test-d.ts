/**
 * Type-level tests for `LiveSeries.pushSeries` ([PND-LPUSHCOL]): the
 * batch must carry the live series' schema. A batch built from the same
 * schema, or another live series' snapshot of it, compiles; a renamed or
 * reordered column does not. The runtime check covers what the type
 * can't see (a runtime schema, a cast, a `required` flag).
 */
import { LiveSeries, TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number' },
] as const;

const live = new LiveSeries({ name: 'ticks', schema });

// Same schema, built through the columnar door.
live.pushSeries(
  TimeSeries.fromColumns({
    name: 'batch',
    schema,
    columns: {
      time: new Float64Array([0, 1]),
      price: new Float64Array([1, 2]),
      size: new Float64Array([3, 4]),
    },
  }),
);

// Another live series' snapshot of the same schema.
const other = new LiveSeries({ name: 'other', schema });
live.pushSeries(other.toTimeSeries());

const renamed = new TimeSeries({
  name: 'r',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'cost', kind: 'number' },
    { name: 'size', kind: 'number' },
  ] as const,
  rows: [],
});
// @ts-expect-error a renamed value column is not this schema
live.pushSeries(renamed);

const reordered = new TimeSeries({
  name: 'o',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'size', kind: 'number' },
    { name: 'price', kind: 'number' },
  ] as const,
  rows: [],
});
// @ts-expect-error reordered columns are not this schema
live.pushSeries(reordered);

const extra = new TimeSeries({
  name: 'e',
  schema: [...schema, { name: 'venue', kind: 'string' }] as const,
  rows: [],
});
// @ts-expect-error an extra column is not this schema
live.pushSeries(extra);

// A `required` flag the live schema doesn't share still compiles: the
// runtime check judges gaps by the live schema.
const optional = new TimeSeries({
  name: 'opt',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'price', kind: 'number', required: false },
    { name: 'size', kind: 'number' },
  ] as const,
  rows: [],
});
live.pushSeries(optional);

// @ts-expect-error rows are not a series
live.pushSeries([[0, 1, 2]]);
