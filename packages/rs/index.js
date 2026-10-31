// @pond-ts/rs: pond-rs (Rust) compiled to WebAssembly, behind pond-ts's
// method names and argument shapes. A series lives in WebAssembly memory;
// call `free()` when done with it (a finalizer frees forgotten ones
// eventually, but WebAssembly memory never shrinks, so do not rely on it).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const wasm = require('./pkg/pond_wasm.js');

const finalizer = new FinalizationRegistry((id) => wasm.series_free(id));
const TOKEN = Symbol('pond-rs series id');

/** A sequence of buckets: `Sequence.every('1m')`, `Sequence.calendar('day', { timeZone })`. */
export class Sequence {
  #spec;
  constructor(spec) {
    this.#spec = spec;
  }
  static every(duration) {
    return new Sequence({ every: duration });
  }
  static calendar(unit, options = {}) {
    const spec = { calendar: unit, timeZone: options.timeZone ?? 'UTC' };
    if (options.weekStartsOn !== undefined)
      spec.weekStartsOn = options.weekStartsOn;
    return new Sequence(spec);
  }
  toJSON() {
    return { sequence: this.#spec };
  }
}

// ---- column expressions ([PND-EXPR]) -------------------------------------

const literal = (v, where) => {
  const ok =
    (typeof v === 'number' && Number.isFinite(v)) ||
    typeof v === 'string' ||
    typeof v === 'boolean';
  if (!ok)
    throw new TypeError(
      `${where}: expected a finite number, text or true/false, got ${String(v)}`,
    );
  return v;
};
const node = (v) =>
  v instanceof Expr ? v.node : { lit: literal(v, 'expression operand') };

/**
 * A per-row rule written as data, as pond-ts `col('v').gt(0)`. It runs
 * inside pond-rs over whole columns, with no JavaScript call per row.
 * `toJSON()` gives the same tree as pond-ts's.
 */
export class Expr {
  constructor(n) {
    this.node = n;
    Object.freeze(this);
  }
  #op(op, ...rest) {
    return new Expr({ op, args: [this.node, ...rest.map(node)] });
  }
  eq(x) {
    return this.#op('eq', x);
  }
  ne(x) {
    return this.#op('ne', x);
  }
  gt(x) {
    return this.#op('gt', x);
  }
  ge(x) {
    return this.#op('ge', x);
  }
  lt(x) {
    return this.#op('lt', x);
  }
  le(x) {
    return this.#op('le', x);
  }
  in(values) {
    if (!Array.isArray(values))
      throw new TypeError('in(values): values must be an array');
    return new Expr({ op: 'in', args: [this.node], values: [...values] });
  }
  and(x) {
    return this.#op('and', x);
  }
  or(x) {
    return this.#op('or', x);
  }
  not() {
    return this.#op('not');
  }
  add(x) {
    return this.#op('add', x);
  }
  sub(x) {
    return this.#op('sub', x);
  }
  mul(x) {
    return this.#op('mul', x);
  }
  div(x) {
    return this.#op('div', x);
  }
  neg() {
    return this.#op('neg');
  }
  abs() {
    return this.#op('abs');
  }
  isMissing() {
    return this.#op('isMissing');
  }
  fill(x) {
    return this.#op('fill', x);
  }
  toJSON() {
    return this.node;
  }
}

/** The value of column `name` in each row. */
export function col(name) {
  if (typeof name !== 'string')
    throw new TypeError('col(name): name must be a string');
  return new Expr({ col: name });
}

/** A fixed value: `lit(100).sub(col('pct'))`. */
export function lit(value) {
  return new Expr({ lit: literal(value, 'lit(value)') });
}

/** `then` where `condition` is true, else `otherwise` (a gap counts as false). */
export function when(condition, then, otherwise) {
  return new Expr({
    op: 'when',
    args: [node(condition), node(then), node(otherwise)],
  });
}

