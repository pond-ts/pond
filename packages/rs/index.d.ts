// Type declarations for @pond-ts/rs ([PND-RSTYPES]).
//
// Written by hand over index.js, which is itself hand-written over a JSON
// dispatcher in crates/pond-wasm, so nothing generates them, except the
// block of study options at the end: `node scripts/types.mjs` writes it from
// the study catalog, and `npm run test:types` fails when it is stale.
// `test:types` also compiles, with `tsc --strict`, a file of calls taken
// from the parity fixtures the bridge is tested against (every core case,
// every study call), and checks that every method and export the module has
// at runtime is declared here.
//
// The shapes are pond-ts's. One difference by design: a series is not
// typed by its schema (pond-ts's `TimeSeries<S>` is), so a cell reads as
// `Cell` and a column name as `string`.

// ---- values and schemas ----------------------------------------------------

/** A duration as text (`'5m'`, `'1h30m'`) or a whole number of ms. */
export type Duration = string | number;

/** The key column's kind: the first column of every schema. */
export type KeyKind = 'time' | 'timeRange' | 'interval';
/** A value column's kind. */
export type ValueKind = 'number' | 'string' | 'boolean' | 'array';

/** The key column: `{ name: 'time', kind: 'time' }`. */
export interface KeyColumnDef {
  readonly name: string;
  readonly kind: KeyKind;
}
/** A value column; required unless `required: false` (as pond-ts). */
export interface ValueColumnDef {
  readonly name: string;
  readonly kind: ValueKind;
  readonly required?: boolean;
}
/** A schema: the key column, then the value columns. */
export type SchemaInput = readonly [KeyColumnDef, ...ValueColumnDef[]];
/** A series' key column: named by its kind (as pond-ts's). */
export type KeyColumn =
  | { readonly name: 'time'; readonly kind: 'time' }
  | { readonly name: 'timeRange'; readonly kind: 'timeRange' }
  | { readonly name: 'interval'; readonly kind: 'interval' };
/** One column of a series' schema. */
export type ColumnDef = KeyColumn | ValueColumnDef;
/** A series' schema, as `series.schema` gives it: the key, then the values. */
export type Schema = readonly [KeyColumn, ...ValueColumnDef[]];

/** A number, text or true/false. */
export type Scalar = number | string | boolean;
/** A cell of a value column: a scalar, or a list of them (`array` columns). */
export type Cell = Scalar | readonly Scalar[];

/**
 * A key written as data: a time in ms, `[start, end]` for a time range,
 * `[label, start, end]` for an interval.
 */
export type KeyData =
  | number
  | readonly [number, number]
  | readonly [string | number, number, number];

/** A key in a row or a lookup: as data, as a key object, or tagged. */
export type KeyLike =
  | KeyData
  | Time
  | TimeRange
  | Interval
  | { readonly time: number }
  | { readonly timeRange: readonly [number, number] }
  | { readonly interval: readonly [string | number, number, number] };

/** A row for the constructor: `[key, ...cells]`, `undefined` for a gap. */
export type RowInput = readonly [KeyData, ...(Cell | undefined)[]];

/** `new TimeSeries({ name, schema, rows })`: times in ms. */
export interface TimeSeriesInput {
  readonly name?: string;
  readonly schema: SchemaInput;
  readonly rows: readonly RowInput[];
}

/** A row as pond-ts JSON writes it: times as ms or as text, `null` for a gap. */
export type JsonRow =
  | readonly [
      (
        | number
        | string
        | readonly [number | string, number | string]
        | readonly [string | number, number | string, number | string]
      ),
      ...(Cell | null | undefined)[],
    ]
  | { readonly [column: string]: unknown };

/** pond-ts's `toJSON()` shape, for `TimeSeries.fromJSON`. */
export interface TimeSeriesJsonInput {
  readonly name?: string;
  readonly schema: SchemaInput;
  readonly rows: readonly JsonRow[];
}

/** What `toJSON()` gives: `[key, ...cells]` rows, `null` for a gap. */
export interface TimeSeriesJson {
  name: string;
  schema: Schema;
  rows: Array<[KeyData, ...(Cell | null)[]]>;
}
/** What `toJSON({ rowFormat: 'object' })` gives. */
export interface TimeSeriesObjectJson {
  name: string;
  schema: Schema;
  rows: Array<Record<string, unknown>>;
}

/** A column of `toColumns()` holding values of kind `K` (`null` for a gap). */
export type ColumnArray<K extends ValueKind> = K extends 'number'
  ? Array<number | null>
  : K extends 'string'
    ? Array<string | null>
    : K extends 'boolean'
      ? Array<boolean | null>
      : Array<readonly Scalar[] | null>;

/**
 * What `toColumns()` gives: pond-ts's columnar shape, one array per column
 * (`null` for a gap). A `timeRange` key adds `timeRangeEnd`; an `interval`
 * key adds `intervalEnd` and `intervalLabel`. `K` is the kinds of the value
 * columns (all four unless the caller says fewer).
 */
export interface TimeSeriesColumns<K extends ValueKind = ValueKind> {
  name: string;
  schema: Schema;
  columns: Record<string, ColumnArray<K | 'number' | 'string'>>;
}

// ---- reducers and mappings -------------------------------------------------

/**
 * A reducer by name: `p95` is a percentile, `top3` the three most common
 * values. pond-rs has named reducers only (pond-ts also takes a function).
 */
export type Reducer =
  | 'count'
  | 'sum'
  | 'avg'
  | 'mean'
  | 'min'
  | 'max'
  | 'first'
  | 'last'
  | 'median'
  | 'stdev'
  | 'difference'
  | 'keep'
  | 'unique'
  | 'samples'
  | `p${number}`
  | `top${number}`;

/**
 * Output columns and how each is made: `{ value: 'avg' }` (same name in and
 * out) or `{ peak: { from: 'value', using: 'max' } }`.
 */
export interface AggregateMapping {
  readonly [output: string]:
    | Reducer
    | { readonly from: string; readonly using: Reducer };
}

/** `cumulative`: a reducer, or a running count of rises or falls. */
export type CumulativeSpec =
  | Reducer
  | 'increase'
  | 'decrease'
  | {
      readonly using: 'increase' | 'decrease';
      readonly threshold?: number;
    };

/** `fill`: a strategy, or a value to put in each gap. */
export type FillStrategy =
  | 'hold'
  | 'bfill'
  | 'linear'
  | 'zero'
  | number
  | string
  | boolean
  | readonly Scalar[];

/** A column name or a list of them. */
export type Columns = string | readonly string[];

// ---- options ---------------------------------------------------------------

export type Alignment = 'trailing' | 'leading' | 'centered';
/** Where in a bucket a row's time is read: its start, middle or end. */
export type SamplePoint = 'begin' | 'center' | 'end';
/** A span of time: one time, or `{ start, end }` (ms). */
export type RangeOption =
  | number
  | { readonly start: number; readonly end: number };

export interface RollingOptions {
  readonly alignment?: Alignment;
  /** Fewer present values than this gives a gap. */
  readonly minSamples?: number;
  readonly append?: boolean;
}
export interface RollingOverOptions {
  readonly alignment?: Alignment;
  readonly minSamples?: number;
  readonly sample?: SamplePoint;
  readonly range?: RangeOption;
}
export interface ChangeOptions {
  /** Drop the first row (it has nothing to compare with). */
  readonly drop?: boolean;
  readonly output?: string;
}
export interface FillOptions {
  /** Fill at most this many gaps in a row. */
  readonly limit?: number;
  /** Fill only gaps shorter than this. */
  readonly maxGap?: Duration;
}
export interface AlignOptions {
  readonly method?: 'hold' | 'linear';
  readonly sample?: SamplePoint;
  readonly range?: RangeOption;
}
export interface MaterializeOptions {
  readonly select?: 'last' | 'first' | 'nearest';
  readonly sample?: SamplePoint;
  readonly range?: RangeOption;
}
export interface DedupeOptions {
  readonly keep?:
    | 'first'
    | 'last'
    | 'error'
    | 'drop'
    | { readonly min: string }
    | { readonly max: string };
}
export interface SmoothOptions {
  /** `ema`: the weight of each new value (exactly one of `alpha`, `span`). */
  readonly alpha?: number;
  /** `ema`: a span in rows; `loess`: the share of rows in each fit. */
  readonly span?: number;
  /** `movingAverage`: the window. */
  readonly window?: Duration;
  readonly warmup?: number;
  readonly minSamples?: number;
  readonly alignment?: Alignment;
  readonly missing?: 'bridge' | 'skip';
  readonly output?: string;
}
export interface BaselineOptions {
  readonly window: string;
  readonly sigma: number;
  readonly alignment?: Alignment;
  readonly minSamples?: number;
  /** Names of the four output columns. */
  readonly names?: {
    readonly avg?: string;
    readonly sd?: string;
    readonly upper?: string;
    readonly lower?: string;
  };
}
export interface OutliersOptions {
  readonly window: string;
  readonly sigma: number;
  readonly alignment?: Alignment;
  readonly minSamples?: number;
}
export type SampleOptions =
  | { readonly stride: number }
  | { readonly reservoir: { readonly size: number; readonly seed?: number } };
