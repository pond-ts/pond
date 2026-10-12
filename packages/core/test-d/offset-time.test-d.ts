/**
 * Type-level tests for `TimeSeries.offsetTime`: the schema (key kind and
 * name included) comes back unchanged, and the offset is milliseconds or a
 * duration string — a malformed unit is rejected at compile time.
 */
import { TimeSeries } from '../src/index.js';

const ranged = new TimeSeries({
  name: 'r',
  schema: [
    { name: 'timeRange', kind: 'timeRange' },
    { name: 'v', kind: 'number' },
  ] as const,
  rows: [],
});

const moved: typeof ranged = ranged.offsetTime('1m');
const back: typeof ranged = ranged.offsetTime('-30s');
const ms: typeof ranged = ranged.offsetTime(-500);
void moved;
void back;
void ms;

// @ts-expect-error — not a duration unit
ranged.offsetTime('1min');
