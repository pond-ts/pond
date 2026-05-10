import type { EventForSchema, SeriesSchema, ColumnValue } from '../types.js';
import type { IntervalValue } from '../temporal.js';
import type { AggregateReducer } from '../types.js';
import { resolveReducer } from '../reducers/index.js';

export type ColumnarNumberBuffer = {
  readonly kind: 'number';
  readonly values: Float64Array;
  readonly validity?: Uint8Array;
};

export type ColumnarBooleanBuffer = {
  readonly kind: 'boolean';
  readonly values: Uint8Array;
  readonly validity?: Uint8Array;
};

export type ColumnarStringBuffer = {
  readonly kind: 'string';
  readonly dictionary?: ReadonlyArray<string>;
  readonly indices?: Int32Array;
  readonly values?: ReadonlyArray<string | undefined>;
  readonly validity?: Uint8Array;
};

export type ColumnarArrayBuffer = {
  readonly kind: 'array';
  readonly offsets?: Int32Array;
  readonly values?: ColumnarBuffer;
  readonly fallback?: ReadonlyArray<readonly unknown[] | undefined>;
  readonly validity?: Uint8Array;
};

export type ColumnarBuffer =
  | ColumnarNumberBuffer
  | ColumnarBooleanBuffer
  | ColumnarStringBuffer
  | ColumnarArrayBuffer;

export type ColumnarStoreShape<S extends SeriesSchema> = {
  readonly schema: S;
  readonly length: number;
  readonly keyKind: S[0]['kind'];
  readonly beginMs: Float64Array;
  readonly endMs: Float64Array;
  readonly intervalValues: ReadonlyArray<IntervalValue> | undefined;
  readonly columns: ReadonlyMap<string, ColumnarBuffer>;
};

export type ColumnarChartBuffer = {
  readonly x: Float64Array;
  readonly yByColumn: ReadonlyMap<string, Float64Array>;
  readonly validityByColumn: ReadonlyMap<string, Uint8Array>;
  readonly length: number;
};

type NumericPrefix = {
  readonly sum: Float64Array;
  readonly count: Int32Array;
};

export class ColumnarStore<S extends SeriesSchema> {
  readonly schema: S;
  readonly length: number;
  readonly keyKind: S[0]['kind'];
  readonly beginMs: Float64Array;
  readonly endMs: Float64Array;
  readonly intervalValues: ReadonlyArray<IntervalValue> | undefined;
  readonly columns: ReadonlyMap<string, ColumnarBuffer>;
  readonly #numericPrefixes = new Map<string, NumericPrefix>();
  readonly #validityPrefixes = new Map<string, Int32Array>();

  private constructor(shape: ColumnarStoreShape<S>) {
    this.schema = shape.schema;
    this.length = shape.length;
    this.keyKind = shape.keyKind;
    this.beginMs = shape.beginMs;
    this.endMs = shape.endMs;
    this.intervalValues = shape.intervalValues;
    this.columns = shape.columns;
  }

  static fromEvents<S extends SeriesSchema>(
    schema: S,
    events: ReadonlyArray<EventForSchema<S>>,
  ): ColumnarStore<S> {
    const length = events.length;
    const beginMs = new Float64Array(length);
    const endMs = new Float64Array(length);
    const intervalValues: IntervalValue[] | undefined =
      schema[0]!.kind === 'interval' ? new Array(length) : undefined;

    for (let index = 0; index < length; index += 1) {
      const key = events[index]!.key();
      beginMs[index] = key.begin();
      endMs[index] = key.end();
      if (intervalValues) {
        intervalValues[index] = (
          key as unknown as { valueOf(): IntervalValue }
        ).valueOf();
      }
    }

    const columns = new Map<string, ColumnarBuffer>();
    for (const column of schema.slice(1)) {
      columns.set(
        column.name,
        buildColumnBuffer(column.kind, column.name, events),
      );
    }

    return new ColumnarStore({
      schema,
      length,
      keyKind: schema[0]!.kind,
      beginMs,
      endMs,
      intervalValues,
      columns,
    });
  }