export interface JoinOptions {
  readonly type?: 'outer' | 'inner' | 'left' | 'right';
  readonly onConflict?: 'error' | 'prefix';
  /** With `onConflict: 'prefix'`: one prefix per series. */
  readonly prefixes?: readonly string[];
}
export interface ArrayOptions {
  /** The output column's name. */
  readonly as?: string;
  /** The output column's kind. */
  readonly kind?: ValueKind;
}
export interface PivotOptions {
  readonly aggregate?: Reducer;
  /** The groups to make columns for, in this order. */
  readonly groups?: readonly string[];
}
/** `byColumn` bins: fixed edges, or a width from an origin. */
export type Bins =
  | { readonly edges: readonly number[]; readonly inclusive?: '[)' | '(]' }
  | { readonly width: number; readonly origin?: number };
export interface RollingByColumnSpec {
  readonly radius: number;
  /** The values to centre a window on (default: every row's). */
  readonly at?: readonly number[];
}

/** A row reduced to its named cells (`reduce`, `byColumn`); `null` for a gap. */
export type ReducedRecord = Record<string, Cell | null>;

// ---- keys ------------------------------------------------------------------

/** A point in time (ms), as pond-ts `Time`. */
export declare class Time {
  /** `Time.parse('2025-01-01T09:00', { timeZone: 'Europe/Madrid' })`. */
  static parse(text: string, options?: { timeZone?: string }): Time;
  constructor(t: number | Date);
  readonly kind: 'time';
  readonly timestamp: number;
  type(): 'time';
  begin(): number;
  end(): number;
  timeRange(): TimeRange;
  timestampMs(): number;
  toDate(): Date;
  valueOf(): number;
  duration(): number;
  equals(other: unknown): boolean;
}

/** A span `[start, end]` (ms), as pond-ts `TimeRange`. */
export declare class TimeRange {
  constructor(
    input:
      | readonly [number | Date, number | Date]
      | { readonly start: number | Date; readonly end: number | Date },
  );
  readonly kind: 'timeRange';
  readonly start: number;
  readonly endMs: number;
  type(): 'timeRange';
  begin(): number;
  end(): number;
  timeRange(): TimeRange;
  duration(): number;
  toJSON(): { start: number; end: number };
}

/** A labelled span, as pond-ts `Interval`. */
export declare class Interval {
  constructor(
    input:
      | readonly [string | number, number | Date, number | Date]
      | {
          readonly value: string | number;
          readonly start: number | Date;
          readonly end: number | Date;
        },
  );
  readonly kind: 'interval';
  readonly value: string | number;
  readonly start: number;
  readonly endMs: number;
  type(): 'interval';
  begin(): number;
  end(): number;
  valueOf(): string | number;
  timeRange(): TimeRange;
}

/** One row, as pond-ts `Event` (cut down). */
export declare class Event {
  private constructor();
  key(): Time | TimeRange | Interval;
  type(): KeyKind;
  /** The cell of `column`; `undefined` for a gap or an unknown column. */
  get(column: string): Cell | undefined;
  /** Every value cell by column name (frozen). */
  data(): Readonly<Record<string, Cell | undefined>>;
  begin(): number;
  end(): number;
  timeRange(): TimeRange;
  /** A copy with `column` set to `value`. */
  set(column: string, value: Cell | undefined): Event;
  /** `[key, ...cells]` in `schema` order (`null` for a gap). */
  toJsonRow(schema: Schema): [KeyData, ...(Cell | null)[]];
}

// ---- sequences and expressions ---------------------------------------------

/** A sequence of buckets: `Sequence.every('1m')`, `Sequence.calendar('day', { timeZone })`. */
export declare class Sequence {
  /** @internal Use `every` or `calendar`. */
  constructor(spec: unknown);
  static every(duration: Duration): Sequence;
  static calendar(
    unit: 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year',
    options?: { timeZone?: string; weekStartsOn?: number },
  ): Sequence;
  toJSON(): { sequence: unknown };
}

/** An expression node, as pond-ts writes it (`toJSON()`). */
export type ExprNode =
  | { readonly col: string }
  | { readonly lit: Scalar }
  | {
      readonly op: string;
      readonly args: readonly ExprNode[];
      readonly values?: readonly Scalar[];
    };

/** An operand: an expression or a fixed number, text or true/false. */
export type Operand = Expr | Scalar;

/**
 * A per-row rule written as data, as pond-ts `col('v').gt(0)`. It runs
 * inside pond-rs over whole columns, with no JavaScript call per row.
 */
export declare class Expr {
  private constructor();
  readonly node: ExprNode;
  eq(x: Operand): Expr;
  ne(x: Operand): Expr;
  gt(x: Operand): Expr;
  ge(x: Operand): Expr;
  lt(x: Operand): Expr;
  le(x: Operand): Expr;
  in(values: readonly Scalar[]): Expr;
  and(x: Operand): Expr;
  or(x: Operand): Expr;
  not(): Expr;
  add(x: Operand): Expr;
  sub(x: Operand): Expr;
  mul(x: Operand): Expr;
  div(x: Operand): Expr;
  neg(): Expr;
  abs(): Expr;
  sqrt(): Expr;
  sin(): Expr;
  cos(): Expr;
  asin(): Expr;
  atan2(x: Operand): Expr;
  pow(exponent: Operand): Expr;
  isMissing(): Expr;
  fill(x: Operand): Expr;
  toJSON(): ExprNode;
}

/** The value of column `name` in each row. */
export declare function col(name: string): Expr;
/** A fixed value: `lit(100).sub(col('pct'))`. */
export declare function lit(value: Scalar): Expr;
/** `then` where `condition` is true, else `otherwise` (a gap counts as false). */
export declare function when(
  condition: Operand,
  then: Operand,
  otherwise: Operand,
): Expr;

// ---- the batch series ------------------------------------------------------

/** A row test: an expression (fast) or a function called with each row. */
export type RowTest = Expr | ((event: Event, index: number) => unknown);

/** `mapColumns`: per column, an expression or a function of the cell. */
export interface ColumnMapping {
  readonly [column: string]:
    | Expr
    | ((value: number) => number | undefined)
    | ((value: string) => string | undefined)
    | ((value: boolean) => boolean | undefined);
}

/**
 * The methods a series and a `partitionBy` view share: each returns a new
 * series (or view) and leaves this one as it was.
 */
export interface SeriesSteps<Out> {
  /** A study from the catalog by name, with `@pond-ts/financial`'s options. */
  study<N extends StudyName>(name: N, ...options: StudyOptionsArg<N>): Out;
  /** A rolling window of `duration`, one output row per input row. */
  rolling(
    window: Duration,
    mapping: AggregateMapping,
    options?: RollingOptions,
  ): Out;
  /** A rolling window of the last `count` rows. */
  rolling(
    window: { readonly count: number },
    mapping: AggregateMapping,
    options?: RollingOptions,
  ): Out;
  /** A rolling window read at each point of `sequence`. */
  rolling(
    sequence: Sequence,
    window: Duration,
    mapping: AggregateMapping,
    options?: RollingOverOptions,
  ): Out;
  /** One row per bucket of `sequence`. */
  aggregate(sequence: Sequence, mapping: AggregateMapping): Out;
  diff(columns: Columns, options?: ChangeOptions): Out;
  rate(columns: Columns, options?: ChangeOptions): Out;
  pctChange(columns: Columns, options?: ChangeOptions): Out;
  cumulative(spec: { readonly [column: string]: CumulativeSpec }): Out;
  shift(columns: Columns, rows: number): Out;
  /** Fill gaps: one strategy for every column, or one per column. */
  fill(
    strategy: FillStrategy | { readonly [column: string]: FillStrategy },
    options?: FillOptions,
  ): Out;
  align(sequence: Sequence, options?: AlignOptions): Out;
  materialize(sequence: Sequence, options?: MaterializeOptions): Out;
  dedupe(options?: DedupeOptions): Out;
  smooth(
    column: string,
    method: 'ema' | 'movingAverage' | 'loess',
    options?: SmoothOptions,
  ): Out;
  baseline(column: string, options: BaselineOptions): Out;
  outliers(column: string, options: OutliersOptions): Out;
  sample(options: SampleOptions): Out;
  /** A running fold over `column`: `step(acc, value, index)` returns `[acc, output]`. */
  scan<A>(
    column: string,
    step: (acc: A, value: number, index: number) => readonly [A, number],
    init: A,
    options?: { readonly output?: string },
  ): Out;
}

/** The financial studies as methods (`s.rsi({ period: 14 })`). */
export type StudyMethods<Out> = {
  [N in StudyName]: (...options: StudyOptionsArg<N>) => Out;
};

