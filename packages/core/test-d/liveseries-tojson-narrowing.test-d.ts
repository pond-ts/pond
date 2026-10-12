/**
 * Type tests for `LiveSeries.toJSON()` overload narrowing on
 * `rowFormat`. The companion friction note (#3 from the gRPC
 * experiment's M1) was that the broad `TimeSeriesJsonInput`-style
 * return forced consumers to cast `result.rows` before iterating.
 * The narrowing closes that for the live snapshot path;
 * `TimeSeries.toJSON` narrows the same way since [PND-TSJSONT]
 * (see `timeseries-tojson-narrowing.test-d.ts`).
 */
import { LiveSeries } from '../src/index.js';
import type {
  JsonObjectRowForSchema,
  JsonRowFormat,
  JsonRowForSchema,
  TimeSeriesJsonOutputArray,
  TimeSeriesJsonOutputObject,
} from '../src/schema/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string', required: false },
] as const;

const live = new LiveSeries({ name: 'test', schema });

// Default: array-form rows.
const defaultOut = live.toJSON();
const defaultCheck: TimeSeriesJsonOutputArray<typeof schema> = defaultOut;
void defaultCheck;
const defaultRows = defaultOut.rows;
const _defaultRowsArray: ReadonlyArray<JsonRowForSchema<typeof schema>> =
  defaultRows;
void _defaultRowsArray;

// Explicit array form.
const arrayOut = live.toJSON({ rowFormat: 'array' });
const arrayCheck: TimeSeriesJsonOutputArray<typeof schema> = arrayOut;
void arrayCheck;
const _arrayRow: JsonRowForSchema<typeof schema> | undefined = arrayOut.rows[0];
void _arrayRow;

// Object form: the narrowed return.
const objectOut = live.toJSON({ rowFormat: 'object' });
const objectCheck: TimeSeriesJsonOutputObject<typeof schema> = objectOut;
void objectCheck;
const _objectRow: JsonObjectRowForSchema<typeof schema> | undefined =
  objectOut.rows[0];
void _objectRow;

// Negative: object-form return is NOT assignable to array-form.
// @ts-expect-error rows shapes diverge — array tuple vs schema-keyed record
const _badAssign: TimeSeriesJsonOutputArray<typeof schema> = objectOut;
void _badAssign;

// Negative (inverse): array-form return is NOT assignable to object-form.
// @ts-expect-error rows shapes diverge in the other direction too
const _badAssignReverse: TimeSeriesJsonOutputObject<typeof schema> = arrayOut;
void _badAssignReverse;

// A `rowFormat` only known as `JsonRowFormat` resolves to the union (this
// call had no matching overload before [PND-TSJSONT]).
declare const fmt: JsonRowFormat;
const dynamicOut:
  | TimeSeriesJsonOutputArray<typeof schema>
  | TimeSeriesJsonOutputObject<typeof schema> = live.toJSON({ rowFormat: fmt });
void dynamicOut;

// Call shapes a caller forwarding options must be able to use: the union
// overload takes an optional `options`, so a possibly-undefined options
// variable, a spread, and a non-fresh object with extra keys resolve.
declare const maybeOpts: { rowFormat?: JsonRowFormat } | undefined;
const maybeOut:
  | TimeSeriesJsonOutputArray<typeof schema>
  | TimeSeriesJsonOutputObject<typeof schema> = live.toJSON(maybeOpts);
void maybeOut;
const undefOut: TimeSeriesJsonOutputArray<typeof schema> =
  live.toJSON(undefined);
void undefOut;
const emptyOut: TimeSeriesJsonOutputArray<typeof schema> = live.toJSON({});
void emptyOut;
declare const reqOpts: { rowFormat: 'array' | 'object' };
live.toJSON(reqOpts);
live.toJSON({ ...maybeOpts });
declare const extraOpts: { rowFormat: 'object'; label: string };
const extraOut: TimeSeriesJsonOutputObject<typeof schema> =
  live.toJSON(extraOpts);
void extraOut;
declare const spreadArgs: Parameters<typeof live.toJSON>;
live.toJSON(...spreadArgs);