const ms = (t, what) => {
  const v = t instanceof Date ? t.getTime() : t;
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new TypeError(`${what} must be a finite timestamp`);
  return v;
};

/** A point in time (ms), as pond-ts `Time`. */
export class Time {
  /** `Time.parse('2025-01-01T09:00', { timeZone: 'Europe/Madrid' })`. */
  static parse(text, options = {}) {
    return new Time(wasm.time_parse(text, options.timeZone ?? 'UTC'));
  }
  constructor(t) {
    this.kind = 'time';
    this.timestamp = ms(t, 'time');
    Object.freeze(this);
  }
  type() {
    return 'time';
  }
  begin() {
    return this.timestamp;
  }
  end() {
    return this.timestamp;
  }
  timeRange() {
    return new TimeRange([this.timestamp, this.timestamp]);
  }
  timestampMs() {
    return this.timestamp;
  }
  toDate() {
    return new Date(this.timestamp);
  }
  valueOf() {
    return this.timestamp;
  }
  duration() {
    return 0;
  }
  equals(other) {
    return other instanceof Time && this.timestamp === other.timestamp;
  }
}

/** A span `[start, end]` (ms), as pond-ts `TimeRange`: `new TimeRange([s, e])` or `{ start, end }`. */
export class TimeRange {
  constructor(input) {
    const [start, end] = Array.isArray(input)
      ? input
      : [input.start, input.end];
    this.kind = 'timeRange';
    this.start = ms(start, 'timeRange start');
    this.endMs = ms(end, 'timeRange end');
    if (this.start > this.endMs)
      throw new RangeError('timeRange start must be <= end');
    Object.freeze(this);
  }
  type() {
    return 'timeRange';
  }
  begin() {
    return this.start;
  }
  end() {
    return this.endMs;
  }
  timeRange() {
    return this;
  }
  duration() {
    return this.endMs - this.start;
  }
  toJSON() {
    return { start: this.start, end: this.endMs };
  }
}

/** A labelled span, as pond-ts `Interval`: `new Interval([value, s, e])` or `{ value, start, end }`. */
export class Interval {
  constructor(input) {
    const [value, start, end] = Array.isArray(input)
      ? input
      : [input.value, input.start, input.end];
    this.kind = 'interval';
    this.value = value;
    this.start = ms(start, 'interval start');
    this.endMs = ms(end, 'interval end');
    if (this.start > this.endMs)
      throw new RangeError('interval start must be <= end');
    Object.freeze(this);
  }
  type() {
    return 'interval';
  }
  begin() {
    return this.start;
  }
  end() {
    return this.endMs;
  }
  valueOf() {
    return this.value;
  }
  timeRange() {
    return new TimeRange([this.start, this.endMs]);
  }
}

// An event's row position in the series it came from (read by the tests).
const ROW_INDEX = Symbol.for('pond-rs row index');

/** One row, as pond-ts `Event`: `get(column)`, `data()`, `key()`, `begin()`, `end()`. */
export class Event {
  #key;
  #data;
  /** @internal Built from a `toJSON()` row and its schema. */
  constructor(schema, row, index) {
    const k = row[0];
    const kind = schema[0].kind;
    this.#key =
      kind === 'time'
        ? new Time(k)
        : kind === 'timeRange'
          ? new TimeRange(k)
          : new Interval(k);
    const data = {};
    for (let c = 1; c < schema.length; c++)
      data[schema[c].name] = row[c] ?? undefined;
    this.#data = Object.freeze(data);
    this[ROW_INDEX] = index;
  }
  key() {
    return this.#key;
  }
  type() {
    return this.#key.kind;
  }
  data() {
    return this.#data;
  }
  get(column) {
    return this.#data[column];
  }
  begin() {
    return this.#key.begin();
  }
  end() {
    return this.#key.end();
  }
  timeRange() {
    return this.#key.timeRange();
  }
}

/** A value passed through to Rust as is (`scan`'s initial accumulator). */
class Given {
  constructor(value) {
    this.value = value;
  }
}