/**
 * A series in WebAssembly memory, with pond-ts's method names and argument
 * shapes. Call `free()` when done with it.
 */
export declare class TimeSeries {
  /** `new TimeSeries({ name, schema, rows })`, times in ms. */
  constructor(input: TimeSeriesInput);
  /** pond-ts's `toJSON()` shape; times as ms or as text. */
  static fromJSON(
    input: TimeSeriesJsonInput,
    options?: { parse?: { timeZone?: string } },
  ): TimeSeries;
  /** An Arrow IPC file (bytes). `key` names the key field (default `'time'`). */
  static fromArrow(
    bytes: Uint8Array,
    options?: { name?: string; key?: string; keyKind?: KeyKind },
  ): TimeSeries;
  /** Join series on their keys. */
  static joinMany(
    list: readonly TimeSeries[],
    options?: JoinOptions,
  ): TimeSeries;
  /** Rows of several series with the same schema, in key order. */
  static concat(list: readonly TimeSeries[]): TimeSeries;

  /** @internal The series' slot in WebAssembly memory. */
  readonly id: number;
  readonly length: number;
  /** The schema, as pond-ts `series.schema`. */
  readonly schema: Schema;
  /** Release the series' memory now. It cannot be used after. */
  free(): void;

  toJSON(options?: { rowFormat?: 'array' }): TimeSeriesJson;
  toJSON(options: { rowFormat: 'object' }): TimeSeriesObjectJson;
  /**
   * pond-ts's `toColumns()`. pond-ts's `TimeSeries.fromColumns` reads it
   * back (number and text columns), which is how a series reaches
   * `@pond-ts/charts`. In TypeScript, say the series holds only those:
   * `TimeSeries.fromColumns(rs.toColumns<'number' | 'string'>())`. The type
   * argument is not checked (pond-ts's `fromColumns` throws at runtime on
   * a true/false or list column).
   */
  toColumns<K extends ValueKind = ValueKind>(): TimeSeriesColumns<K>;
  /** The series as an Arrow IPC file (bytes). */
  toArrow(): Uint8Array;
  /** One number column's values (NaN for a gap). */
  numbers(column: string): Float64Array;
  /** The key's times (starts, for spans) in ms. */
  times(): Float64Array;

  /** Split by column(s): chain steps, then `collect()` or `toMap()`. */
  partitionBy(by: Columns): PartitionedSeries;
  /** One series per value of `column`, keyed by the value as text. */
  groupBy(column: string): Map<string, TimeSeries>;

  /** Reducers over the whole series, as one record. */
  reduce(mapping: AggregateMapping): ReducedRecord;
  /** Bins along a value column, one record per bin. */
  byColumn(
    column: string,
    bins: Bins,
    mapping: AggregateMapping,
  ): ReducedRecord[];
  /** A window of `radius` around each value of a column, one record per row. */
  rollingByColumn(
    column: string,
    spec: RollingByColumnSpec,
    mapping: AggregateMapping,
  ): ReducedRecord[];

  /** The rows in the last `duration`. */
  tail(duration: Duration): TimeSeries;
  overlapping(key: KeyLike): TimeSeries;
  containedBy(key: KeyLike): TimeSeries;
  trim(key: KeyLike): TimeSeries;
  before(key: KeyLike): TimeSeries;
  after(key: KeyLike): TimeSeries;
  within(start: number, end: number): TimeSeries;
  asTimeRange(): TimeSeries;
  /** Interval keys labelled `label`, or by `label(range, index)`. */
  asInterval(
    label:
      | string
      | number
      | ((range: TimeRange, index: number) => string | number),
  ): TimeSeries;
  /** Time-range or interval keys to points, at their `begin` (default), `center` or `end`. */
  asTime(options?: { readonly at?: SamplePoint }): TimeSeries;
  offsetTime(by: Duration): TimeSeries;

  join(other: TimeSeries, options?: JoinOptions): TimeSeries;
  arrayContains(column: string, value: Scalar): TimeSeries;
  arrayContainsAll(column: string, values: readonly Scalar[]): TimeSeries;
  arrayContainsAny(column: string, values: readonly Scalar[]): TimeSeries;
  arrayAggregate(
    column: string,
    reducer: Reducer,
    options?: ArrayOptions,
  ): TimeSeries;
  arrayExplode(column: string, options?: ArrayOptions): TimeSeries;
  pivotByGroup(
    groupColumn: string,
    valueColumn: string,
    options?: PivotOptions,
  ): TimeSeries;
  select(...columns: string[]): TimeSeries;
  rename(mapping: { readonly [from: string]: string }): TimeSeries;
  slice(begin?: number, end?: number): TimeSeries;
  /** A column from an expression, or from a list of numbers (one per row). */
  withColumn(
    name: string,
    values: Expr | readonly (number | null | undefined)[],
  ): TimeSeries;
  /** Combine `columns` into `output` with `fn` (the old columns go unless `append`). */
  collapse(
    columns: Columns,
    output: string,
    fn: (values: Record<string, Cell | undefined>) => Scalar | undefined,
    options?: { readonly append?: boolean },
  ): TimeSeries;
  filter(test: RowTest): TimeSeries;
  find(test: RowTest): Event | undefined;
  some(test: RowTest): boolean;
  every(test: RowTest): boolean;
  mapColumns(mapping: ColumnMapping): TimeSeries;

  /** The row at `index` (negative counts from the end). */
  at(index: number): Event | undefined;
  /** Where `key` would go in the sorted keys. */
  bisect(key: KeyLike): number;
  includesKey(key: KeyLike): boolean;
  atOrBefore(key: KeyLike): Event | undefined;
  atOrAfter(key: KeyLike): Event | undefined;
  nearest(key: KeyLike): Event | undefined;
  overlaps(key: KeyLike): boolean;
  contains(key: KeyLike): boolean;
  intersection(key: KeyLike): TimeRange | undefined;
  /** The span the series covers, or `undefined` when it is empty. */
  timeRange(): TimeRange | undefined;

  /** @internal Run any supported pond-ts method by name. */
  call(op: string, ...args: unknown[]): unknown;
}
export interface TimeSeries
  extends SeriesSteps<TimeSeries>, StudyMethods<TimeSeries> {}

/** The per-partition view `partitionBy` returns: chain steps, then `collect()` or `toMap()`. */
export declare class PartitionedSeries {
  private constructor();
  /** Every partition's rows, in key order, as one series. */
  collect(): TimeSeries;
  /** Each partition's series, keyed by its value as text. */
  toMap(): Map<string, TimeSeries>;
}
export interface PartitionedSeries
  extends SeriesSteps<PartitionedSeries>, StudyMethods<PartitionedSeries> {}

// ---- studies and trading calendars -----------------------------------------

/** One option of a study, as the catalog describes it. */
export type StudyParam =
  | {
      readonly kind: 'number' | 'integer';
      readonly default?: number;
      readonly example?: number;
      readonly optional?: true;
      readonly requires?: string;
      readonly min?: number;
      readonly max?: number;
      readonly suggest?: readonly [number, number];
    }
  | {
      readonly kind: 'enum';
      readonly default?: string;
      readonly example?: string;
      readonly of: readonly string[];
      readonly optional?: true;
      readonly requires?: string;
    };

/** A study's descriptor, as `@pond-ts/financial/catalog`'s `STUDIES` (without `run`). */
export interface StudyDescriptor {
  readonly name: StudyName;
  readonly family: string;
  readonly summary: string;
  readonly inputs: readonly {
    readonly role: string;
    readonly default?: string;
  }[];
  readonly params: Readonly<Record<string, StudyParam>>;
  readonly naming: {
    readonly kind: 'output' | 'prefix';
    readonly default: string;
  };
  readonly outputs: readonly { readonly id: string; readonly unit: string }[];
  readonly anchor?: 'session' | 'time';
}

/** Every study's descriptor, in catalog order. */
export declare function studies(): StudyDescriptor[];
/** One study's descriptor, or `undefined`. */
export declare function studyInfo(name: string): StudyDescriptor | undefined;

/** A trading session: its date, open and close (ms), and breaks. */
export interface Session {
  readonly date: string;
  readonly open: number;
  readonly close: number;
  readonly breaks?: readonly { readonly start: number; readonly end: number }[];
}

/** Rules a calendar's sessions are made from. */
export interface SessionRules {
  /** The exchange's IANA zone. */
  readonly timeZone: string;
  /** `'HH:MM'` local time. */
  readonly open: string;
  readonly close: string;
  /** Trading weekdays, 1 Monday to 7 Sunday. */
  readonly weekmask?: readonly number[];
  readonly breaks?: readonly { readonly start: string; readonly end: string }[];
  /** `YYYY-MM-DD` dates with no session. */
  readonly holidays?: readonly string[];
  readonly earlyCloses?: readonly {
    readonly date: string;
    readonly close: string;
  }[];
}

