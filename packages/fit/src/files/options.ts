import type { ActivitySource } from '../types.js';

/** What a reader stamps onto the activity it reads (the file rarely says). */
export interface ReadOptions {
  /** The activity id; defaults to `<format>:<name>` (`fit:Morning Run`). */
  id?: string;
  /** The name, over the file's own (if it has one). */
  name?: string;
  /** The sport label, over the file's own. */
  sportType?: string;
  /** Where the activity came from; defaults to `'file'`. */
  source?: ActivitySource;
}

/** An object with every `undefined`-valued key dropped, so optional fields
 *  are absent rather than present-as-undefined. */
export function compact<T extends object>(o: {
  [K in keyof T]: T[K] | undefined;
}): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
