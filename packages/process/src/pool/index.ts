/**
 * `@pond-ts/process/pool` — whole requests across resident workers.
 *
 * A separate entry point because it is **Node-only** (it imports
 * `node:worker_threads`); the package index stays runtime-neutral.
 *
 * See {@link HostPool} for which of the two parallelism shapes this is,
 * and why this one comes first.
 */

export { HostPool } from './pool.js';
export type { HostPoolOptions } from './pool.js';
export type { PoolSetup, PoolSetupConfig } from './protocol.js';
export { toWire, fromWire } from './wire.js';
export type { WireResult, WireColumn } from './wire.js';
