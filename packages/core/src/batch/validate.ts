import { Interval } from '../core/interval.js';
import { Event } from '../core/event.js';
import { Time } from '../core/time.js';
import { TimeRange } from '../core/time-range.js';
import type {
  EventKey,
  IntervalInput,
  TimeRangeInput,
} from '../core/temporal.js';
import { ValidationError } from '../core/errors.js';
import type {
  EventForSchema,
  EventKeyForSchema,
  FirstColKind,
  SeriesSchema,
  TimeSeriesInput,
  ValueForKind,
} from '../types.js';

const FIRST_COLUMN_KINDS: ReadonlySet<FirstColKind> = new Set([
  'time',
  'interval',
  'timeRange',
]);

function assertCellKind(
  kind: string,
  value: unknown,
  row: number,
  col: number,
): void {
  if (value === undefined) {
    return;
  }

  switch (kind) {
    case 'time': {
      const ok =
        value instanceof Time ||
        (value instanceof Date && Number.isFinite(value.getTime())) ||
        (typeof value === 'number' && Number.isFinite(value));
      if (!ok) {
        throw new ValidationError(
          `row ${row} col ${col}: expected time as Time, Date or finite number`,
        );
      }
      return;
    }
    case 'interval': {
      const ok =
        value instanceof Interval ||
        (Array.isArray(value) &&
          value.length === 3 &&
          (typeof value[0] === 'string' || typeof value[0] === 'number')) ||
        (!Array.isArray(value) &&
          typeof value === 'object' &&
          value !== null &&
          'value' in value &&
          'start' in value &&
          'end' in value);
      if (!ok) {
        throw new ValidationError(
          `row ${row} col ${col}: expected interval as Interval or { value, start, end }`,
        );
      }
      return;
    }
    case 'timeRange': {
      const ok =
        value instanceof TimeRange ||
        (Array.isArray(value) && value.length === 2) ||
        (!Array.isArray(value) &&
          typeof value === 'object' &&
          value !== null &&
          'start' in value &&
          'end' in value);
      if (!ok) {
        throw new ValidationError(
          `row ${row} col ${col}: expected timeRange as TimeRange or { start, end }`,
        );
      }
      return;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError(
          `row ${row} col ${col}: expected finite number`,
        );
      }
      return;
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new ValidationError(`row ${row} col ${col}: expected string`);
      }
      return;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new ValidationError(`row ${row} col ${col}: expected boolean`);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        throw new ValidationError(
          `row ${row} col ${col}: expected array of scalars`,
        );
      }
      for (let i = 0; i < value.length; i += 1) {
        const element = value[i];
        const ok =
          (typeof element === 'number' && Number.isFinite(element)) ||
          typeof element === 'string' ||
          typeof element === 'boolean';
        if (!ok) {
          throw new ValidationError(
            `row ${row} col ${col}: array element ${i} must be a finite number, string, or boolean`,
          );
        }
      }
      return;
    }
    default:
      throw new ValidationError(
        `row ${row} col ${col}: unknown kind '${kind}'`,
      );
  }
}

function normalizeKey(
  kind: FirstColKind,
  value: unknown,
  row: number,
  col: number,
): Time | TimeRange | Interval {
  try {
    switch (kind) {
      case 'time':
        return value instanceof Time ? value : new Time(value as number | Date);
      case 'timeRange':
        return value instanceof TimeRange
          ? value
          : new TimeRange(value as TimeRangeInput);
      case 'interval':
        return value instanceof Interval
          ? value
          : new Interval(value as IntervalInput);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid key';
    throw new ValidationError(`row ${row} col ${col}: ${message}`);
  }
}

function compareKeys(left: EventKey, right: EventKey): number {
  if (left.begin() !== right.begin()) {
    return left.begin() - right.begin();
  }
  return left.end() - right.end();
}

export function validateAndNormalize<S extends SeriesSchema>(
  input: TimeSeriesInput<S>,
): EventForSchema<S>[] {
  const { schema, rows } = input;

  if (!schema.length) {
    throw new ValidationError('schema must have at least one column');
  }

  if (!FIRST_COLUMN_KINDS.has(schema[0]!.kind)) {
    throw new ValidationError(
      'first column must be one of: time, interval, timeRange',
    );
  }

  for (let col = 1; col < schema.length; col += 1) {
    const kind = schema[col]!.kind;
    if (
      kind !== 'number' &&
      kind !== 'string' &&
      kind !== 'boolean' &&
      kind !== 'array'
    ) {
      throw new ValidationError(
        `column ${col} has unsupported value kind '${kind}'`,
      );
    }
  }

  const normalized = rows.map((row, rowIndex) => {
    if (row.length !== schema.length) {
      throw new ValidationError(
        `row ${rowIndex} expected ${schema.length} values, got ${row.length}`,
      );
    }

    const keyDef = schema[0]!;
    const rawKey = row[0] as ValueForKind<typeof keyDef.kind>;
    const normalizedKey = normalizeKey(
      keyDef.kind,
      rawKey,
      rowIndex,
      0,
    ) as unknown as EventKeyForSchema<S>;
    const data: Record<string, unknown> = {};

    for (let col = 1; col < schema.length; col += 1) {
      const def = schema[col]!;
      const value = row[col] as ValueForKind<typeof def.kind> | undefined;
      const required = def.required !== false;

      if (value === undefined && required) {
        throw new ValidationError(
          `row ${rowIndex} col ${col} (${def.name}) is required`,
        );
      }

      assertCellKind(def.kind, value, rowIndex, col);
      // Array cells are frozen (after a shallow copy) so downstream consumers
      // can safely treat them as immutable without callers losing control of
      // the input array.
      if (def.kind === 'array' && Array.isArray(value)) {
        data[def.name] = Object.freeze(value.slice());
      } else {
        data[def.name] = value;
      }
    }

    return new Event(normalizedKey, data) as unknown as EventForSchema<S>;
  });

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (compareKeys(previous.key(), current.key()) > 0) {
      throw new ValidationError(`row ${index} is out of order`);
    }
  }

  return Object.freeze(normalized.slice()) as EventForSchema<S>[];
}
