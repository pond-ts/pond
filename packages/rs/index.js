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
const EVENT_PARTS = Symbol('event parts');
// Each schema's column positions by name, for `Event.get`.
const COLUMN_INDEX = new WeakMap();
function columnIndex(schema) {
  let m = COLUMN_INDEX.get(schema);
  if (m === undefined) {
    m = new Map();
    for (let c = 1; c < schema.length; c++) m.set(schema[c].name, c);
    COLUMN_INDEX.set(schema, m);
  }
  return m;
}

/** One row, as pond-ts `Event`: `get(column)`, `data()`, `key()`, `begin()`, `end()`. */
export class Event {
  // Built lazily from the row: a listener that reads one cell does not pay
  // for the key object and the data record.
  #schema;
  #row;
  #key;
  #data;
  /** @internal Built from a `toJSON()` row and its schema. */
  constructor(schema, row, index) {
    if (schema === EVENT_PARTS) {
      // `set`: a key and frozen data as they are.
      this.#key = row;
      this.#data = index;
      return;
    }
    this.#schema = schema;
    this.#row = row;
    this[ROW_INDEX] = index;
  }
  key() {
    if (this.#key === undefined) {
      const k = this.#row[0];
      const kind = this.#schema[0].kind;
      this.#key =
        kind === 'time'
          ? new Time(k)
          : kind === 'timeRange'
            ? new TimeRange(k)
            : new Interval(k);
    }
    return this.#key;
  }
  type() {
    return this.key().kind;
  }
  data() {
    if (this.#data === undefined) {
      const data = {};
      const schema = this.#schema;
      for (let c = 1; c < schema.length; c++)
        data[schema[c].name] = this.#row[c] ?? undefined;
      this.#data = Object.freeze(data);
    }
    return this.#data;
  }
  get(column) {
    if (this.#data !== undefined) return this.#data[column];
    const c = columnIndex(this.#schema).get(column);
    return c === undefined ? undefined : (this.#row[c] ?? undefined);
  }
  begin() {
    if (this.#key === undefined && this.#schema[0].kind === 'time')
      return this.#row[0];
    return this.key().begin();
  }
  end() {
    if (this.#key === undefined && this.#schema[0].kind === 'time')
      return this.#row[0];
    return this.key().end();
  }
  timeRange() {
    return this.key().timeRange();
  }
  /** A copy with `column` set to `value`, as pond-ts `event.set`. */
  set(column, value) {
    return new Event(
      EVENT_PARTS,
      this.key(),
      Object.freeze({ ...this.data(), [column]: value }),
    );
  }
  /** `[key, ...cells]` in `schema` order (`null` for a gap), as pond-ts `toJsonRow`. */
  toJsonRow(schema) {
    const k = this.key();
    const data = this.data();
    const key =
      k.kind === 'time'
        ? k.timestamp
        : k.kind === 'timeRange'
          ? [k.start, k.endMs]
          : [k.value, k.start, k.endMs];
    return [key, ...schema.slice(1).map((c) => data[c.name] ?? null)];
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
  if (v instanceof Trigger) return v.toJSON();
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

// ---- live series ([PND-RUST-R4] J2b) ---------------------------------------

/** When a rolling window or reduce emits, as pond-ts `Trigger`. */
export class Trigger {
  #spec;
  constructor(spec) {
    this.#spec = spec;
    this.kind =
      spec === 'event' ? 'event' : 'count' in spec ? 'count' : 'clock';
    Object.freeze(this);
  }
  /** After every event (the default). */
  static event() {
    return new Trigger('event');
  }
  /** When a clock bucket of `duration` ends (`Trigger.every('30s')`). */
  static every(duration) {
    return new Trigger({ every: duration });
  }
  /** Every `n` events. */
  static count(n) {
    return new Trigger({ count: n });
  }
  /** When a bucket of `sequence` ends. */
  static clock(sequence) {
    return new Trigger({ clock: sequence.toJSON() });
  }
  toJSON() {
    return this.#spec;
  }
}

// Live series by id, held weakly: Rust calls node functions back through
// one shared callback with the series id (as `this`) and the function's
// index in that series' own `fns`. So the functions are held only by
// their series (JavaScript), and a function that refers to its own series
// does not keep it alive (wasm-bindgen's table would hold it for good).
const LIVE_OWNERS = new Map();
wasm.live_set_callback(function (k, a, b) {
  return LIVE_OWNERS.get(this).deref().fns[k](a, b);
});
const liveFinalizer = new FinalizationRegistry((id) => {
  LIVE_OWNERS.delete(id);
  wasm.live_free(id);
});
const OUTPUT_KINDS = ['event', 'batch', 'evict', 'bucket', 'update'];
// The output kinds each pond-ts live class emits (its `on(type)` types).
const KINDS_OF = {
  LiveSeries: ['event', 'batch', 'evict'],
  LiveView: ['event', 'evict'],
  LiveAggregation: ['event', 'bucket', 'update'],
  LiveRollingAggregation: ['event', 'update'],
  LiveFusedRolling: ['event'],
  LiveReduce: ['event'],
  LivePartitionedFusedRolling: ['event'],
  LivePartitionedSyncRolling: ['event'],
  LivePartitionedSeries: [],
  LivePartitionedView: [],
};
const NOT_FAST = Symbol('not fast');

/** One live series and every node built on it, in WebAssembly memory. */
class LiveOwner {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.freed = false;
    /** handle -> Map(kind -> Set(listener)) */
    this.listeners = new Map();
    /** handle -> node object, so a node is always the same object. */
    this.nodes = new Map();
    this.schemas = new Map();
    this.depth = 0;
    this.pending = [];
    this.pushes = 0;
    /** Every node function, by the index Rust calls it with. */
    this.fns = [];
    // Number-only fast path: a time key and number columns only.
    this.numeric = wasm.live_numeric(id);
  }
  get liveId() {
    if (this.freed) throw new Error('this LiveSeries was freed');
    return this.id;
  }
  node(h, cls) {
    let n = this.nodes.get(h);
    if (!n) {
      n = new LIVE_CLASSES[cls](TOKEN, this, h, cls);
      this.nodes.set(h, n);
    }
    return n;
  }
  schema(h) {
    let s = this.schemas.get(h);
    if (!s) {
      s = Object.freeze(wasm.live_read(this.liveId, h, 'schema', 0));
      this.schemas.set(h, s);
    }
    return s;
  }
  read(h, op, arg = 0) {
    return wasm.live_read(this.liveId, h, op, arg);
  }
  /** The listeners of `kind` on node `h`, or undefined. */
  listening(h, kind) {
    const set = this.listeners.get(h)?.get(OUTPUT_KINDS[kind]);
    return set && set.size > 0 ? set : undefined;
  }
  emit(set, value, errors) {
    // The listeners as they were when the output arrived (a listener may
    // add or remove one); no copy for the common single listener.
    const fns = set.size === 1 ? [set.values().next().value] : [...set];
    for (const fn of fns) {
      try {
        fn(value);
      } catch (e) {
        errors.push(e);
      }
    }
  }
  /**
   * Hand a push's outputs to listeners: `[handle, kind, payload, …]`, or
   * the same as numbers (a `Float64Array`, see `outputs_f64` in Rust).
   */
  dispatch(outs, errors) {
    if (outs instanceof Float64Array) return this.dispatchNumbers(outs, errors);
    for (let i = 0; i < outs.length; i += 3) {
      const h = outs[i];
      const k = outs[i + 1];
      const set = this.listening(h, k);
      if (!set) continue;
      const p = outs[i + 2];
      let value = p;
      if (k === 0 || k === 3) value = new Event(this.schema(h), p);
      else if (k === 1 || k === 2) {
        const s = this.schema(h);
        value = p.map((row) => new Event(s, row));
      }
      this.emit(set, value, errors);
    }
  }
  dispatchNumbers(v, errors) {
    const cell = (x) => (x !== x ? undefined : x);
    let i = 0;
    while (i < v.length) {
      const h = v[i];
      const k = v[i + 1];
      const n = v[i + 2];
      i += 3;
      const s = this.schema(h);
      const w = s.length - 1;
      const set = this.listening(h, k);
      if (k === 4) {
        let value;
        if (n === 1) {
          if (set) {
            value = {};
            for (let c = 0; c < w; c++) value[s[c + 1].name] = cell(v[i + c]);
          }
          i += w;
        }
        if (set) this.emit(set, value, errors);
        continue;
      }
      const kind = s[0].kind;
      const kw = kind === 'time' ? 1 : kind === 'timeRange' ? 2 : 3;
      if (!set) {
        i += n * (kw + w);
        continue;
      }
      const events = new Array(n);
      for (let e = 0; e < n; e++) {
        const row = new Array(w + 1);
        row[0] =
          kw === 1
            ? v[i]
            : kw === 2
              ? [v[i], v[i + 1]]
              : [v[i], v[i + 1], v[i + 2]];
        i += kw;
        for (let c = 1; c <= w; c++) row[c] = cell(v[i++]);
        events[e] = new Event(s, row);
      }
      this.emit(set, k === 1 || k === 2 ? events : events[0], errors);
    }
  }
  /**
   * Finish a push: listeners get every output, pushes they made run after
   * (as pond-ts queues them), then the first exception is rethrown: a node
   * function's, else a listener's.
   */
  settle(r) {
    this.pushes++;
    if (r === undefined && this.pending.length === 0) return;
    const errors = [];
    let thrown = NOT_FAST;
    if (r !== undefined) {
      let outs = r;
      if (!Array.isArray(r) && !(r instanceof Float64Array)) {
        outs = r.outputs;
        thrown = r.thrown;
      }
      this.depth++;
      try {
        this.dispatch(outs, errors);
      } finally {
        this.depth--;
      }
    }
    while (this.depth === 0 && this.pending.length > 0) {
      try {
        this.pending.shift()();
      } catch (e) {
        errors.push(e);
      }
    }
    if (thrown !== NOT_FAST) throw thrown;
    if (errors.length > 0) throw errors[0];
  }
  /**
   * A reduce built over history emits its first value at the build; pond-ts
   * emits it from a microtask, so a listener attached right after the build
   * gets it. Skipped if a push came first (that push emitted a newer one).
   */
  replay(node, h) {
    const rows = this.read(h, 'replay');
    if (rows.length === 0) return;
    const at = this.pushes;
    queueMicrotask(() => {
      if (this.freed || this.pushes !== at) return;
      const outs = [];
      for (const row of rows) outs.push(h, 0, row);
      const errors = [];
      this.dispatch(outs, errors);
      if (errors.length > 0) throw errors[0];
    });
  }
}

const wrapFilter = (f) => (row, schema) => f(new Event(schema, row));
const wrapMap = (f) => (row, schema) => {
  const e = new Event(schema, row);
  const out = f(e);
  if (!out || typeof out.get !== 'function' || typeof out.begin !== 'function')
    throw new TypeError('map: the function must return an event');
  if (
    out.begin() !== e.begin() ||
    out.end() !== e.end() ||
    out.key().value !== e.key().value
  )
    throw new TypeError(
      "map: the function changed the event's key; @pond-ts/rs keeps each event's key",
    );
  return schema.slice(1).map((d) => out.get(d.name) ?? null);
};

// Live builders take a function for `filter` / `map` (wrapped so it gets an
// `Event`), an `Expr` for `filter`, functions in `cumulative` (called with
// numbers as they are).
function liveArgs(op, args) {
  const out = [...args];
  if (op === 'filter' && typeof args[0] === 'function')
    out[0] = wrapFilter(args[0]);
  else if (op === 'map' && typeof args[0] === 'function')
    out[0] = wrapMap(args[0]);
  return out;
}

const BUILDERS = [
  'filter',
  'map',
  'select',
  'sample',
  'window',
  'diff',
  'rate',
  'pctChange',
  'fill',
  'cumulative',
  'aggregate',
  'rolling',
  'reduce',
];

/** The chain an `apply` factory builds, recorded once. */
class LiveChain {
  constructor(steps = []) {
    this.steps = steps;
  }
}
for (const op of BUILDERS) {
  LiveChain.prototype[op] = function (...args) {
    return new LiveChain([...this.steps, [op, ...liveArgs(op, args)]]);
  };
}

/** What every live node has: reading, listening, building more nodes. */
class LiveNode {
  #o;
  #h;
  /** The pond-ts class this node is (kept here, not read off `constructor.name`). */
  #cls;
  #disposed = false;
  /** @internal */
  constructor(token, owner, h, cls) {
    if (token !== TOKEN)
      throw new TypeError('build live nodes from a LiveSeries');
    this.#o = owner;
    this.#h = h;
    this.#cls = cls;
  }
  /** @internal */
  get _owner() {
    return this.#o;
  }
  /** @internal */
  get _handle() {
    return this.#h;
  }
  get name() {
    return this.#o.name;
  }
  /** The node's columns, key first, as pond-ts `schema`. */
  get schema() {
    return this.#o.schema(this.#h);
  }
  get length() {
    return this.#o.read(this.#h, 'length');
  }
  /** The event at `index` (negative counts from the end), or `undefined`. */
  at(index) {
    const row = this.#o.read(this.#h, 'at', index);
    return row === undefined ? undefined : new Event(this.schema, row);
  }
  first() {
    return this.at(0);
  }
  last() {
    return this.at(-1);
  }
  /**
   * Call `fn` with each output of `type` (`'event'`, `'batch'`, `'evict'`,
   * `'bucket'`, `'update'`, as the node's pond-ts class has them) during
   * each push. Returns a function that removes the listener.
   */
  on(type, fn) {
    const kinds = KINDS_OF[this.#cls];
    if (!kinds.includes(type))
      throw new TypeError(
        `${this.#cls} emits ${kinds.map((k) => `'${k}'`).join(', ') || 'nothing'}, not '${type}'`,
      );
    // As pond-ts: a disposed node takes a listener that is never called.
    if (this.#disposed) return () => {};
    const o = this.#o;
    const h = this.#h;
    let byKind = o.listeners.get(h);
    if (!byKind) o.listeners.set(h, (byKind = new Map()));
    let set = byKind.get(type);
    if (!set) byKind.set(type, (set = new Set()));
    if (set.size === 0) wasm.live_watch(o.liveId, h, type, true);
    set.add(fn);
    return () => {
      if (set.delete(fn) && set.size === 0 && !o.freed)
        wasm.live_watch(o.id, h, type, false);
    };
  }
  /** Stop this node (pond-ts `dispose`); nodes built on it keep what they hold. */
  dispose() {
    // A second dispose (or one after `free()`) does nothing, as pond-ts.
    if (this.#disposed || this.#o.freed) return;
    wasm.live_remove(this.#o.liveId, this.#h);
    this.#disposed = true;
  }
  /** @internal Build `op(...args)` on this node. */
  _build(op, args) {
    const o = this.#o;
    const fns = [];
    const json = JSON.stringify(encode(liveArgs(op, args), fns));
    const base = o.fns.length;
    o.fns.push(...fns);
    let h, cls;
    try {
      [h, cls] = wasm.live_build(o.liveId, this.#h, op, json, base, fns.length);
    } catch (e) {
      o.fns.length = base;
      throw e;
    }
    const node = o.node(h, cls);
    if (cls === 'LiveReduce') o.replay(node, h);
    return node;
  }
}
for (const op of BUILDERS) {
  LiveNode.prototype[op] = function (...args) {
    return this._build(op, args);
  };
}

function encodeCell(c) {
  if (c === undefined) return null;
  if (c === null) return { null: true };
  return encode(c, []);
}

/**
 * A series that takes events as they arrive, as pond-ts `LiveSeries`:
 * `new LiveSeries({ name, schema, ordering, graceWindow, retention })`. It
 * owns every node built on it; call `free()` when done (a finalizer frees a
 * forgotten one eventually).
 */
export class LiveSeries extends LiveNode {
  constructor(options, owner, h, cls) {
    if (options === TOKEN) {
      super(TOKEN, owner, h, cls);
      return;
    }
    const { name = '', schema, ...rest } = options ?? {};
    const id = wasm.live_new(
      String(name),
      JSON.stringify(schema),
      JSON.stringify(encode(rest, [])),
    );
    const o = new LiveOwner(id, String(name));
    LIVE_OWNERS.set(id, new WeakRef(o));
    liveFinalizer.register(o, id, o);
    super(TOKEN, o, 0, 'LiveSeries');
    o.nodes.set(0, this);
  }

  /** Push rows (`[key, ...values]`, `undefined` for a gap). */
  push(...rows) {
    this.pushMany(rows);
  }

  /** Push rows as one batch: all or nothing. */
  pushMany(rows) {
    const o = this._owner;
    this.#rootOnly('pushMany');
    if (rows.length === 0) return;
    if (o.depth > 0) {
      // A push from a listener runs after the current push, as pond-ts.
      o.pending.push(() => this.pushMany(rows));
      return;
    }
    const id = o.liveId;
    let r = o.numeric ? fastPush(id, rows, this.schema.length) : NOT_FAST;
    if (r === NOT_FAST) {
      const encoded = rows.map((row) => {
        if (!Array.isArray(row))
          throw new TypeError('push: a row is [key, ...values]');
        return row.map((c, i) =>
          i === 0
            ? encode(c instanceof Date ? c.getTime() : c, [])
            : encodeCell(c),
        );
      });
      r = wasm.live_push_rows(id, JSON.stringify(encoded));
    }
    o.settle(r);
  }

  /** Push rows written as pond-ts JSON (times as ms or UTC text, `null` for a gap). */
  pushJson(rows, options = {}) {
    if (options.timeZone !== undefined && options.timeZone !== 'UTC')
      throw new TypeError(
        'pushJson: @pond-ts/rs reads JSON times as ms or UTC text; timeZone is not supported',
      );
    this.#rootOnly('pushJson');
    if (rows.length === 0) return;
    const o = this._owner;
    if (o.depth > 0) {
      // From a listener: after the current push, as pond-ts (whose
      // `pushJson` is a `pushMany`).
      o.pending.push(() => this.pushJson(rows, options));
      return;
    }
    o.settle(wasm.live_push_json(o.liveId, JSON.stringify(rows)));
  }

  /**
   * Remove every event (an `'evict'` of them all). From a listener it runs
   * at once, as pond-ts's does.
   */
  clear() {
    this.#rootOnly('clear');
    const o = this._owner;
    o.settle(wasm.live_clear(o.liveId));
  }

  // A partition's series is fed by the root; pond-ts lets you push into
  // (or clear) one partition directly, pond-rs does not.
  #rootOnly(call) {
    if (this._handle !== 0)
      throw new TypeError(
        `${call}: @pond-ts/rs pushes into (and clears) the root LiveSeries only, not one partition`,
      );
  }

  /** What the series holds now, as a batch `TimeSeries`. */
  toTimeSeries() {
    return new TimeSeries(
      TOKEN,
      this._owner.read(this._handle, 'toTimeSeries'),
    );
  }

  stats() {
    return this._owner.read(this._handle, 'stats');
  }

  /** Split by `column`: build on the result (per partition), then `collect()`. */
  partitionBy(by, options) {
    return this._build('partitionBy', [by, options]);
  }

  /** Release the series and all its nodes now (the root only). */
  free() {
    const o = this._owner;
    if (this._handle !== 0 || o.freed) return;
    liveFinalizer.unregister(o);
    LIVE_OWNERS.delete(o.id);
    wasm.live_free(o.id);
    o.freed = true;
  }
}

/** A node that passes events through (filter, map, diff, fill, window, …). */
export class LiveView extends LiveNode {
  toTimeSeries() {
    return new TimeSeries(
      TOKEN,
      this._owner.read(this._handle, 'toTimeSeries'),
    );
  }
  count() {
    return this._owner.read(this._handle, 'count');
  }
}

/**
 * Buckets of a sequence, as pond-ts `LiveAggregation`. `new
 * LiveAggregation(source, sequence, mapping, { grace })` builds one with
 * its own grace.
 */
export class LiveAggregation extends LiveNode {
  constructor(source, sequence, mapping, options) {
    if (source === TOKEN) {
      super(TOKEN, sequence, mapping, options);
      return;
    }
    if (!(source instanceof LiveNode))
      throw new TypeError('LiveAggregation: the source must be a live node');
    return source._build('aggregate', [sequence, mapping, options ?? {}]);
  }
  /** Closed buckets, as a batch `TimeSeries`. */
  closed() {
    return new TimeSeries(TOKEN, this._owner.read(this._handle, 'closed'));
  }
  /** Closed buckets and the open one, as a batch `TimeSeries`. */
  snapshot() {
    return new TimeSeries(TOKEN, this._owner.read(this._handle, 'snapshot'));
  }
  get hasOpenBucket() {
    return this._owner.read(this._handle, 'hasOpenBucket');
  }
  get closedCount() {
    return this.length;
  }
  stats() {
    return this._owner.read(this._handle, 'stats');
  }
}

class LiveRollingNode extends LiveNode {
  /** The value columns as they stand now (`undefined` for a gap). */
  value() {
    return this._owner.read(this._handle, 'value');
  }
  get windowSize() {
    return this.stats().windowSize;
  }
  stats() {
    return this._owner.read(this._handle, 'stats');
  }
}

/** A rolling window, as pond-ts `LiveRollingAggregation`. */
export class LiveRollingAggregation extends LiveRollingNode {}
/** Several rolling windows at once, as pond-ts `LiveFusedRolling`. */
export class LiveFusedRolling extends LiveRollingNode {}

/** Reducers over everything the source holds, as pond-ts `LiveReduce`. */
export class LiveReduce extends LiveNode {
  value() {
    return this._owner.read(this._handle, 'value');
  }
  stats() {
    return this._owner.read(this._handle, 'stats');
  }
}

class LivePartitionedNode extends LiveNode {
  /** Each partition value with its series (or its chain's last node). */
  toMap() {
    const o = this._owner;
    return new Map(
      o.read(this._handle, 'toMap').map(([k, h, cls]) => [k, o.node(h, cls)]),
    );
  }
  /** One series of what every partition holds (or its chain emits). */
  collect(options) {
    return this._build('collect', options === undefined ? [] : [options]);
  }
  /**
   * `factory(sub)` chained on each partition, gathered into one series.
   * The factory runs once, on a recorder: it must return the chain built
   * on its argument (no branching per partition).
   */
  apply(factory, options) {
    const chain = factory(new LiveChain());
    if (!(chain instanceof LiveChain))
      throw new TypeError(
        'apply: the factory must return the chain it built on its argument',
      );
    return this._build('apply', [chain.steps, options]);
  }
}

/** Events split by a column, as pond-ts `LivePartitionedSeries`. */
export class LivePartitionedSeries extends LivePartitionedNode {
  stats() {
    return this._owner.read(this._handle, 'stats');
  }
}
/** A chain built on every partition, as pond-ts `LivePartitionedView`. */
export class LivePartitionedView extends LivePartitionedNode {}
/** Rolling windows per partition on a clock, as pond-ts `LivePartitionedFusedRolling`. */
export class LivePartitionedFusedRolling extends LiveNode {
  stats() {
    return this._owner.read(this._handle, 'stats');
  }
}
/** A rolling window per partition on a clock, as pond-ts `LivePartitionedSyncRolling`. */
export class LivePartitionedSyncRolling extends LiveNode {
  stats() {
    return this._owner.read(this._handle, 'stats');
  }
}

const LIVE_CLASSES = {
  LiveSeries,
  LiveView,
  LiveAggregation,
  LiveRollingAggregation,
  LiveFusedRolling,
  LiveReduce,
  LivePartitionedSeries,
  LivePartitionedView,
  LivePartitionedFusedRolling,
  LivePartitionedSyncRolling,
};

/**
 * Number-only rows (a time in ms, then numbers or `undefined`) go to Rust
 * without JSON; anything else (a NaN cell, text, `null`) returns `NOT_FAST`
 * for the JSON path, which checks it as pond-ts does.
 */
function fastPush(id, rows, width) {
  if (rows.length === 1) {
    const row = rows[0];
    if (!Array.isArray(row) || row.length !== width) return NOT_FAST;
    let t = row[0];
    if (typeof t !== 'number') {
      if (!(t instanceof Date)) return NOT_FAST;
      t = t.getTime();
    }
    for (let c = 1; c < width; c++) {
      const v = row[c];
      if (v === undefined) continue;
      if (typeof v !== 'number' || v !== v) return NOT_FAST;
    }
    const cell = (v) => (v === undefined ? NaN : v);
    switch (width) {
      case 2:
        return wasm.live_push1(id, t, cell(row[1]));
      case 3:
        return wasm.live_push2(id, t, cell(row[1]), cell(row[2]));
      case 4:
        return wasm.live_push3(id, t, cell(row[1]), cell(row[2]), cell(row[3]));
      default:
        return wasm.live_push_numbers(
          id,
          t,
          Float64Array.from(row.slice(1), cell),
        );
    }
  }
  const flat = new Float64Array(rows.length * width);
  let j = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== width) return NOT_FAST;
    let t = row[0];
    if (typeof t !== 'number') {
      if (!(t instanceof Date)) return NOT_FAST;
      t = t.getTime();
    }
    flat[j++] = t;
    for (let c = 1; c < width; c++) {
      const v = row[c];
      if (v === undefined) flat[j++] = NaN;
      else if (typeof v !== 'number' || v !== v) return NOT_FAST;
      else flat[j++] = v;
    }
  }
  return wasm.live_push_many_numbers(id, flat, width);
}

/** @internal How many live series are alive in WebAssembly memory. */
export const livesAlive = () => wasm.lives_alive();

export const version = wasm.pond_rs_version();
/** @internal How many series are alive in WebAssembly memory. */
export const alive = () => wasm.series_alive();
/** @internal How many calendars are alive in WebAssembly memory. */
export const calendarsAlive = () => wasm.calendars_alive();
