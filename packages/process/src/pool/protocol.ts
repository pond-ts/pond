/**
 * The pool's worker protocol — [PND-PROCPAR].
 *
 * Deliberately tiny: one request shape, one response shape, correlated
 * by a monotonic id. Everything interesting is already carried by the
 * plan format.
 */

import type { Registry } from '../plan/registry.js';
import type { SourceRegistry } from '../plan/source.js';
import type { Units } from '../plan/types.js';
import type { AsyncEnvelope } from '../plan/host.js';
import type { WireResult } from './wire.js';
import type { SeriesSchema, TimeSeries } from 'pond-ts';

/**
 * What a worker's setup module returns — the same shape {@link Host}
 * takes, plus datasets to seed.
 *
 * Named as a module specifier rather than passed as a value because a
 * registry is functions, and functions do not survive structured clone.
 * Both isolates import the same module; the ops are shared code.
 */
export interface PoolSetupConfig {
  readonly registry: Registry;
  readonly units?: Units;
  readonly sources?: SourceRegistry;
  /**
   * Datasets to `add` at start-up. Optional — a host with a
   * `SourceRegistry` can instead load datasets on demand by identity,
   * which is the shape that avoids sending data to workers at all.
   */
  readonly datasets?: Readonly<Record<string, TimeSeries<SeriesSchema>>>;
}

export type PoolSetup = (
  options?: unknown,
) => PoolSetupConfig | Promise<PoolSetupConfig>;

export interface WorkerRequest {
  readonly id: number;
  readonly envelope: AsyncEnvelope;
}

export type WorkerResponse =
  | { readonly id: number; readonly ok: true; readonly wire: WireResult }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: string;
      readonly name?: string;
    };
