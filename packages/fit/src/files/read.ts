import { Activity } from '../activity/index.js';
import { parseFit } from './fit.js';
import { parseGpx } from './gpx.js';
import { parseTcx } from './tcx.js';
import type { ReadOptions } from './options.js';

/** UTF-8 bytes as text. `TextDecoder` is in every browser and in Node, but
 *  not in the ES lib the package compiles against, so it is looked up. */
function decode(b: ArrayBuffer | Uint8Array): string {
  const TD = (
    globalThis as unknown as {
      TextDecoder: new () => { decode(b: ArrayBuffer | Uint8Array): string };
    }
  ).TextDecoder;
  return new TD().decode(b);
}

/** Which format some bytes are: FIT by its header (`.FIT` at byte 8), GPX or
 *  TCX by their root element. `null` when it's none of them. */
export function activityFormat(
  input: ArrayBuffer | Uint8Array | string,
): 'fit' | 'gpx' | 'tcx' | null {
  if (typeof input !== 'string') {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (
      b.length >= 12 &&
      b[8] === 0x2e && // .
      b[9] === 0x46 && // F
      b[10] === 0x49 && // I
      b[11] === 0x54 // T
    )
      return 'fit';
  }
  const head = (typeof input === 'string' ? input : decode(input)).slice(
    0,
    4096,
  );
  if (/<gpx[\s>]/.test(head)) return 'gpx';
  if (/<TrainingCenterDatabase[\s>]/.test(head)) return 'tcx';
  return null;
}

/**
 * Read a FIT, GPX or TCX file into an {@link Activity}, telling the format
 * from the bytes. Text formats may be passed as a string. Throws when the
 * input is none of the three (gzipped files must be unpacked first).
 */
export function readActivity(
  input: ArrayBuffer | Uint8Array | string,
  options: ReadOptions = {},
): Activity {
  const format = activityFormat(input);
  if (format === 'fit')
    return Activity.from(parseFit(input as ArrayBuffer | Uint8Array, options));
  if (format === null)
    throw new Error('readActivity: not a FIT, GPX or TCX file');
  const text = typeof input === 'string' ? input : decode(input);
  return Activity.from(
    format === 'gpx' ? parseGpx(text, options) : parseTcx(text, options),
  );
}