// Arguments go to Rust as JSON; these encodings carry what JSON cannot.
// Functions (and `Given` values) go in `fns`, sent as `{ fn: position }`.
function encode(v, fns) {
  if (v instanceof TimeSeries) return { series: v.id };
  if (v instanceof Sequence) return v.toJSON();
  if (v instanceof Time) return { time: v.timestamp };
  if (v instanceof TimeRange) return { timeRange: [v.start, v.endMs] };
  if (v instanceof Interval) return { interval: [v.value, v.start, v.endMs] };
  if (v instanceof Expr) return { expr: v.node };
  if (v instanceof TradingCalendar) return { calendar: v.id };
  if (typeof v === 'function' || v instanceof Given)
    return { fn: fns.push(v instanceof Given ? v.value : v) - 1 };
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { f64: 'NaN' };
    if (v === Infinity) return { f64: 'inf' };
    if (v === -Infinity) return { f64: '-inf' };
    if (Object.is(v, -0)) return { f64: '-0' };
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => encode(x, fns));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v))
      if (x !== undefined) out[k] = encode(x, fns);
    return out;
  }
  return v;
}

const ROW_TESTS = new Set(['filter', 'find', 'some', 'every']);

// Rust calls functions with plain rows (`[key, ...cells]`, as `toJSON()`
// writes them) and numbers; these wrap the caller's function so it gets
// what pond-ts gives it.
function prepare(op, args, schema) {
  const out = [...args];
  if (ROW_TESTS.has(op) && typeof args[0] === 'function') {
    const f = args[0];
    const s = schema();
    out[0] = (row, i) => f(new Event(s, row, i), i);
  } else if (op === 'collapse' && typeof args[2] === 'function') {
    const f = args[2];
    const s = schema();
    const keys = [].concat(args[0]);
    const at = keys.map((k) => s.findIndex((d) => d.name === k));
    out[2] = (row) => {
      const values = {};
      keys.forEach(
        (k, j) =>
          (values[k] = at[j] > 0 ? (row[at[j]] ?? undefined) : undefined),
      );
      return f(values);
    };
  } else if (op === 'asInterval' && typeof args[0] === 'function') {
    const f = args[0];
    out[0] = (begin, end, i) => f(new TimeRange([begin, end]), i);
  } else if (op === 'scan') {
    out[2] = new Given(args[2]);
  } else if (op === 'study' && args[1]?.anchor instanceof Date) {
    out[1] = { ...args[1], anchor: args[1].anchor.getTime() };
  }
  return out;
}

function decode(result, schema) {
  if (result.series !== undefined) return new TimeSeries(TOKEN, result.series);
  if (result.groups !== undefined)
    return new Map(
      result.groups.map(([k, id]) => [k, new TimeSeries(TOKEN, id)]),
    );
  if (result.record !== undefined) return result.record;
  if (result.records !== undefined) return result.records;
  if (result.row !== undefined)
    return result.row === null
      ? undefined
      : new Event(schema(), result.row, result.index);
  if (result.span !== undefined)
    return result.span === null ? undefined : new TimeRange(result.span);
  return result.value;
}

const KEY_KINDS = ['time', 'timeRange', 'interval'];

const scalar = (x) =>
  (typeof x === 'number' && Number.isFinite(x)) ||
  typeof x === 'string' ||
  typeof x === 'boolean';
const check = (test, want) => Object.assign(test, { want });
const CELL_CHECKS = {
  string: check(
    (x) => typeof x === 'string',
    () => 'expected string',
  ),
  boolean: check(
    (x) => typeof x === 'boolean',
    () => 'expected boolean',
  ),
  array: check(
    (x) => Array.isArray(x) && x.every(scalar),
    (x) =>
      Array.isArray(x)
        ? `array element ${x.findIndex((e) => !scalar(e))} must be a finite number, string, or boolean`
        : 'expected array of scalars',
  ),
};

