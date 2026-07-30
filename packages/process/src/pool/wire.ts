/**
 * The `RunResult` wire shape — [PND-PROCPAR].
 *
 * A `RunResult` is already almost JSON: `outputs`, `facts`, `explain`,
 * `skipped` and `nodes` are plain data by construction, because the plan
 * layer exists to be spoken over a wire. Two fields are not:
 *
 * - **`columns`** — `Column` instances. Sent as their buffers
 *   ({@link columnBuffers}) and rebuilt on arrival, so a 500k-row answer
 *   crosses as two transferable buffers rather than 500k boxed values.
 * - **`series`** — an assembled `TimeSeries`. **Not sent at all.** A pool
 *   request runs with `assemble: false`; the caller assembles from
 *   `columns` if it wants one, which is [PND-PROCTERM]'s position
 *   anyway (assembly is requested, not assumed) and avoids shipping a
 *   whole schema-bearing object to rebuild something the columns already
 *   describe.
 *
 * A **numeric** column this cannot express as buffers (chunked storage)
 * falls back to a boxed array rather than failing the request — a
 * correct slow answer beats a fast error. A **non-numeric** column has
 * no wire form at all and is refused; see {@link toWireColumn} for why
 * boxing one would produce plausible-looking nonsense rather than an
 * error.
 */

import { columnBuffers, columnFromBuffers, packColumn } from '../column.js';
import { ProcessError } from '../errors.js';
import type { ColumnBuffers } from '../column.js';
import type { Column } from 'pond-ts';
import type { RunResult } from '../plan/run.js';

/** A column on the wire: buffers where possible, boxed where not. */
export type WireColumn =
  | { readonly kind: 'buffers'; readonly data: ColumnBuffers }
  | {
      readonly kind: 'boxed';
      readonly values: readonly (number | undefined)[];
    };

/** A `RunResult` with its columns flattened. `series` is dropped. */
export interface WireResult extends Omit<RunResult, 'series' | 'columns'> {
  readonly columns?: Readonly<Record<string, WireColumn>>;
}

function toWireColumn(column: Column): WireColumn {
  const data = columnBuffers(column);
  if (data !== undefined) return { kind: 'buffers', data };

  // The fallback is for a **numeric** column `columnBuffers` cannot take
  // as buffers — chunked storage, in practice. It is not a general
  // escape hatch: the boxed form is rebuilt with `packColumn`, which
  // reads numbers, so a `string` / `boolean` / `array` column would pack
  // every cell as a defined `NaN` (`Number.isNaN('x')` is false) and
  // arrive as plausible-looking nonsense. Refusing is the only honest
  // answer until the wire grows those kinds.
  if (column.kind !== 'number') {
    throw new ProcessError(
      `HostPool: cannot send a '${column.kind}' column across a worker ` +
        `boundary — only numeric columns have a wire form. Select numeric ` +
        `outputs, or run this request in-process.`,
    );
  }

  const at = column as unknown as { at(i: number): number | undefined };
  const values = new Array<number | undefined>(column.length);
  for (let i = 0; i < column.length; i += 1) values[i] = at.at(i);
  return { kind: 'boxed', values };
}

/**
 * Flattens a result for `postMessage`, collecting the buffers that should
 * be **transferred** rather than copied.
 *
 * The buffers are already private copies (see {@link columnBuffers}), so
 * transferring them detaches nothing the sender still needs.
 */
export function toWire(result: RunResult): {
  wire: WireResult;
  transfer: ArrayBuffer[];
} {
  const transfer: ArrayBuffer[] = [];
  let columns: Record<string, WireColumn> | undefined;

  if (result.columns !== undefined) {
    columns = {};
    for (const [name, column] of Object.entries(result.columns)) {
      const wire = toWireColumn(column);
      columns[name] = wire;
      if (wire.kind === 'buffers') {
        transfer.push(wire.data.values.buffer as ArrayBuffer);
        if (wire.data.bits !== undefined) {
          transfer.push(wire.data.bits.buffer as ArrayBuffer);
        }
      }
    }
  }

  const { series: _series, columns: _columns, ...rest } = result;
  return {
    wire: { ...rest, ...(columns !== undefined && { columns }) },
    transfer,
  };
}

/** Rebuilds a `RunResult` from the wire. Adopts the arrived buffers. */
export function fromWire(wire: WireResult): RunResult {
  // No `columns` key at all ⇒ the two shapes already coincide (every
  // other field is plain data), so there is nothing to rebuild.
  if (wire.columns === undefined) {
    const { columns: _absent, ...rest } = wire;
    return rest;
  }
  const columns: Record<string, Column> = {};
  for (const [name, value] of Object.entries(wire.columns)) {
    columns[name] =
      value.kind === 'buffers'
        ? (columnFromBuffers(value.data) as unknown as Column)
        : (packColumn(value.values) as unknown as Column);
  }
  return { ...wire, columns };
}