/** Dates to make sessions for: `YYYY-MM-DD` text, ms or `Date`s. */
export interface DateRange {
  readonly from: string | number | Date;
  readonly to: string | number | Date;
}

/** pond-ts `generateSessions(rules, { from, to })`: the sessions rules give, unchecked. */
export declare function generateSessions(
  rules: SessionRules,
  dates: DateRange,
): Session[];

/**
 * Exchange sessions, as pond-ts `TradingCalendar` (cut down). Lives in
 * WebAssembly memory: call `free()` when done.
 */
export declare class TradingCalendar {
  private constructor();
  static fromRules(rules: SessionRules, dates: DateRange): TradingCalendar;
  static fromSessions(
    sessions: Iterable<Session>,
    options?: { timeZone?: string },
  ): TradingCalendar;
  /** @internal The calendar's slot in WebAssembly memory. */
  readonly id: number;
  readonly length: number;
  /** The exchange's zone (the rules' zone), or `undefined`. */
  readonly timeZone: string | undefined;
  free(): void;
  sessions(): Session[];
  /** The session on `date` (`YYYY-MM-DD`), or `undefined`. */
  sessionOn(date: string): Session | undefined;
  isTradingDay(date: string): boolean;
  sessionContaining(instant: number | Date): Session | undefined;
  isOpen(instant: number | Date): boolean;
  sessionsInRange(range: {
    readonly start: number | Date;
    readonly end: number | Date;
  }): Session[];
  nextSession(ref: number | Date | string): Session | undefined;
  previousSession(ref: number | Date | string): Session | undefined;
  /** `series` with a session-id column (each row's session open; a gap in closed time). */
  tagSessions(
    series: TimeSeries,
    options?: { readonly column?: string; readonly stamped?: 'open' | 'close' },
  ): TimeSeries;
}

/** How a session study finds each bar's session. */
export type SessionAnchor =
  | {
      /** A calendar, or a list of sessions. */
      readonly sessions: TradingCalendar | readonly Session[];
      readonly session?: never;
      /** `'open'` (default): a session is `[open, close)`; `'close'`: `(open, close]`. */
      readonly stamped?: 'open' | 'close';
    }
  | {
      readonly sessions?: never;
      /** A session-id column, as `tagSessions` appends. */
      readonly session: string;
      readonly stamped?: never;
    };

// ---- live series -----------------------------------------------------------

/** When a rolling window or a reduce emits, as pond-ts `Trigger`. */
export declare class Trigger<
  K extends 'event' | 'count' | 'clock' = 'event' | 'count' | 'clock',
> {
  private constructor();
  readonly kind: K;
  /** After every event (the default). */
  static event(): Trigger<'event'>;
  /** When a clock bucket of `duration` ends. */
  static every(duration: Duration): Trigger<'clock'>;
  /** Every `n` events. */
  static count(n: number): Trigger<'count'>;
  /** When a bucket of `sequence` ends. */
  static clock(sequence: Sequence): Trigger<'clock'>;
  toJSON(): unknown;
}

/** A live series' (and a partition's) options. */
export interface LiveOptions {
  readonly ordering?: 'strict' | 'drop' | 'reorder';
  /** With `ordering: 'reorder'`: how late an event may be. */
  readonly graceWindow?: Duration;
  readonly retention?: {
    readonly maxEvents?: number;
    readonly maxAge?: Duration;
  };
}
export interface LiveSeriesOptions extends LiveOptions {
  readonly name?: string;
  readonly schema: SchemaInput;
}

/** How much history a rolling window keeps for readers. */
export type RollingHistory =
  | boolean
  | { readonly maxEvents?: number; readonly maxAge?: Duration };

export interface LiveRollingOptions {
  readonly minSamples?: number;
  readonly trigger?: Trigger;
  readonly history?: RollingHistory;
}

/** `rolling({ '1m': mapping, '5m': { mapping, minSamples } })`: several windows at once. */
export interface RollingWindows {
  readonly [window: string]:
    | AggregateMapping
    | { readonly mapping: AggregateMapping; readonly minSamples?: number };
}

/** What a listener gets for each kind of output. */
export interface LiveOutputs {
  event: Event;
  batch: Event[];
  evict: Event[];
  bucket: Event;
  update: Readonly<Record<string, Cell | undefined>> | undefined;
  /** The rows a series took in one push, as a batch series. */
  columns: TimeSeries;
}
export type LiveOutputKind = keyof LiveOutputs;

/** A row pushed into a live series: `[key, ...cells]`, `undefined` for a gap. */
export type LiveRow = readonly [KeyData | Date, ...(Cell | undefined)[]];

/** The live builders; each returns the node it builds (`View` and so on). */
export interface LiveSteps<View, Agg, Roll, Fused, Red> {
  filter(test: Expr | ((event: Event) => unknown)): View;
  /** A new event per event; it must keep the event's key. */
  map(fn: (event: Event) => Event): View;
  select(...columns: (string | readonly string[])[]): View;
  sample(options: { readonly stride: number }): View;
  /** The last `duration` of events, or the last `n` events. */
  window(size: Duration): View;
  diff(columns: Columns, options?: { readonly drop?: boolean }): View;
  rate(columns: Columns, options?: { readonly drop?: boolean }): View;
  pctChange(columns: Columns, options?: { readonly drop?: boolean }): View;
  fill(
    strategy: FillStrategy | { readonly [column: string]: FillStrategy },
    options?: { readonly limit?: number },
  ): View;
  /** Running reducers, or one column folded by `(acc, value) => acc`. */
  cumulative(
    spec:
      | { readonly [column: string]: CumulativeSpec }
      | { readonly [column: string]: (acc: number, value: number) => number },
  ): View;
  aggregate(
    sequence: Sequence,
    mapping: AggregateMapping,
    options?: { readonly grace?: Duration },
  ): Agg;
  /** One window: a duration, or a count of events. */
  rolling(
    window: Duration,
    mapping: AggregateMapping,
    options?: LiveRollingOptions,
  ): Roll;
  /** Several windows at once. */
  rolling(windows: RollingWindows, options?: LiveRollingOptions): Fused;
  reduce(
    mapping: AggregateMapping,
    options?: { readonly trigger?: Trigger },
  ): Red;
}

/** The builders on a single (not partitioned) node. */
export type LiveNodeSteps = LiveSteps<
  LiveView,
  LiveAggregation,
  LiveRollingAggregation,
  LiveFusedRolling,
  LiveReduce
>;

/** What every live node has: reading and listening. */
declare abstract class LiveNode<Kinds extends LiveOutputKind = LiveOutputKind> {
  protected constructor();
  readonly name: string;
  /** The node's columns, key first. */
  readonly schema: Schema;
  readonly length: number;
  /** The event at `index` (negative counts from the end), or `undefined`. */
  at(index: number): Event | undefined;
  first(): Event | undefined;
  last(): Event | undefined;
  /** Call `fn` with each output of `type`; returns a function that removes it. */
  on<K extends Kinds>(type: K, fn: (value: LiveOutputs[K]) => void): () => void;
  /** Stop this node; nodes built on it keep what they hold. */
  dispose(): void;
}
export type { LiveNode };

/** Series counters. */
export interface LiveSeriesStats {
  ingested: number;
  evicted: number;
  rejected: number;
  length: number;
  earliestTs?: number;
  latestTs?: number;
}

/**
 * A series that takes events as they arrive, as pond-ts `LiveSeries`. It
 * owns every node built on it; call `free()` when done.
 */
export declare class LiveSeries extends LiveNode<
  'event' | 'batch' | 'columns' | 'evict'
> {
  constructor(options: LiveSeriesOptions);
  /** Push rows (`[key, ...values]`, `undefined` for a gap). */
  push(...rows: LiveRow[]): void;
  /** Push rows as one batch: all or nothing. */
  pushMany(rows: readonly LiveRow[]): void;
  /** Push rows written as pond-ts JSON (times as ms or UTC text, `null` for a gap). */
  pushJson(rows: readonly JsonRow[], options?: { timeZone?: 'UTC' }): void;
  /** Remove every event. */
  clear(): void;
  /** What the series holds now, as a batch series. */
  toTimeSeries(): TimeSeries;
  stats(): LiveSeriesStats;
  /** Split by `column`: build on the result (per partition), then `collect()`. */
  partitionBy(
    column: string,
    options?: LiveOptions & { readonly groups?: readonly string[] },
  ): LivePartitionedSeries;
  /** Release the series and every node built on it. */
  free(): void;
}
export interface LiveSeries extends LiveNodeSteps {}

/** A node that passes events through (filter, map, diff, fill, window, …). */
export declare class LiveView extends LiveNode<'event' | 'evict'> {
  toTimeSeries(): TimeSeries;
  count(): number;
}
export interface LiveView extends LiveNodeSteps {}

/** Buckets of a sequence, as pond-ts `LiveAggregation`. */
export declare class LiveAggregation extends LiveNode<
  'event' | 'bucket' | 'update'