// A pond-ts `toJSON()` object with numeric times, as columns for Rust.
// `undefined` is a gap; `null` is one only when `nulls` (as `fromJSON`; the
// pond-ts constructor refuses it).
function columnsOf(input, nulls) {
  const { schema, rows } = input;
  const keyKind = schema[0]?.kind;
  if (!KEY_KINDS.includes(keyKind))
    throw new TypeError(
      `the first schema column must be time, timeRange or interval`,
    );
  const n = rows.length;
  const begin = new Float64Array(n);
  let end;
  let labels;
  if (keyKind === 'time') {
    for (let i = 0; i < n; i++) begin[i] = rows[i][0];
  } else if (keyKind === 'timeRange') {
    end = new Float64Array(n);
    for (let i = 0; i < n; i++) [begin[i], end[i]] = rows[i][0];
  } else {
    end = new Float64Array(n);
    labels = new Array(n);
    for (let i = 0; i < n; i++) [labels[i], begin[i], end[i]] = rows[i][0];
  }
  const columns = schema.slice(1).map((def, c) => {
    const kind = def.kind ?? 'number';
    const at = (i) => `row ${i} col ${c + 1}`;
    if (kind === 'number') {
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = rows[i][c + 1];
        if (x === undefined || (nulls && x === null)) v[i] = NaN;
        else if (typeof x === 'number' && Number.isFinite(x)) v[i] = x;
        else throw new TypeError(`${at(i)}: expected finite number`);
      }
      return v;
    }
    // The cell checks (and messages) pond-ts's constructor makes.
    const ok = CELL_CHECKS[kind];
    return rows.map((r, i) => {
      const x = r[c + 1];
      if (x === undefined || (nulls && x === null)) return null;
      if (ok && !ok(x)) throw new TypeError(`${at(i)}: ${ok.want(x)}`);
      return x;
    });
  });
  return { begin, end, labels, columns };
}

function fromColumns(input, nulls) {
  const { begin, end, labels, columns } = columnsOf(input, nulls);
  return wasm.series_from_columns(
    input.name ?? '',
    JSON.stringify(input.schema),
    begin,
    end,
    labels,
    columns,
  );
}

const numericKeys = (rows) =>
  rows.every((r) => {
    const k = r[0];
    return (
      typeof k === 'number' ||
      (Array.isArray(k) && k.slice(-2).every((t) => typeof t === 'number'))
    );
  });

export class TimeSeries {
  #id;