  valueAt(column: string, index: number): ColumnValue | undefined {
    const buffer = this.columns.get(column);
    if (!buffer || index < 0 || index >= this.length) return undefined;
    return valueFromBuffer(buffer, index);
  }

  valuesForColumn(column: string): ReadonlyArray<ColumnValue | undefined> {
    const buffer = this.columns.get(column);
    if (!buffer) return [];
    const values = new Array<ColumnValue | undefined>(this.length);
    for (let index = 0; index < this.length; index += 1) {
      values[index] = valueFromBuffer(buffer, index);
    }
    return values;
  }

  reduceColumn(
    column: string,
    reducer: AggregateReducer,
  ): ColumnValue | undefined {
    return this.reduceColumnRange(column, reducer, 0, this.length);
  }

  reduceColumnRange(
    column: string,
    reducer: AggregateReducer,
    start: number,
    end: number,
  ): ColumnValue | undefined {
    const boundedStart = Math.max(0, Math.min(start, this.length));
    const boundedEnd = Math.max(boundedStart, Math.min(end, this.length));

    if (typeof reducer !== 'string') {
      return reducer(
        this.valuesForColumnRange(column, boundedStart, boundedEnd),
      );
    }

    const buffer = this.columns.get(column);
    if (!buffer) {
      return resolveReducer(reducer).reduce([], []);
    }

    const direct = this.#reduceDirect(
      column,
      buffer,
      reducer,
      boundedStart,
      boundedEnd,
    );
    if (direct.handled) {
      return direct.value;
    }

