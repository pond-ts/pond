/**
 * Type tests for `TimeSeries.toJSON()` narrowing on `rowFormat`
 * ([PND-TSJSONT]). Mirrors `liveseries-tojson-narrowing.test-d.ts`; the
 * batch side used to return the loose `TimeSeriesJsonInput<SeriesSchema>`
 * because a narrowed return cascaded TS2394 through unrelated overloads.
 * The method-level `<T extends S = S>` parameter (same workaround as
 * `toColumns`) dodges that — this file would not compile if it regressed
 * to the loose return, and `tsc` over `src` would fail if the cascade came
 * back.
 */
import { TimeSeries } from '../src/index.js';
import type {
  JsonObjectRowForSchema,
  JsonRowFormat,
  JsonRowForSchema,
  SeriesSchema,
  TimeSeriesJsonInput,
  TimeSeriesJsonOutputArray,
  TimeSeriesJsonOutputObject,
} from '../src/schema/index.js';

type Equal<A, B> =
  (<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2
    ? true
    : false;
function assertType<_T extends true>(): void {}

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string', required: false },
] as const;
type S = typeof schema;

const series = new TimeSeries({
  name: 'test',
  schema,
  rows: [[0, 1, 'a']],
});

// Default: exactly the tuple-row envelope.
const defaultOut = series.toJSON();
assertType<Equal<typeof defaultOut, TimeSeriesJsonOutputArray<S>>>();
const _defaultRow: JsonRowForSchema<S> | undefined = defaultOut.rows[0];
void _defaultRow;
// Tuple cells are positional and kind-typed.
const _cpuCell: number | null | undefined = defaultOut.rows[0]?.[1];
void _cpuCell;

// Explicit array form.
const arrayOut = series.toJSON({ rowFormat: 'array' });
assertType<Equal<typeof arrayOut, TimeSeriesJsonOutputArray<S>>>();

// Object form: schema-keyed rows, no cast.
const objectOut = series.toJSON({ rowFormat: 'object' });
assertType<Equal<typeof objectOut, TimeSeriesJsonOutputObject<S>>>();
const _objectRow: JsonObjectRowForSchema<S> | undefined = objectOut.rows[0];
void _objectRow;
const _hostCell: string | null | undefined = objectOut.rows[0]?.host;
void _hostCell;

// A `rowFormat` only known as the union gets the union of the envelopes.
declare const fmt: JsonRowFormat;
const dynamicOut = series.toJSON({ rowFormat: fmt });
assertType<
  Equal<
    typeof dynamicOut,
    TimeSeriesJsonOutputArray<S> | TimeSeriesJsonOutputObject<S>
  >
>();

// Every form round-trips through `fromJSON` without a cast, and is assignable
// to the schema-precise input envelope.
TimeSeries.fromJSON(defaultOut);
TimeSeries.fromJSON(objectOut);
TimeSeries.fromJSON(dynamicOut);
const _inputArray: TimeSeriesJsonInput<S> = defaultOut;
void _inputArray;
const _inputObject: TimeSeriesJsonInput<S> = objectOut;
void _inputObject;
const _inputDynamic: TimeSeriesJsonInput<S> = dynamicOut;
void _inputDynamic;

// The tuple form is still assignable to the OLD return type...
const _looseArray: TimeSeriesJsonInput<SeriesSchema> = defaultOut;
void _looseArray;
// ...but the object form is not: `JsonObjectRowForSchema<SeriesSchema>`
// requires a property for every possible key name (`time`, `timeRange`,
// `interval`). This is the one documented break of the narrowing — annotate
// with `TimeSeriesJsonInput<typeof schema>` (or drop the annotation) instead.
// @ts-expect-error object rows don't fit the wide-schema object row
const _looseObject: TimeSeriesJsonInput<SeriesSchema> = objectOut;
void _looseObject;

// Negative: the two forms are not interchangeable.
// @ts-expect-error tuple rows have no `cpu` property
void defaultOut.rows[0]?.cpu;
// @ts-expect-error object-form return is NOT assignable to array-form
const _badAssign: TimeSeriesJsonOutputArray<S> = objectOut;
void _badAssign;
// @ts-expect-error array-form return is NOT assignable to object-form
const _badAssignReverse: TimeSeriesJsonOutputObject<S> = arrayOut;
void _badAssignReverse;

// A wide `TimeSeries<SeriesSchema>` (what the join overloads hand back) still
// narrows on the row format, at the wide schema.
declare const wide: TimeSeries<SeriesSchema>;
const wideObject = wide.toJSON({ rowFormat: 'object' });
assertType<
  Equal<typeof wideObject, TimeSeriesJsonOutputObject<SeriesSchema>>
>();
