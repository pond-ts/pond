/** Worker protocol for the parallel studies — [PND-SCANKERN]. */

interface Job {
  readonly id: number;
  /** Source values, NaN-as-missing. Shared, read-only to the worker. */
  readonly values: SharedArrayBuffer;
  /** Scratch for the rolling pass. Shared; each worker owns its range. */
  readonly mean: SharedArrayBuffer;
  readonly sd: SharedArrayBuffer;
  readonly period: number;
  /** Output range `[start, end)`. Ranges never overlap across workers. */
  readonly start: number;
  readonly end: number;
}

export type KernelRequest =
  | { readonly kind: 'ping'; readonly id: number }
  | (Job & {
      readonly kind: 'bollinger';
      readonly stdDev: number;
      readonly middle: SharedArrayBuffer;
      readonly upper: SharedArrayBuffer;
      readonly lower: SharedArrayBuffer;
    });

export interface KernelResponse {
  readonly id: number;
  readonly ok: boolean;
  readonly error?: string;
}