> {
  /** `new LiveAggregation(source, sequence, mapping, { grace })`. */
  constructor(
    source: LiveNode,
    sequence: Sequence,
    mapping: AggregateMapping,
    options?: { readonly grace?: Duration },
  );
  /** Closed buckets, as a batch series. */
  closed(): TimeSeries;
  /** Closed buckets and the open one, as a batch series. */
  snapshot(): TimeSeries;
  readonly hasOpenBucket: boolean;
  readonly closedCount: number;
  stats(): {
    eventsObserved: number;
    bucketsClosed: number;
    openBuckets: number;
    openBucketStart?: number;
  };
}
export interface LiveAggregation extends LiveNodeSteps {}

/** Rolling-window counters. */
export interface LiveRollingStats {
  eventsObserved: number;
  evictions: number;
  emissions: number;
  windowSize: number;
  windowsCount?: number;
}

/** A rolling window, as pond-ts `LiveRollingAggregation`. */
export declare class LiveRollingAggregation extends LiveNode<
  'event' | 'update'
> {
  /** The value columns as they stand now (`undefined` for a gap). */
  value(): Readonly<Record<string, Cell | undefined>>;
  readonly windowSize: number;
  stats(): LiveRollingStats;
}
export interface LiveRollingAggregation extends LiveNodeSteps {}

/** Several rolling windows at once, as pond-ts `LiveFusedRolling`. */
export declare class LiveFusedRolling extends LiveNode<'event'> {
  value(): Readonly<Record<string, Cell | undefined>>;
  readonly windowSize: number;
  stats(): LiveRollingStats;
}
export interface LiveFusedRolling extends LiveNodeSteps {}

/** Reducers over everything the source holds, as pond-ts `LiveReduce`. */
export declare class LiveReduce extends LiveNode<'event'> {
  value(): Readonly<Record<string, Cell | undefined>>;
  stats(): {
    eventsObserved: number;
    evictions: number;
    emissions: number;
    bufferSize: number;
  };
}
export interface LiveReduce extends LiveNodeSteps {}

/** Any single (not partitioned) live node. */
export type LiveSingleNode =
  | LiveSeries
  | LiveView
  | LiveAggregation
  | LiveRollingAggregation
  | LiveFusedRolling
  | LiveReduce;

/** Options for gathering partitions into one series. */
export type CollectOptions = LiveOptions & { readonly name?: string };

/** The steps an `apply` factory records (no branching per partition). */
export interface LiveChain extends LiveSteps<
  LiveChain,
  LiveChain,
  LiveChain,
  LiveChain,
  LiveChain
> {}

/** What a partitioned node has: its partitions, and gathering them. */
declare abstract class LivePartitionedNode extends LiveNode<never> {
  /** One series of what every partition holds (or its chain emits). */
  collect(options?: CollectOptions): LiveSeries;
  /** `factory(sub)` chained on each partition, gathered into one series. */
  apply(
    factory: (sub: LiveChain) => LiveChain,
    options?: CollectOptions,
  ): LiveSeries;
  /** A rolling window per partition on a clock: one node over every partition. */
  rolling(
    window: Duration,
    mapping: AggregateMapping,
    options: LiveRollingOptions & { readonly trigger: Trigger<'clock'> },
  ): LivePartitionedSyncRolling;
  /** A rolling window built on each partition. */
  rolling(
    window: Duration,
    mapping: AggregateMapping,
    options?: LiveRollingOptions,
  ): LivePartitionedView;
  /** Several windows per partition, as one node. */
  rolling(
    windows: RollingWindows,
    options?: LiveRollingOptions,
  ): LivePartitionedFusedRolling;
}
export type { LivePartitionedNode };

/** The builders on a partitioned node: each builds on every partition. */
export type LivePartitionedSteps = Omit<
  LiveSteps<
    LivePartitionedView,
    LivePartitionedView,
    LivePartitionedView,
    LivePartitionedFusedRolling,
    LivePartitionedView
  >,
  'rolling'
>;

/** Events split by a column, as pond-ts `LivePartitionedSeries`. */
export declare class LivePartitionedSeries extends LivePartitionedNode {
  /** Each partition value with its series. */
  toMap(): Map<string, LiveSeries>;
  stats(): { partitions: number; eventsRouted: number };
}
export interface LivePartitionedSeries extends LivePartitionedSteps {}

/** A chain built on every partition, as pond-ts `LivePartitionedView`. */
export declare class LivePartitionedView extends LivePartitionedNode {
  /** Each partition value with its chain's last node. */
  toMap(): Map<string, LiveSingleNode>;
}
export interface LivePartitionedView extends LivePartitionedSteps {}

/** Rolling windows per partition on a clock, as pond-ts `LivePartitionedFusedRolling`. */
export declare class LivePartitionedFusedRolling extends LiveNode<'event'> {
  stats(): {
    partitions: number;
    eventsObserved: number;
    emissions: number;
    windowSize: number;
  };
}
/** A rolling window per partition on a clock, as pond-ts `LivePartitionedSyncRolling`. */
export declare class LivePartitionedSyncRolling extends LiveNode<'event'> {
  stats(): {
    partitions: number;
    eventsObserved: number;
    emissions: number;
    windowSize: number;
  };
}

// ---- module ----------------------------------------------------------------

/** The pond-rs version inside. */
export declare const version: string;
/** @internal How many series are alive in WebAssembly memory. */
export declare function alive(): number;
/** @internal How many live series are alive in WebAssembly memory. */
export declare function livesAlive(): number;
/** @internal How many calendars are alive in WebAssembly memory. */
export declare function calendarsAlive(): number;

// ---- study options (generated: node scripts/types.mjs) ---------------------
// @generated-begin

/** Every study in the catalog, by name. */
export type StudyName =
  | 'sma'
  | 'ema'
  | 'movingAverage'
  | 'macd'
  | 'movingAverageCross'
  | 'movingAverageDeviation'
  | 'guppy'
  | 'rainbow'
  | 'rainbowOscillator'
  | 'trix'
  | 'schaffTrendCycle'
  | 'detrendedPriceOscillator'
  | 'disparityIndex'
  | 'coppock'
  | 'kst'
  | 'specialK'
  | 'priceOscillator'
  | 'priceMomentumOscillator'
  | 'bollinger'
  | 'bollingerBandwidth'
  | 'bollingerPercentB'
  | 'keltner'
  | 'starcBands'
  | 'atrBands'
  | 'donchian'
  | 'highLowBands'
  | 'primeNumberBands'
  | 'envelope'
  | 'rsi'
  | 'stochastic'
  | 'stochasticMomentumIndex'
  | 'stochasticRsi'
  | 'williamsR'
  | 'chandeMomentum'
  | 'momentum'
  | 'percentChange'
  | 'intradayMomentumIndex'
  | 'awesomeOscillator'
  | 'ultimateOscillator'
  | 'commodityChannelIndex'
  | 'fisherTransform'
  | 'psychologicalLine'
  | 'prettyGoodOscillator'
  | 'primeNumberOscillator'
  | 'qstick'
  | 'relativeVigorIndex'
  | 'centerOfGravity'
  | 'chandeForecastOscillator'
  | 'trueStrengthIndex'
  | 'directionalMovement'
  | 'aroon'
  | 'vortex'
  | 'verticalHorizontalFilter'
  | 'randomWalkIndex'
  | 'superTrend'
  | 'parabolicSar'
  | 'atrTrailingStop'
  | 'zigZag'
  | 'ichimoku'
  | 'elderImpulse'
  | 'elderRay'
  | 'trendIntensityIndex'
  | 'ravi'
  | 'swingIndex'
  | 'accumulativeSwingIndex'
  | 'atr'
  | 'historicalVolatility'
  | 'chaikinVolatility'
  | 'massIndex'
  | 'choppinessIndex'
  | 'gopalakrishnanRangeIndex'
  | 'ulcerIndex'
  | 'relativeVolatilityIndex'
  | 'obv'
  | 'accumulationDistribution'
  | 'priceVolumeTrend'
  | 'chaikinMoneyFlow'
  | 'chaikinOscillator'
  | 'moneyFlowIndex'
  | 'twiggsMoneyFlow'
  | 'forceIndex'
  | 'easeOfMovement'
  | 'klinger'
  | 'volumeOscillator'
  | 'tradeVolumeIndex'
  | 'negativeVolumeIndex'
  | 'positiveVolumeIndex'
  | 'marketFacilitationIndex'
  | 'shinoharaIntensityRatio'
  | 'vwap'
  | 'anchoredVwap'
  | 'linearRegression'
  | 'timeSeriesForecast'
  | 'beta'
  | 'correlation'
  | 'priceRelative'
  | 'performanceIndex'
  | 'zScore'
  | 'rollingStdev'
  | 'rollingMin'
  | 'rollingMax'
  | 'rollingPercentile'
  | 'typicalPrice'
  | 'medianPrice'
  | 'weightedClose'
  | 'averagePrice'
  | 'balanceOfPower'
  | 'sessionVwap'
  | 'pivotPoints';