  /**
   * `new TimeSeries({ name, schema, rows })`, as pond-ts. Times are ms
   * (numbers); for times as text use `TimeSeries.fromJSON`.
   */
  constructor(input, id) {
    if (input === TOKEN) {
      this.#id = id;
    } else {
      this.#id = fromColumns(input, false);
    }
    finalizer.register(this, this.#id, this);
  }

  /** pond-ts `toJSON()` shape in; times as ms or as text. */
  static fromJSON(input, options = {}) {
    if (numericKeys(input.rows))
      return new TimeSeries(TOKEN, fromColumns(input, true));
    const id = wasm.series_from_json(
      JSON.stringify(input),
      options.parse?.timeZone,
    );
    return new TimeSeries(TOKEN, id);
  }

  /** An Arrow IPC file (bytes). `key` names the key field. */
  static fromArrow(bytes, options = {}) {
    const id = wasm.series_from_arrow(
      options.name ?? '',
      bytes,
      options.key ?? 'time',
      options.keyKind,
    );
    return new TimeSeries(TOKEN, id);
  }

  static joinMany(list, options) {
    if (!list.length)
      throw new TypeError(
        'TimeSeries.joinMany requires at least one input series.',
      );
    const [first, ...rest] = list;
    return first.#call('joinMany', [rest, options]);
  }

  static concat(list) {
    if (!list.length)
      throw new TypeError(
        'TimeSeries.concat requires at least one input series.',
      );
    const [first, ...rest] = list;
    return first.#call('concat', [rest]);
  }

  /** @internal The series' slot in WebAssembly memory. */
  get id() {
    if (this.#id === undefined) throw new Error('this series was freed');
    return this.#id;
  }

  get length() {
    return wasm.series_len(this.id);
  }

  /** Release the series' memory now. The series cannot be used after. */
  free() {
    if (this.#id === undefined) return;
    finalizer.unregister(this);
    wasm.series_free(this.#id);
    this.#id = undefined;
  }

  toJSON() {
    return wasm.series_to_object(this.id);
  }

  /** The series as an Arrow IPC file (bytes). */
  toArrow() {
    return wasm.series_to_arrow(this.id);
  }

  /** One number column's values (NaN for a gap). */
  numbers(column) {
    return wasm.series_numbers(this.id, column);
  }

  /** The key's times (starts, for spans) in ms. */
  times() {
    return wasm.series_times(this.id);
  }

  /** The schema, as pond-ts `series.schema`. */
  get schema() {
    return wasm.series_schema(this.id);
  }

  #call(op, args) {
    let schema;
    const schemaOnce = () => (schema ??= this.schema);
    const fns = [];
    const json = JSON.stringify(encode(prepare(op, args, schemaOnce), fns));
    return decode(wasm.series_call(this.id, op, json, fns), schemaOnce);
  }

  /** `partitionBy(by)`: chain methods, then `collect()` or `toMap()`. */
  partitionBy(by) {
    return new PartitionedSeries((steps, end) =>
      this.#call('partitionBy', [
        by,
        steps.map(([op, ...args]) => [op, ...prepare(op, args)]),
        end,
      ]),
    );
  }

  /** @internal Run any supported pond-ts method by name. */
  call(op, ...args) {
    return this.#call(op, args);
  }
}

/** The per-partition view `partitionBy` returns. */
export class PartitionedSeries {
  constructor(run, steps = []) {
    this._run = run;
    this._steps = steps;
  }
  collect() {
    return this._run(this._steps, 'collect');
  }
  toMap() {
    return this._run(this._steps, 'toMap');
  }
}

for (const op of wasm.partitioned_methods()) {
  PartitionedSeries.prototype[op] = function (...args) {
    return new PartitionedSeries(this._run, [...this._steps, [op, ...args]]);
  };
}

const STATICS = new Set(['joinMany', 'concat', 'partitionBy']);
for (const op of wasm.supported_methods()) {
  if (STATICS.has(op)) continue;
  TimeSeries.prototype[op] = function (...args) {
    return this.call(op, ...args);
  };
}

// ---- financial studies ([PND-RUST-R4] J2a) ---------------------------------

// One method per catalog study, pond-ts's name (`s.rsi({ period: 14 })`),
// as `@pond-ts/financial/fluent` mounts them; each is `study(name, options)`.
for (const name of wasm.study_names()) {
  TimeSeries.prototype[name] = function (options) {
    return this.call('study', name, options);
  };
  PartitionedSeries.prototype[name] = function (options) {
    return this.study(name, options);
  };
}

/** Every study's descriptor, as pond-ts's `@pond-ts/financial/catalog` `STUDIES` (without `run`). */
export function studies() {
  return JSON.parse(wasm.studies_json());
}

/** One study's descriptor (pond-ts `studyDescriptor(name)`), or `undefined`. */
export function studyInfo(name) {
  return JSON.parse(wasm.study_info_json(String(name))) ?? undefined;
}

const calendarFinalizer = new FinalizationRegistry((id) =>
  wasm.calendar_free(id),
);
const asMs = (t) => (t instanceof Date ? t.getTime() : t);
const range = (r) => ({ from: asMs(r?.from), to: asMs(r?.to) });
const session = (s) => s ?? undefined;

/** pond-ts `generateSessions(rules, { from, to })`: the sessions rules give, unchecked. */
export function generateSessions(rules, dates) {
  return JSON.parse(
    wasm.generate_sessions(JSON.stringify(rules), JSON.stringify(range(dates))),
  );
}

/**
 * Exchange sessions, as pond-ts `TradingCalendar` (cut down: no sequences,
 * no discontinuity provider). Build with `fromRules` or `fromSessions`;
 * pass it to a session study as `sessions`, or tag bars with
 * `tagSessions`. Lives in WebAssembly memory: `free()` when done.
 */
export class TradingCalendar {
  #id;
  /** @internal */
  constructor(token, id) {
    if (token !== TOKEN)
      throw new TypeError(
        'use TradingCalendar.fromRules or TradingCalendar.fromSessions',
      );
    this.#id = id;
    calendarFinalizer.register(this, id, this);
  }
  /** Sessions from `rules` (`{ timeZone, open, close, weekmask?, breaks?, holidays?, earlyCloses? }`) over `{ from, to }`. */
  static fromRules(rules, dates) {
    return new TradingCalendar(
      TOKEN,
      wasm.calendar_from_rules(
        JSON.stringify(rules),
        JSON.stringify(range(dates)),
      ),
    );
  }
  /** A calendar from `Session`s (`{ date, open, close, breaks? }`, times in ms), checked and sorted. */
  static fromSessions(sessions, options = {}) {
    return new TradingCalendar(
      TOKEN,
      wasm.calendar_from_sessions(
        JSON.stringify([...sessions]),
        options.timeZone ?? undefined,
      ),
    );
  }
  /** @internal The calendar's slot in WebAssembly memory. */
  get id() {
    if (this.#id === undefined) throw new Error('this calendar was freed');
    return this.#id;
  }
  /** Release the calendar's memory now. */
  free() {
    if (this.#id === undefined) return;
    calendarFinalizer.unregister(this);
    wasm.calendar_free(this.#id);
    this.#id = undefined;
  }
  #q(op, arg) {
    return JSON.parse(
      wasm.calendar_query(this.id, op, JSON.stringify(arg ?? null)),
    );
  }
  /** All sessions, ascending by open. */
  sessions() {
    return this.#q('sessions');
  }
  get length() {
    return this.#q('length');
  }
  /** The exchange's zone (the rules' zone), or `undefined`. */
  get timeZone() {
    return this.#q('timeZone') ?? undefined;
  }
  /** The session on `date` (`YYYY-MM-DD`; other text throws), or `undefined`. */
  sessionOn(date) {
    return session(this.#q('sessionOn', date));
  }
  isTradingDay(date) {
    return this.#q('isTradingDay', date);
  }
  /** The session whose `[open, close)` holds the time (ms), or `undefined`. */
  sessionContaining(instant) {
    return session(this.#q('sessionContaining', asMs(instant)));
  }
  /** Inside a session and not in one of its breaks. */
  isOpen(instant) {
    return this.#q('isOpen', asMs(instant));
  }
  /** Sessions overlapping `{ start, end }` (ms), ascending. */
  sessionsInRange(r) {
    return this.#q('sessionsInRange', {
      start: asMs(r?.start),
      end: asMs(r?.end),
    });
  }
  /** The first session after a time (ms) or a date (`YYYY-MM-DD`). */
  nextSession(ref) {
    return session(this.#q('nextSession', asMs(ref)));
  }
  /** The last session before a time (ms) or a date (`YYYY-MM-DD`). */
  previousSession(ref) {
    return session(this.#q('previousSession', asMs(ref)));
  }
  /** `series` with a session-id column (each row's session open, a gap in closed time). */
  tagSessions(series, options = {}) {
    return new TimeSeries(
      TOKEN,
      wasm.calendar_tag_sessions(this.id, series.id, JSON.stringify(options)),
    );
  }
}

export const version = wasm.pond_rs_version();
/** @internal How many series are alive in WebAssembly memory. */
export const alive = () => wasm.series_alive();
/** @internal How many calendars are alive in WebAssembly memory. */
export const calendarsAlive = () => wasm.calendars_alive();
