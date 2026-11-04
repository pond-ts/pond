import type { ActivitySource } from '../types.js';

/** What a reader stamps onto the activity it reads (the file rarely says). */
export interface ReadOptions {
  /** The activity id; defaults to `<format>:<start time>`
   *  (`fit:2026-11-04T08:00:00.000Z`). */
  id?: string;
  /** The name, over the file's own (if it has one). */
  name?: string;
  /** The sport label, over the file's own. */
  sportType?: string;
  /** Where the activity came from; defaults to `'file'`. */
  source?: ActivitySource;
}

/** The keys of `T` that may be left out. */
type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

/** `T` with each optional field allowed to be `undefined` (required fields
 *  stay required and defined). */
type Loose<T> = Omit<T, OptionalKeys<T>> & {
  [K in OptionalKeys<T>]?: T[K] | undefined;
};

/** An object with every `undefined`-valued key dropped, so optional fields
 *  are absent rather than present-as-undefined. */
export function compact<T extends object>(o: Loose<T>): T {
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}
