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

// Arguments go to Rust as JSON; these encodings carry what JSON cannot.
function encode(v) {
  if (v instanceof TimeSeries) return { series: v.id };
  if (v instanceof Sequence) return v.toJSON();
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { f64: 'NaN' };
    if (v === Infinity) return { f64: 'inf' };
    if (v === -Infinity) return { f64: '-inf' };
    if (Object.is(v, -0)) return { f64: '-0' };
    return v;
  }
  if (typeof v === 'function')
    throw new TypeError(
      '@pond-ts/rs does not take callbacks yet (filter, mapColumns, scan, collapse)',
    );
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v))
      if (x !== undefined) out[k] = encode(x);
    return out;
  }
  return v;
}

function decode(result) {
  if (result.series !== undefined) return new TimeSeries(TOKEN, result.series);
  if (result.groups !== undefined)
    return new Map(
      result.groups.map(([k, id]) => [k, new TimeSeries(TOKEN, id)]),
    );
  if (result.record !== undefined) return result.record;
  return result.records;
}

const KEY_KINDS = ['time', 'timeRange', 'interval'];

// A pond-ts `toJSON()` object with numeric times, as columns for Rust.
function columnsOf(input) {
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
    if ((def.kind ?? 'number') === 'number') {
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const x = rows[i][c + 1];
        v[i] = x === null || x === undefined ? NaN : x;
      }
      return v;
    }
    return rows.map((r) => r[c + 1] ?? null);
  });
  return { begin, end, labels, columns };
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
      const { begin, end, labels, columns } = columnsOf(input);
      this.#id = wasm.series_from_columns(
        input.name ?? '',
        JSON.stringify(input.schema),
        begin,
        end,
        labels,
        columns,
      );
    }
    finalizer.register(this, this.#id, this);
  }

  /** pond-ts `toJSON()` shape in; times as ms or as text. */
  static fromJSON(input, options = {}) {
    if (numericKeys(input.rows)) return new TimeSeries(input);
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
    const [first, ...rest] = list;
    return first.#call('joinMany', [rest, options]);
  }

  static concat(list) {
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

  #call(op, args) {
    return decode(wasm.series_call(this.id, op, JSON.stringify(encode(args))));
  }

  /** `partitionBy(by)`: chain methods, then `collect()` or `toMap()`. */
  partitionBy(by) {
    return new PartitionedSeries((steps, end) =>
      this.#call('partitionBy', [by, steps, end]),
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

export const version = wasm.pond_rs_version();
/** @internal How many series are alive in WebAssembly memory. */
export const alive = () => wasm.series_alive();