/** Each study's options, as `@pond-ts/financial`'s. */
export interface StudyOptions {
  /** Simple moving average of a column. */
  sma: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** The output column (default 'sma'). */
    readonly output?: string;
  };
  /** Exponential moving average, span convention (α = 2/(period+1)). */
  ema: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** The output column (default 'ema'). */
    readonly output?: string;
  };
  /** Moving average of a selectable type (the shared MaType menu). */
  movingAverage: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** default "sma". */
    readonly type?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output column (default 'ma'). */
    readonly output?: string;
  };
  /** Appel's MACD — a fast/slow EMA spread with its signal line. */
  macd: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 12; at least 1; a whole number. */
    readonly fastPeriod?: number;
    /** default 26; a whole number. */
    readonly slowPeriod?: number;
    /** default 9; at least 1; a whole number. */
    readonly signalPeriod?: number;
    /** The output columns' prefix (default 'macd'). */
    readonly prefix?: string;
  };
  /** Fast/slow moving-average crossings as a +1/−1 event column. */
  movingAverageCross: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 10; at least 1; a whole number. */
    readonly fastPeriod?: number;
    /** default 30; a whole number. */
    readonly slowPeriod?: number;
    /** default "sma". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output column (default 'maCross'). */
    readonly output?: string;
  };
  /** How far price sits from its moving average, in price units. */
  movingAverageDeviation: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** default "sma". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output column (default 'maDev'). */
    readonly output?: string;
  };
  /** Guppy's GMMA — the fixed twelve-average trader/investor ribbon. */
  guppy: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default "ema". */
    readonly type?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output columns' prefix (default 'gmma'). */
    readonly prefix?: string;
  };
  /** Widner's Rainbow — ten recursively smoothed moving averages. */
  rainbow: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 2; at least 1; a whole number. */
    readonly period?: number;
    /** default "sma". */
    readonly type?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output columns' prefix (default 'rainbow'). */
    readonly prefix?: string;
  };
  /** ChartIQ's rainbow oscillator, banded by the stack's own width. */
  rainbowOscillator: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 2; at least 1; a whole number. */
    readonly period?: number;
    /** default 10; at least 1; a whole number. */
    readonly lookback?: number;
    /** default "sma". */
    readonly type?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output columns' prefix (default 'rbo'). */
    readonly prefix?: string;
  };
  /** Hutson's TRIX — percent rate of change of a triple EMA. */
  trix: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 15; at least 1; a whole number. */
    readonly period?: number;
    /** default 9; at least 1; a whole number. */
    readonly signalPeriod?: number;
    /** The output columns' prefix (default 'trix'). */
    readonly prefix?: string;
  };
  /** Schaff's double stochastic of a MACD, bounded 0…100. */
  schaffTrendCycle: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 23; at least 1; a whole number. */
    readonly fastPeriod?: number;
    /** default 50; a whole number. */
    readonly slowPeriod?: number;
    /** default 10; at least 1; a whole number. */
    readonly cyclePeriod?: number;
    /** The output column (default 'stc'). */
    readonly output?: string;
  };
  /** Price less a moving average displaced ⌊period/2⌋+1 bars back. */
  detrendedPriceOscillator: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** default "sma". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output column (default 'dpo'). */
    readonly output?: string;
  };
  /** Nison's disparity — price against its moving average, in percent. */
  disparityIndex: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** default "sma". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output column (default 'disparity'). */
    readonly output?: string;
  };
  /** Coppock Curve — a WMA of two percent rates of change, summed. */
  coppock: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 1; a whole number. */
    readonly longPeriod?: number;
    /** default 11; at least 1; a whole number. */
    readonly shortPeriod?: number;
    /** default 10; at least 1; a whole number. */
    readonly wmaPeriod?: number;
    /** The output column (default 'coppock'). */
    readonly output?: string;
  };
  /** Pring's Know Sure Thing — four weighted smoothed percent ROCs. */
  kst: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 9; at least 1; a whole number. */
    readonly signalPeriod?: number;
    /** The output columns' prefix (default 'kst'). */
    readonly prefix?: string;
  };
  /** Pring's Special K — the KST extended to twelve terms. */
  specialK: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** The output column (default 'specialK'). */
    readonly output?: string;
  };
  /** Fast/slow MA spread, as a percent (PPO) or in points (APO). */
  priceOscillator: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 12; at least 1; a whole number. */
    readonly fastPeriod?: number;
    /** default 26; a whole number. */
    readonly slowPeriod?: number;
    /** default "ema". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** default "percent". */
    readonly mode?: 'percent' | 'absolute';
    /** The output column (default 'priceOsc'). */
    readonly output?: string;
  };
  /** DecisionPoint's PMO — a double-smoothed 1-bar percent ROC. */
  priceMomentumOscillator: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** The output columns' prefix (default 'pmo'). */
    readonly prefix?: string;
  };
  /** Bollinger Bands — an SMA middle band with bands at ±k·σ. */
  bollinger: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** default 2. */
    readonly stdDev?: number;
    /** The output columns' prefix (default 'bb'). */
    readonly prefix?: string;
  };
  /** Bollinger BandWidth — the channel's width in percent of price. */
  bollingerBandwidth: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** default 2. */
    readonly stdDev?: number;
    /** The output column (default 'bbWidth'). */
    readonly output?: string;
  };
  /** Bollinger %B — where price sits inside its own channel. */
  bollingerPercentB: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** default 2. */
    readonly stdDev?: number;
    /** The output column (default 'percentB'). */
    readonly output?: string;
  };
  /** Keltner Channel — an EMA of typical price with bands at ±k·ATR. */
  keltner: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** default 10; at least 1; a whole number. */
    readonly atrPeriod?: number;
    /** default 2. */
    readonly multiplier?: number;
    /** default "ema". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output columns' prefix (default 'kc'). */
    readonly prefix?: string;
  };
  /** STARC Bands (Stoller) — an MA of close with bands at ±k·ATR. */
  starcBands: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** default 15; at least 1; a whole number. */
    readonly atrPeriod?: number;
    /** default 2. */
    readonly multiplier?: number;
    /** default "sma". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output columns' prefix (default 'starc'). */
    readonly prefix?: string;
  };
  /** A field with volatility bands at ±k·ATR either side of it. */
  atrBands: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** default 2. */
    readonly multiplier?: number;
    /** The output columns' prefix (default 'atrb'). */
    readonly prefix?: string;
  };
  /** Donchian channel — the window's highest high and lowest low. */
  donchian: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'dc'). */
    readonly prefix?: string;
  };
  /** High Low Bands — a smoothed median price ±percent. */
  highLowBands: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 10; at least 1; a whole number. */
    readonly period?: number;
    /** default 1. */
    readonly percent?: number;
    /** default "trima". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output columns' prefix (default 'hlb'). */
    readonly prefix?: string;
  };
  /** The primes immediately bracketing each bar's high and low. */
  primeNumberBands: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** The output columns' prefix (default 'pnb'). */
    readonly prefix?: string;
  };
  /** Moving-average envelope — bands at ±percent of the centre line. */
  envelope: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** default 2.5. */
    readonly percent?: number;
    /** default "sma". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output columns' prefix (default 'env'). */
    readonly prefix?: string;
  };
  /** Wilder's relative strength index, bounded 0..100. */
  rsi: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'rsi'). */
    readonly output?: string;
  };
  /** Lane's stochastic — where the close sits in its recent range. */
  stochastic: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 1; a whole number. */
    readonly kPeriod?: number;
    /** default 3; at least 1; a whole number. */
    readonly slowing?: number;
    /** default 3; at least 1; a whole number. */
    readonly dPeriod?: number;
    /** The output columns' prefix (default 'stoch'). */
    readonly prefix?: string;
  };
  /** Blau's SMI — the close against the range midpoint, smoothed. */
  stochasticMomentumIndex: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 13; at least 1; a whole number. */
    readonly period?: number;
    /** default 25; at least 1; a whole number. */
    readonly longPeriod?: number;
    /** default 2; at least 1; a whole number. */
    readonly shortPeriod?: number;
    /** default 3; at least 1; a whole number. */
    readonly signalPeriod?: number;
    /** The output columns' prefix (default 'smi'). */
    readonly prefix?: string;
  };
  /** Chande & Kroll's stochastic of the RSI's own range. */
  stochasticRsi: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 1; a whole number. */
    readonly rsiPeriod?: number;
    /** default 14; at least 1; a whole number. */
    readonly stochPeriod?: number;
    /** default 3; at least 1; a whole number. */
    readonly kPeriod?: number;
    /** default 3; at least 1; a whole number. */
    readonly dPeriod?: number;
    /** The output columns' prefix (default 'stochRsi'). */
    readonly prefix?: string;
  };
  /** Williams %R — the close below the recent high, −100..0. */
  williamsR: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'williamsR'). */
    readonly output?: string;
  };
  /** Chande's momentum oscillator — unsmoothed up/down sums. */
  chandeMomentum: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'cmo'). */
    readonly output?: string;
  };
  /** The change from n bars ago, in the price’s own units. */
  momentum: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 10; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'momentum'). */
    readonly output?: string;
  };
  /** Percent change from n bars ago — the rate of change. */
  percentChange: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 1; at least 1; a whole number. */
    readonly periods?: number;
    /** The output column (default 'pctChange'). */
    readonly output?: string;
  };
  /** Chande's IMI — RSI's question asked of the candle body. */
  intradayMomentumIndex: {
    /** Column read as open (default 'open'). */
    readonly open?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'imi'). */
    readonly output?: string;
  };
  /** Bill Williams' AO — fast minus slow SMA of the median price. */
  awesomeOscillator: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 5; at least 1; a whole number. */
    readonly fastPeriod?: number;
    /** default 34; a whole number. */
    readonly slowPeriod?: number;
    /** The output column (default 'ao'). */
    readonly output?: string;
  };
  /** Williams' three-horizon buying pressure, weighted 4/2/1. */
  ultimateOscillator: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 7; at least 1; a whole number. */
    readonly shortPeriod?: number;
    /** default 14; a whole number. */
    readonly mediumPeriod?: number;
    /** default 28; a whole number. */
    readonly longPeriod?: number;
    /** The output column (default 'uo'). */
    readonly output?: string;
  };
  /** Lambert's CCI — typical price in mean absolute deviations. */
  commodityChannelIndex: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'cci'). */
    readonly output?: string;
  };
  /** Ehlers' Fisher transform of the normalised median price. */
  fisherTransform: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 10; at least 1; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'fisher'). */
    readonly prefix?: string;
  };
  /** The percentage of the last n bars that closed up. */
  psychologicalLine: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 12; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'psy'). */
    readonly output?: string;
  };
  /** Johnson's PGO — distance from the SMA in average true ranges. */
  prettyGoodOscillator: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'pgo'). */
    readonly output?: string;
  };
  /** The distance from the price to the prime nearest it. */
  primeNumberOscillator: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** The output column (default 'pno'). */
    readonly output?: string;
  };
  /** Chande's QStick — a moving average of the candle body. */
  qstick: {
    /** Column read as open (default 'open'). */
    readonly open?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 8; at least 1; a whole number. */
    readonly period?: number;
    /** default "sma". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output column (default 'qstick'). */
    readonly output?: string;
  };
  /** Ehlers' RVI — the body as a fraction of the range, plus signal. */
  relativeVigorIndex: {
    /** Column read as open (default 'open'). */
    readonly open?: string;
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 10; at least 1; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'rvi'). */
    readonly prefix?: string;
  };
  /** Ehlers' CG — where the window's price mass balances, in bars. */
  centerOfGravity: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 10; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'cog'). */
    readonly output?: string;
  };
  /** Chande's CFO — the price against its own forecast, in percent. */
  chandeForecastOscillator: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 2; a whole number. */
    readonly period?: number;
    /** The output column (default 'cfo'). */
    readonly output?: string;
  };
  /** Blau's TSI — double-smoothed net change over total change. */
  trueStrengthIndex: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 25; at least 1; a whole number. */
    readonly longPeriod?: number;
    /** default 13; at least 1; a whole number. */
    readonly shortPeriod?: number;
    /** default 7; at least 1; a whole number. */
    readonly signalPeriod?: number;
    /** The output columns' prefix (default 'tsi'). */
    readonly prefix?: string;
  };
  /** Wilder's directional movement system — +DI/−DI, DX, ADX, ADXR. */
  directionalMovement: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'dmi'). */
    readonly prefix?: string;
  };
  /** Chande's Aroon — how recently the window's extremes printed. */
  aroon: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 25; at least 1; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'aroon'). */
    readonly prefix?: string;
  };
  /** Vortex Indicator — Botes & Siepman's crossed movement pair. */
  vortex: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'vi'). */
    readonly prefix?: string;
  };
  /** Adam White's VHF — net movement over total movement. */
  verticalHorizontalFilter: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 28; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'vhf'). */
    readonly output?: string;
  };
  /** Poulos' RWI — the move in units of a random walk's reach. */
  randomWalkIndex: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 2; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'rwi'). */
    readonly prefix?: string;
  };
  /** SuperTrend — a ratcheting ATR band that flips with the close. */
  superTrend: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 10; at least 1; a whole number. */
    readonly period?: number;
    /** default 3. */
    readonly multiplier?: number;
    /** The output columns' prefix (default 'st'). */
    readonly prefix?: string;
  };
  /** Wilder's parabolic stop-and-reverse. */
  parabolicSar: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 0.02. */
    readonly step?: number;
    /** default 0.2. */
    readonly maxStep?: number;
    /** The output columns' prefix (default 'psar'). */
    readonly prefix?: string;
  };
  /** Vervoort's close-anchored ratcheting ATR stop. */
  atrTrailingStop: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** default 3. */
    readonly multiplier?: number;
    /** The output columns' prefix (default 'ats'). */
    readonly prefix?: string;
  };
  /** ZigZag — percent-reversal pivots and the line joining them. */
  zigZag: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 5. */
    readonly deviation?: number;
    /** The output columns' prefix (default 'zz'). */
    readonly prefix?: string;
  };
  /** Ichimoku Kinko Hyo — Hosoda's five lines. */
  ichimoku: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 9; at least 1; a whole number. */
    readonly conversionPeriod?: number;
    /** default 26; at least 1; a whole number. */
    readonly basePeriod?: number;
    /** default 52; at least 1; a whole number. */
    readonly spanBPeriod?: number;
    /** default 26; at least 1; a whole number. */
    readonly displacement?: number;
    /** The output columns' prefix (default 'ichi'). */
    readonly prefix?: string;
  };
  /** Elder's impulse system — EMA and MACD histogram agreeing. */
  elderImpulse: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 13; at least 1; a whole number. */
    readonly emaPeriod?: number;
    /** default 12; at least 1; a whole number. */
    readonly fastPeriod?: number;
    /** default 26; a whole number. */
    readonly slowPeriod?: number;
    /** default 9; at least 1; a whole number. */
    readonly signalPeriod?: number;
    /** The output column (default 'impulse'). */
    readonly output?: string;
  };
  /** Elder Ray — the bar's high and low against an EMA. */
  elderRay: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 13; at least 1; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'elder'). */
    readonly prefix?: string;
  };
  /** M. H. Pee's trend intensity index — deviations above an SMA. */
  trendIntensityIndex: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 30; at least 1; a whole number. */
    readonly period?: number;
    /** default 60; at least 1; a whole number. */
    readonly maPeriod?: number;
    /** The output column (default 'tii'). */
    readonly output?: string;
  };
  /** Chande's RAVI — the two SMAs' gap as a percent of the slow one. */
  ravi: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 7; at least 1; a whole number. */
    readonly shortPeriod?: number;
    /** default 65; at least 1; a whole number. */
    readonly longPeriod?: number;
    /** The output column (default 'ravi'). */
    readonly output?: string;
  };
  /** Wilder's swing index — one bar's move against the limit move. */
  swingIndex: {
    /** Column read as open (default 'open'). */
    readonly open?: string;
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    readonly limit: number;
    /** The output column (default 'si'). */
    readonly output?: string;
  };
  /** Wilder's accumulative swing index — the running swing total. */
  accumulativeSwingIndex: {
    /** Column read as open (default 'open'). */
    readonly open?: string;
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    readonly limit: number;
    /** The output column (default 'asi'). */
    readonly output?: string;
  };
  /** Wilder's average true range. */
  atr: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'atr'). */
    readonly output?: string;
  };
  /** Annualised σ of log returns, as a decimal. */
  historicalVolatility: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** default 252. */
    readonly annualize?: number;
    /** The output column (default 'hv'). */
    readonly output?: string;
  };
  /** Chaikin's percent rate of change of a smoothed bar range. */
  chaikinVolatility: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 10; at least 1; a whole number. */
    readonly period?: number;
    /** default 10; at least 1; a whole number. */
    readonly rocPeriod?: number;
    /** The output column (default 'chaikinVol'). */
    readonly output?: string;
  };
  /** Dorsey's range-expansion sum — the reversal bulge. */
  massIndex: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 9; at least 1; a whole number. */
    readonly emaPeriod?: number;
    /** default 25; at least 1; a whole number. */
    readonly sumPeriod?: number;
    /** The output column (default 'mass'). */
    readonly output?: string;
  };
  /** Dreiss' Choppiness Index — trending against ranging, 0..100. */
  choppinessIndex: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 14; at least 2; a whole number. */
    readonly period?: number;
    /** The output column (default 'chop'). */
    readonly output?: string;
  };
  /** GAPO — the window's high-low range, logged in base period. */
  gopalakrishnanRangeIndex: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** default 10; at least 2; a whole number. */
    readonly period?: number;
    /** The output column (default 'gapo'). */
    readonly output?: string;
  };
  /** Martin's RMS percent drawdown from the rolling peak. */
  ulcerIndex: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'ulcer'). */
    readonly output?: string;
  };
  /** Dorsey's RSI form applied to σ instead of price. */
  relativeVolatilityIndex: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** default 10; at least 1; a whole number. */
    readonly stdevPeriod?: number;
    /** The output column (default 'relVol'). */
    readonly output?: string;
  };
  /** Granville's running total of signed volume. */
  obv: {
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** The output column (default 'obv'). */
    readonly output?: string;
  };
  /** Chaikin's A/D line — volume signed by the close's place in the bar. */
  accumulationDistribution: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** The output column (default 'ad'). */
    readonly output?: string;
  };
  /** Running total of volume scaled by fractional price change. */
  priceVolumeTrend: {
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** The output column (default 'pvt'). */
    readonly output?: string;
  };
  /** Chaikin's A/D term as a volume-weighted mean over a window. */
  chaikinMoneyFlow: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'cmf'). */
    readonly output?: string;
  };
  /** MACD of the Accumulation/Distribution line. */
  chaikinOscillator: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 3; at least 1; a whole number. */
    readonly fastPeriod?: number;
    /** default 10; a whole number. */
    readonly slowPeriod?: number;
    /** The output column (default 'chaikinOsc'). */
    readonly output?: string;
  };
  /** RSI computed on money flow instead of price. */
  moneyFlowIndex: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'mfi'). */
    readonly output?: string;
  };
  /** Twiggs' money flow — true range, Wilder-smoothed. */
  twiggsMoneyFlow: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 21; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'tmf'). */
    readonly output?: string;
  };
  /** Elder's force index — price change times volume, EMA-smoothed. */
  forceIndex: {
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 13; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'force'). */
    readonly output?: string;
  };
  /** Arms' ease of movement — midpoint travel per unit of volume. */
  easeOfMovement: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 14; at least 1; a whole number. */
    readonly period?: number;
    /** default "sma". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** default 100000000. */
    readonly scale?: number;
    /** The output column (default 'eom'). */
    readonly output?: string;
  };
  /** Klinger's volume oscillator with its signal line. */
  klinger: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 34; at least 1; a whole number. */
    readonly fastPeriod?: number;
    /** default 55; a whole number. */
    readonly slowPeriod?: number;
    /** default 13; at least 1; a whole number. */
    readonly signalPeriod?: number;
    /** The output columns' prefix (default 'kvo'). */
    readonly prefix?: string;
  };
  /** Fast minus slow moving average of volume, as a percent. */
  volumeOscillator: {
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 5; at least 1; a whole number. */
    readonly fastPeriod?: number;
    /** default 10; a whole number. */
    readonly slowPeriod?: number;
    /** default "sma". */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output column (default 'volOsc'). */
    readonly output?: string;
  };
  /** Tick-direction volume accumulation (needs the instrument tick). */
  tradeVolumeIndex: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    readonly minTick: number;
    /** The output column (default 'tvi'). */
    readonly output?: string;
  };
  /** Fosback's index compounding returns on lower-volume bars. */
  negativeVolumeIndex: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 1000. */
    readonly start?: number;
    /** The output column (default 'nvi'). */
    readonly output?: string;
  };
  /** Fosback's index compounding returns on higher-volume bars. */
  positiveVolumeIndex: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** default 1000. */
    readonly start?: number;
    /** The output column (default 'pvi'). */
    readonly output?: string;
  };
  /** Bill Williams' price movement per unit of volume. */
  marketFacilitationIndex: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** The output column (default 'bwmfi'). */
    readonly output?: string;
  };
  /** Shinohara's strong and weak intensity ratios. */
  shinoharaIntensityRatio: {
    /** Column read as open (default 'open'). */
    readonly open?: string;
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default 26; at least 1; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'sir'). */
    readonly prefix?: string;
  };
  /** Volume-weighted average price over a trailing window. */
  vwap: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** The output column (default 'vwap'). */
    readonly output?: string;
  };
  /** VWAP accumulated from a user-chosen bar onward. */
  anchoredVwap: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** The output column (default 'avwap'). */
    readonly output?: string;
    /** The bar to start from: a time in ms, or a `Date`. */
    readonly anchor: number | Date;
  };
  /** Rolling OLS fit against the bar index, with slope, angle and R². */
  linearRegression: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 2; a whole number. */
    readonly period?: number;
    /** The output columns' prefix (default 'linreg'). */
    readonly prefix?: string;
  };
  /** The rolling OLS fit projected one bar past the window. */
  timeSeriesForecast: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** default 14; at least 2; a whole number. */
    readonly period?: number;
    /** The output column (default 'tsf'). */
    readonly output?: string;
  };
  /** Slope of a column's one-bar returns on a benchmark's. */
  beta: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** Column read as benchmark. */
    readonly benchmark: string;
    /** default 5; at least 2; a whole number. */
    readonly period?: number;
    /** The output column (default 'beta'). */
    readonly output?: string;
  };
  /** Rolling Pearson correlation against a benchmark column. */
  correlation: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** Column read as benchmark. */
    readonly benchmark: string;
    /** default 30; at least 2; a whole number. */
    readonly period?: number;
    /** The output column (default 'corr'). */
    readonly output?: string;
  };
  /** Ratio of a column to a benchmark column, with no look-back. */
  priceRelative: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** Column read as benchmark. */
    readonly benchmark: string;
    /** The output column (default 'priceRel'). */
    readonly output?: string;
  };
  /** Each side's own period-bar growth, divided — 1 is parity. */
  performanceIndex: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** Column read as benchmark. */
    readonly benchmark: string;
    /** default 20; at least 1; a whole number. */
    readonly period?: number;
    /** The output column (default 'perf'). */
    readonly output?: string;
  };
  /** Deviation from the rolling mean, in standard deviations. */
  zScore: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** The output column (default 'zscore'). */
    readonly output?: string;
  };
  /** Rolling population standard deviation (ddof = 0). */
  rollingStdev: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** The output column (default 'stdev'). */
    readonly output?: string;
  };
  /** Rolling minimum over the last period bars. */
  rollingMin: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** The output column (default 'min'). */
    readonly output?: string;
  };
  /** Rolling maximum over the last period bars. */
  rollingMax: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** The output column (default 'max'). */
    readonly output?: string;
  };
  /** Rolling q-th percentile, linearly interpolated. */
  rollingPercentile: {
    /** Column read as column (default 'close'). */
    readonly column?: string;
    /** at least 1; a whole number. */
    readonly period: number;
    /** at least 0; at most 100. */
    readonly q: number;
    /** The output column (default 'p90'). */
    readonly output?: string;
  };
  /** Typical price — (high + low + close) / 3. */
  typicalPrice: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** The output column (default 'typicalPrice'). */
    readonly output?: string;
  };
  /** Median price — (high + low) / 2. */
  medianPrice: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** The output column (default 'medianPrice'). */
    readonly output?: string;
  };
  /** Weighted close — (high + low + 2·close) / 4. */
  weightedClose: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** The output column (default 'weightedClose'). */
    readonly output?: string;
  };
  /** Average price — (open + high + low + close) / 4. */
  averagePrice: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as open (default 'open'). */
    readonly open?: string;
    /** The output column (default 'averagePrice'). */
    readonly output?: string;
  };
  /** TA-Lib's per-bar (close − open)/(high − low), optionally smoothed. */
  balanceOfPower: {
    /** Column read as open (default 'open'). */
    readonly open?: string;
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** at least 1; a whole number. */
    readonly period?: number;
    /** default "sma"; needs period. */
    readonly maType?:
      | 'sma'
      | 'ema'
      | 'wma'
      | 'smma'
      | 'dema'
      | 'tema'
      | 'trima'
      | 'hull'
      | 'kama'
      | 'zlema';
    /** The output column (default 'bop'). */
    readonly output?: string;
  };
  /** Volume-weighted average price, reset at each session's open. */
  sessionVwap: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** Column read as volume (default 'volume'). */
    readonly volume?: string;
    /** The output column (default 'svwap'). */
    readonly output?: string;
  } & SessionAnchor;
  /** The prior session's pivot with its support and resistance levels. */
  pivotPoints: {
    /** Column read as high (default 'high'). */
    readonly high?: string;
    /** Column read as low (default 'low'). */
    readonly low?: string;
    /** Column read as close (default 'close'). */
    readonly close?: string;
    /** default "standard". */
    readonly method?: 'standard' | 'fibonacci' | 'woodie' | 'camarilla';
    /** The output columns' prefix (default 'pp'). */
    readonly prefix?: string;
  } & SessionAnchor;
}

/** A study's options argument: optional when every option has a default. */
export type StudyOptionsArg<N extends StudyName> = {} extends StudyOptions[N]
  ? [options?: StudyOptions[N]]
  : [options: StudyOptions[N]];
// @generated-end
