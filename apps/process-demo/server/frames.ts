/**
 * Getting a column to a chart that lives in another process — M3.
 *
 * The demo plan called this a fork: an assembled `TimeSeries` versus
 * per-column arrays into a layer. It is not one, and building it settled
 * why.
 *
 * `@pond-ts/charts` already traverses columnar — the key axis is a
 * zero-copy `subarray` over the key buffer, values land in a
 * `Float64Array`, and no per-row object is allocated on the render path.
 * So the layer's `series` + `column` signature is not the problem it
 * looked like; it is satisfied perfectly well by a series the *consumer*
 * builds.
 *
 * That is the answer. A `TimeSeries` cannot cross a wire, so assembling
 * one on the server is pure waste — `run({ assemble: false })`. What
 * crosses is the raw buffers, and `TimeSeries.fromColumns` **adopts a
 * `Float64Array` zero-copy** and reads a NaN cell as a gap, so the
 * receiving side reassembles for nothing.
 *
 * Encoding is base64 over the buffer rather than an array of JSON
 * numbers. `[184.51234567, …]` costs roughly 12 bytes a value in text and
 * has to be parsed one number at a time; the buffer is 8 bytes a value
 * flat, and `atob` + `Float64Array` on the far side is one pass.
 */

import type { Column, SeriesSchema, TimeSeries } from 'pond-ts';

/** One request's drawable values, in the shape the browser rebuilds from. */
export interface Frames {
  readonly length: number;
  /** Epoch-ms keys, base64 of a `Float64Array`. */
  readonly key: string;
  /** Column name → base64 of a `Float64Array`, NaN where the cell is a gap. */
  readonly columns: Readonly<Record<string, string>>;
  /** Bytes on the wire before JSON framing — the number M3 is about. */
  readonly bytes: number;
}

function toBase64(buffer: Float64Array): string {
  return Buffer.from(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  ).toString('base64');
}

/**
 * Reads a column into a dense `Float64Array`, gaps as NaN.
 *
 * Deliberately `read(i)` rather than the bulk `toFloat64Array()`: the
 * bulk reader writes `0` for a missing cell, which would draw a warm-up
 * as a plunge to zero rather than as absent. That is charts F-2 seen from
 * a second direction — the bulk path needs a `missing` option before
 * anything with gaps can use it.
 */
function densify(column: Column): Float64Array {
  const out = new Float64Array(column.length);
  for (let i = 0; i < column.length; i += 1) {
    const v = column.read(i);
    out[i] = typeof v === 'number' ? v : NaN;
  }
  return out;
}

export function toFrames(
  series: TimeSeries<SeriesSchema>,
  columns: Readonly<Record<string, Column>>,
): Frames {
  const length = series.length;
  const keys = series.keyColumn().begin.subarray(0, length);
  const encoded: Record<string, string> = {};
  let bytes = keys.byteLength;
  for (const [name, column] of Object.entries(columns)) {
    const packed = densify(column);
    bytes += packed.byteLength;
    encoded[name] = toBase64(packed);
  }
  return { length, key: toBase64(keys), columns: encoded, bytes };
}