    const defined: ColumnValue[] = [];
    const numeric: number[] = [];
    for (let index = boundedStart; index < boundedEnd; index += 1) {
      const value = valueFromBuffer(buffer, index);
      if (value !== undefined) {
        defined.push(value);
        if (typeof value === 'number') numeric.push(value);
      }
    }
    return resolveReducer(reducer).reduce(defined, numeric);
  }

  valuesForColumnRange(
    column: string,
    start: number,
    end: number,
  ): ReadonlyArray<ColumnValue | undefined> {
    const buffer = this.columns.get(column);
    if (!buffer) return [];
    const boundedStart = Math.max(0, Math.min(start, this.length));
    const boundedEnd = Math.max(boundedStart, Math.min(end, this.length));
    const values = new Array<ColumnValue | undefined>(
      boundedEnd - boundedStart,
    );
    for (let index = boundedStart; index < boundedEnd; index += 1) {
      values[index - boundedStart] = valueFromBuffer(buffer, index);
    }
    return values;
  }

  estimatedBytes(): number {
    let bytes = this.beginMs.byteLength + this.endMs.byteLength;
    for (const buffer of this.columns.values()) {
      bytes += estimateBufferBytes(buffer);
    }
    return bytes;
  }

  toChartBuffer(
    columns?: ReadonlyArray<string>,
    options: { copy?: boolean } = {},
  ): ColumnarChartBuffer {
    const requested = new Set(
      columns ??
        this.schema
          .slice(1)
          .filter((column) => column.kind === 'number')
          .map((column) => column.name),
    );
    const yByColumn = new Map<string, Float64Array>();
    const validityByColumn = new Map<string, Uint8Array>();

    for (const name of requested) {
      const buffer = this.columns.get(name);
      if (!buffer || buffer.kind !== 'number') continue;

      yByColumn.set(name, options.copy ? buffer.values.slice() : buffer.values);
      if (buffer.validity) {
        validityByColumn.set(
          name,
          options.copy ? buffer.validity.slice() : buffer.validity,
        );
      }
    }

    return {
      x: options.copy ? this.beginMs.slice() : this.beginMs,
      yByColumn,
      validityByColumn,
      length: this.length,
    };
  }

  #reduceDirect(
    column: string,
    buffer: ColumnarBuffer,
    reducer: string,
    start: number,
    end: number,
  ): { handled: true; value: ColumnValue | undefined } | { handled: false } {
    if (reducer === 'count') {
      return {
        handled: true,
        value: this.#countDefinedRange(column, buffer, start, end),
      };
    }

    if (buffer.kind === 'number') {
      switch (reducer) {
        case 'sum': {
          const prefix = this.#numericPrefix(column, buffer);
          return {
            handled: true,
            value: prefix.sum[end]! - prefix.sum[start]!,
          };
        }
        case 'avg': {
          const prefix = this.#numericPrefix(column, buffer);
          const count = prefix.count[end]! - prefix.count[start]!;
          return {
            handled: true,
            value:
              count === 0
                ? undefined
                : (prefix.sum[end]! - prefix.sum[start]!) / count,
          };
        }
        case 'min': {
          let min: number | undefined;
          for (let index = start; index < end; index += 1) {
            if (!isValid(buffer, index)) continue;
            const value = buffer.values[index]!;
            if (min === undefined || value < min) min = value;
          }
          return { handled: true, value: min };
        }
        case 'max': {
          let max: number | undefined;
          for (let index = start; index < end; index += 1) {
            if (!isValid(buffer, index)) continue;
            const value = buffer.values[index]!;
            if (max === undefined || value > max) max = value;
          }
          return { handled: true, value: max };
        }
        default:
          return { handled: false };
      }
    }

    return { handled: false };
  }

  #numericPrefix(column: string, buffer: ColumnarNumberBuffer): NumericPrefix {
    const cached = this.#numericPrefixes.get(column);
    if (cached) return cached;

    const sum = new Float64Array(this.length + 1);
    const count = new Int32Array(this.length + 1);
    for (let index = 0; index < this.length; index += 1) {
      sum[index + 1] = sum[index]!;
      count[index + 1] = count[index]!;
      if (isValid(buffer, index)) {
        sum[index + 1]! += buffer.values[index]!;
        count[index + 1]! += 1;
      }
    }

    const prefix = { sum, count };
    this.#numericPrefixes.set(column, prefix);
    return prefix;
  }

  #countDefinedRange(
    column: string,
    buffer: ColumnarBuffer,
    start: number,
    end: number,
  ): number {
    if (!buffer.validity) return end - start;

    let prefix = this.#validityPrefixes.get(column);
    if (!prefix) {
      prefix = new Int32Array(this.length + 1);
      for (let index = 0; index < this.length; index += 1) {
        prefix[index + 1] = prefix[index]! + (buffer.validity[index] ?? 0);
      }
      this.#validityPrefixes.set(column, prefix);
    }
    return prefix[end]! - prefix[start]!;
  }
}

function buildColumnBuffer<S extends SeriesSchema>(
  kind: string,
  name: string,
  events: ReadonlyArray<EventForSchema<S>>,
): ColumnarBuffer {
  switch (kind) {
    case 'number':
      return buildNumberBuffer(name, events);
    case 'boolean':
      return buildBooleanBuffer(name, events);
    case 'string':
      return buildStringBuffer(name, events);
    case 'array':
      return buildArrayBuffer(name, events);
    default:
      throw new TypeError(`unsupported column kind '${kind}'`);
  }
}

function buildNumberBuffer<S extends SeriesSchema>(
  name: string,
  events: ReadonlyArray<EventForSchema<S>>,
): ColumnarNumberBuffer {
  const values = new Float64Array(events.length);
  const validity = new Uint8Array(events.length);
  let allValid = true;

  for (let index = 0; index < events.length; index += 1) {
    const data = events[index]!.data() as Record<string, unknown>;
    const value = data[name] as number | undefined;
    if (value === undefined) {
      allValid = false;
      continue;
    }
    values[index] = value;
    validity[index] = 1;
  }

  return allValid
    ? { kind: 'number', values }
    : { kind: 'number', values, validity };
}

