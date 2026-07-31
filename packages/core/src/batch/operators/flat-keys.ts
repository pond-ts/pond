/**
 * **The flattened key convention** — how a two-edged pond key is spelled when
 * the destination format has no interval-of-time type, which is every columnar
 * format pond speaks.
 *
 * A `time` / `value` key is one number per row and needs no convention. A
 * `timeRange` key is two edges, and an `interval` key is two edges plus a
 * label; both flatten into extra columns named off the key:
 *
 * ```text
 * timeRange  →  timeRange   timeRangeEnd
 * interval   →  interval    intervalEnd    intervalLabel
 * ```
 *
 * `toArrow` established this (Arrow has no interval type), and the JSON
 * columnar doors now read and write the same shape, so one payload spelling
 * serves all four doors. **The names are fully determined**: `FirstColumn`
 * forces a key column's name to equal its kind, so a `timeRange` key is always
 * `timeRange` + `timeRangeEnd` — nothing to configure, nothing to guess.
 *
 * ## Why flattened rather than pairs
 *
 * `[[begin, end], …]` and the row-JSON key vocabulary (`[value, start, end]`)
 * were both considered. Neither works here: the substrate stores `begin` and
 * `end` as **separate** buffers, so a paired spelling needs a per-row un-zip on
 * the way in — a row walk in the middle of the door that exists precisely to
 * avoid row walks. Flattened lands each edge straight in its buffer, which is
 * why it stays O(1) per column rather than O(N).
 *
 * ## Collisions
 *
 * A value column named `timeRangeEnd` alongside a `timeRange` key means one
 * array with two claimants. {@link assertNoFlatKeyCollision} rejects it
 * **unconditionally** on both `fromColumns` and `toColumns` — neither has a
 * way to say "export only some columns", so there is no case in which the
 * collision doesn't matter. `storeToArrow` is the one door that checks
 * *conditionally*, because its `columns` option can select the colliding
 * column out, and then it genuinely never appears.
 *
 * (The export check is not optional politeness: without it `toColumns` writes
 * the key edges first and the value-column loop overwrites them, emitting a
 * payload that contradicts its own schema with the second edge silently gone.
 * The row door builds such a series happily, so it is reachable.)
 */
import { ValidationError } from '../../core/errors.js';
import type { ColumnDef, ColumnSchema } from '../../columnar/index.js';

/** Appended to a two-edged key's name for its second edge. */
export const KEY_END_SUFFIX = 'End';
/** Appended to an `interval` key's name for its label column. */
export const KEY_LABEL_SUFFIX = 'Label';

/** The column names one key occupies in a flattened payload. */
export interface FlatKeyNames {
  /** The key's own name — the `begin` edge, or the whole key for a point key. */
  readonly begin: string;
  /** The second edge. Absent for a point (`time` / `value`) key. */
  readonly end?: string;
  /** The label column. Present only for an `interval` key. */
  readonly label?: string;
}

/** True for the key kinds that span two edges and so need flattening. */
export function isTwoEdgedKey(kind: string): boolean {
  return kind === 'timeRange' || kind === 'interval';
}

/**
 * The flattened column names for a key column. Derived purely from the key's
 * name and kind, so export and ingest cannot disagree about them.
 */
export function flatKeyNames(keyDef: ColumnDef): FlatKeyNames {
  const { name, kind } = keyDef;
  if (kind === 'timeRange') {
    return { begin: name, end: `${name}${KEY_END_SUFFIX}` };
  }
  if (kind === 'interval') {
    return {
      begin: name,
      end: `${name}${KEY_END_SUFFIX}`,
      label: `${name}${KEY_LABEL_SUFFIX}`,
    };
  }
  return { begin: name };
}

/**
 * Reject a schema whose **value** columns would collide with the names a
 * two-edged key flattens into. One array cannot serve both the key's second
 * edge and a value column, and unlike the export side there is no "only if
 * selected" escape — see the module note.
 *
 * A no-op for point keys, which occupy exactly their own name (and duplicate
 * schema names are already rejected by `ColumnarStore.fromTrustedStore`).
 */
export function assertNoFlatKeyCollision(
  op: string,
  schema: ColumnSchema,
): void {
  const keyDef = schema[0];
  if (keyDef === undefined || !isTwoEdgedKey(keyDef.kind)) return;
  const names = flatKeyNames(keyDef);
  const reserved = new Map<string, string>();
  if (names.end !== undefined) reserved.set(names.end, 'second edge');
  if (names.label !== undefined) reserved.set(names.label, 'label');

  for (let i = 1; i < schema.length; i += 1) {
    const role = reserved.get(schema[i]!.name);
    if (role !== undefined) {
      throw new ValidationError(
        `${op}: value column '${schema[i]!.name}' collides with the ` +
          `${role} of the '${keyDef.kind}' key, which flattens to ` +
          `'${names.begin}'` +
          (names.end === undefined ? '' : ` + '${names.end}'`) +
          (names.label === undefined ? '' : ` + '${names.label}'`) +
          ` — rename the column`,
      );
    }
  }
}