function buildBooleanBuffer<S extends SeriesSchema>(
  name: string,
  events: ReadonlyArray<EventForSchema<S>>,
): ColumnarBooleanBuffer {
  const values = new Uint8Array(events.length);
  const validity = new Uint8Array(events.length);
  let allValid = true;

  for (let index = 0; index < events.length; index += 1) {
    const data = events[index]!.data() as Record<string, unknown>;
    const value = data[name] as boolean | undefined;
    if (value === undefined) {
      allValid = false;
      continue;
    }
    values[index] = value ? 1 : 0;
    validity[index] = 1;
  }

  return allValid
    ? { kind: 'boolean', values }
    : { kind: 'boolean', values, validity };
}

function buildStringBuffer<S extends SeriesSchema>(
  name: string,
  events: ReadonlyArray<EventForSchema<S>>,
): ColumnarStringBuffer {
  const dictionary: string[] = [];
  const dictionaryIndex = new Map<string, number>();
  const indices = new Int32Array(events.length);
  const validity = new Uint8Array(events.length);
  let allValid = true;

  indices.fill(-1);
  for (let index = 0; index < events.length; index += 1) {
    const data = events[index]!.data() as Record<string, unknown>;
    const value = data[name] as string | undefined;
    if (value === undefined) {
      allValid = false;
      continue;
    }

    let encoded = dictionaryIndex.get(value);
    if (encoded === undefined) {
      encoded = dictionary.length;
      dictionaryIndex.set(value, encoded);
      dictionary.push(value);
    }
    indices[index] = encoded;
    validity[index] = 1;
  }

  return allValid
    ? { kind: 'string', dictionary, indices }
    : { kind: 'string', dictionary, indices, validity };
}

function buildArrayBuffer<S extends SeriesSchema>(
  name: string,
  events: ReadonlyArray<EventForSchema<S>>,
): ColumnarArrayBuffer {
  const fallback = new Array<readonly unknown[] | undefined>(events.length);
  const validity = new Uint8Array(events.length);
  let allValid = true;

  for (let index = 0; index < events.length; index += 1) {
    const data = events[index]!.data() as Record<string, unknown>;
    const value = data[name] as readonly unknown[] | undefined;
    if (value === undefined) {
      allValid = false;
      continue;
    }
    fallback[index] = value;
    validity[index] = 1;
  }

  return allValid
    ? { kind: 'array', fallback }
    : { kind: 'array', fallback, validity };
}

function isValid(buffer: { validity?: Uint8Array }, index: number): boolean {
  return buffer.validity === undefined || buffer.validity[index] === 1;
}

function valueFromBuffer(
  buffer: ColumnarBuffer,
  index: number,
): ColumnValue | undefined {
  if (!isValid(buffer, index)) return undefined;

  switch (buffer.kind) {
    case 'number':
      return buffer.values[index];
    case 'boolean':
      return buffer.values[index] === 1;
    case 'string': {
      if (buffer.indices && buffer.dictionary) {
        const encoded = buffer.indices[index] ?? -1;
        return encoded < 0 ? undefined : buffer.dictionary[encoded];
      }
      return buffer.values?.[index];
    }
    case 'array':
      return buffer.fallback?.[index] as ColumnValue | undefined;
  }
}

function estimateBufferBytes(buffer: ColumnarBuffer): number {
  switch (buffer.kind) {
    case 'number':
      return buffer.values.byteLength + (buffer.validity?.byteLength ?? 0);
    case 'boolean':
      return buffer.values.byteLength + (buffer.validity?.byteLength ?? 0);
    case 'string':
      return (
        (buffer.indices?.byteLength ?? 0) +
        (buffer.validity?.byteLength ?? 0) +
        (buffer.dictionary?.reduce((sum, value) => sum + value.length * 2, 0) ??
          0)
      );
    case 'array':
      return (
        (buffer.offsets?.byteLength ?? 0) + (buffer.validity?.byteLength ?? 0)
      );
  }
}
