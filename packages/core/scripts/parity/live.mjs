/**
 * Live parity fixture: what pond-ts's live layer emits, push by push, for a
 * fixed set of scripted sessions, recorded as language-neutral JSON so
 * pond-rs's live layer (R3, `docs/plans/PND_RUST_PLAN.md` [PND-RUST-R3]) can
 * check itself against it.
 *
 * A case builds one root `LiveSeries` from `schema` + `options`, then runs
 * `steps` in order. A step is one of:
 *
 *   { push: rows }        live.push(...rows)
 *   { pushMany: rows }    live.pushMany(rows)
 *   { pushJson: rows }    live.pushJson(rows)
 *   { clear: true }       live.clear()
 *   { node: { id, op, from, args, watch? } }
 *                         nodes[id] = nodes[from][op](...args); `from`
 *                         is "root" or an earlier node id; `watch: false`
 *                         attaches no listeners (see below)
 *   { dispose: id }       nodes[id].dispose()
 *
 * Every node (and the root) gets one listener per output kind its class
 * has, unless built with `watch: false`: pond-ts disposes an intermediate
 * view along with the last view built on it only if nothing else listens
 * to it, so case `view-dispose-chain` needs a node with no listeners (LiveSeries: event, batch, evict; LiveView: event, evict;
 * LiveAggregation: event, bucket, update; LiveRollingAggregation: event,
 * update; the rest: event). Each step records, in dispatch order, the
 * outputs it caused as `{ node, kind, payload }`, and `error`
 * (`{ name, message }`) when the call throws (outputs dispatched before the
 * throw are still listed). After each step the generator waits for queued
 * microtasks; anything emitted then is the step's `deferred` list (left out
 * when empty). Since [PND-REDUCETICK], a push's outputs all arrive inside
 * the push; a `reduce` still emits from a microtask for events that reach
 * it outside a push, which in these cases means only its replay when built
 * over existing history, so `deferred` appears only on such node steps.
 *
 * Payloads: an event is `[key, ...values]` in the emitting node's schema
 * order (key as `Event.toJsonRow`: ms, `[begin, end]` or `[label, begin,
 * end]`); `batch` / `evict` carry a list of events; a rolling `update`
 * carries the value record (`{ column: cell }`); an aggregation `update`
 * carries `null`. Cells are JSON, with `null` for a gap and `-0`, `NaN`,
 * `±Infinity` tagged `{ "f64": "-0" | "NaN" | "inf" | "-inf" }` (rows in
 * steps use the same tags; `push` / `pushMany` get `undefined` for `null`,
 * `pushJson` gets the rows as written).
 *
 * Argument encodings: `{ "sequence": { "every": d } }` is
 * `Sequence.every(d)`, `{ "sequence": { "calendar": u, "timeZone": z } }` is
 * `Sequence.calendar(u, { timeZone })`; an object with a `trigger` key has
 * it decoded as `"event"` → `Trigger.event()`, `{ every: d }`,
 * `{ count: n }`, `{ clock: <sequence> }`; `{ "fn": spec }` is a filter
 * closure (`{ column, gt }`, `{ column, eq }`, `{ missing: column }`, as in
 * the core fixture); `{ "map": { column, mul, add } }` is a map closure
 * that sets `column` to `v * mul + add` when it is present; `{ "chain":
 * [[op, ...args], ...] }` is a partition `apply` factory running those
 * calls on each partition.
 *
 * `final` holds each node's state after the last step: its pond-ts `class`
 * (constructor name, which fixes the output kinds above) and output `schema`;
 * `rows` (every event it holds, via `at(i)`) for series, views, rolling,
 * reduce and partitioned rolling; `stats` for a `LiveSeries`; `closed` and
 * `snapshot` rows plus `hasOpenBucket` for an aggregation; `value` for
 * rolling and reduce; `partitions` (`[key, rows]` pairs from `toMap()`) for
 * partitioned series and views. A partition key is the `toMap()` key: the
 * partition value as text, and `" undefined"` (pond-ts's own marker, with
 * the leading space) for rows where the partition column is missing. A
 * node disposed by a `dispose` step has `{ class, disposed: true }`; one
 * pond-ts disposed with it keeps its frozen state.
 * A case whose root cannot be built has `error` and no steps.
 *
 * Run through `buildLiveFixture(pond)` (async, for the microtask waits) by
 * `generate.mjs` (writes the file) and `test/live-parity-fixture.test.ts`
 * (fails if the committed file is stale).
 */
import { closure, encodeCell } from './cases.mjs';

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string', required: false },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'mem', kind: 'number', required: false },
];

// Sorted by time. Ties (1000, 15000), a gap in every column, a row with no
// host, -0, values one millisecond either side of the 5s bucket edge, and a
// silence (15s → 21s) so time windows empty out. Three hosts so partitions
// see interleaved, uneven streams.
const ROWS = [
  [0, 'a', 1, 10],
  [500, 'b', 2, null],
  [1000, 'a', null, 12],
  [1000, 'b', 4, 13],
  [2200, 'c', 3.5, 11],
  [3000, 'a', { f64: '-0' }, null],
  [4000, 'b', 6, 16],
  [4999, 'a', null, null],
  [5000, 'c', -2, 15],
  [5001, 'a', 7.25, 14],
  [7500, null, 8, -3],
  [9000, 'b', 0, 20],
  [10000, 'a', 1.5, 21],
  [12000, 'c', 2.25, null],
  [15000, 'a', 3, 22],
  [15000, 'b', null, 23],
  [21000, 'c', 9, 24],
  [22000, 'a', -1, 25],
  [24500, 'b', 4.5, null],
  [25000, 'a', 5, 26],
  [30000, 'c', 6, 27],
  [31000, 'a', 0.125, 28],
  [35000, 'b', 2, 29],
  [40000, 'a', 1, 30],
];

// Interval-keyed rows, the shape `aggregate` emits; a live series can be
// keyed this way too.
const INTERVAL_SCHEMA = [
  { name: 'interval', kind: 'interval' },
  { name: 'v', kind: 'number', required: false },
];
const INTERVAL_ROWS = [
  [['b0', 0, 5000], 1],
  [['b1', 5000, 10000], null],
  [['b2', 10000, 15000], 4],
  [['b2', 10000, 20000], 2],
  [['b4', 20000, 25000], -3],
];

const RANGE_SCHEMA = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'v', kind: 'number', required: false },
];
const RANGE_ROWS = [
  [[0, 1000], 1],
  [[0, 3000], 2],
  [[2000, 2000], null],
  [[5000, 9000], 4],
  [[6000, 8000], -1],
];

// ── Case builders ────────────────────────────────────────────────

const each = (rows) => rows.map((row) => ({ push: [row] }));
const node = (id, op, from, ...args) => ({ node: { id, op, from, args } });
const every = (d) => ({ sequence: { every: d } });
const filterGt = (column, gt) => ({ fn: { column, gt } });
const filterEq = (column, eq) => ({ fn: { column, eq } });
const quiet = (id, op, from, ...args) => ({
  node: { id, op, from, args, watch: false },
});

// A late row (2.6s) once the stream has reached 5.001s, then a row 0.5s
// late, then one exactly at the newest time.
const LATE_STEPS = [
  ...each(ROWS.slice(0, 10)),
  { push: [[2600, 'a', 99, 1]] },
  { push: [[4600, 'b', 98, 2]] },
  { push: [[5001, 'c', 97, 3]] },
  ...each(ROWS.slice(10, 14)),
];

const CASES = [
  // ── LiveSeries ──
  { name: 'series-push-each', schema: SCHEMA, steps: each(ROWS) },
  {
    name: 'series-push-several',
    schema: SCHEMA,
    steps: [
      { push: ROWS.slice(0, 4) },
      { push: ROWS.slice(4, 12) },
      { push: [] },
      { push: ROWS.slice(12) },
    ],
  },
  {
    name: 'series-push-many',
    schema: SCHEMA,
    steps: [
      { pushMany: ROWS.slice(0, 9) },
      { pushMany: [] },
      { pushMany: ROWS.slice(9) },
    ],
  },
  {
    name: 'series-push-json',
    schema: SCHEMA,
    steps: [
      { pushJson: ROWS.slice(0, 5).map((r) => [r[0], r[1], r[2], r[3]]) },
      { pushJson: [[6000, null, null, 5]] },
    ],
  },
  { name: 'series-strict-late', schema: SCHEMA, steps: LATE_STEPS },
  {
    name: 'series-strict-late-in-batch',
    schema: SCHEMA,
    steps: [
      ...each(ROWS.slice(0, 3)),
      { push: [ROWS[3], [200, 'a', 1, 1], ROWS[4]] },
      { pushMany: [ROWS[5], [300, 'a', 1, 1], ROWS[6]] },
      ...each(ROWS.slice(5, 8)),
    ],
  },
  {
    name: 'series-drop-late',
    schema: SCHEMA,
    options: { ordering: 'drop' },
    steps: [
      ...LATE_STEPS,
      { pushMany: [ROWS[14], [100, 'a', 1, 1], ROWS[15]] },
      { push: [[16000, 'a', 'high', 1]] },
      {
        pushMany: [
          [16000, 'a', 1, 1],
          [17000, 5, 1, 1],
        ],
      },
    ],
  },
  {
    name: 'series-reorder',
    schema: SCHEMA,
    options: { ordering: 'reorder' },
    steps: [
      ...LATE_STEPS,
      { push: [[16000, 'a', 'high', 1]] },
      {
        pushMany: [
          [16000, 'a', 1, 1],
          [17000, 5, 1, 1],
        ],
      },
    ],
  },
  {
    name: 'series-reorder-grace',
    schema: SCHEMA,
    options: { ordering: 'reorder', graceWindow: '1s' },
    steps: LATE_STEPS,
  },
  {
    name: 'series-grace-without-reorder',
    schema: SCHEMA,
    options: { graceWindow: '1s' },
    steps: [],
  },
  {
    name: 'series-grace-over-max-age',
    schema: SCHEMA,
    options: {
      ordering: 'reorder',
      graceWindow: '10s',
      retention: { maxAge: '5s' },
    },
    steps: [],
  },
  {
    name: 'series-max-events',
    schema: SCHEMA,
    options: { retention: { maxEvents: 5 } },
    steps: [
      ...each(ROWS.slice(0, 8)),
      { push: ROWS.slice(8, 16) },
      { pushMany: ROWS.slice(16) },
    ],
  },
  {
    name: 'series-max-age',
    schema: SCHEMA,
    options: { retention: { maxAge: '5s' } },
    steps: each(ROWS),
  },
  {
    name: 'series-reorder-max-age',
    schema: SCHEMA,
    options: {
      ordering: 'reorder',
      graceWindow: '3s',
      retention: { maxAge: '4s', maxEvents: 6 },
    },
    steps: LATE_STEPS,
  },
  {
    name: 'series-clear',
    schema: SCHEMA,
    steps: [
      ...each(ROWS.slice(0, 6)),
      { clear: true },
      { push: [[100, 'a', 1, 2]] },
      { clear: true },
      { clear: true },
      ...each(ROWS.slice(6, 9)),
    ],
  },
  {
    name: 'series-bad-rows',
    schema: SCHEMA,
    steps: [
      ...each(ROWS.slice(0, 3)),
      { push: [[2000, 'a', 'high', 1]] },
      { push: [[2000, 5, 1, 1]] },
      { push: [[2000, 'a', { f64: 'NaN' }, 1]] },
      { push: [[2000, 'a', { f64: 'inf' }, 1]] },
      { push: [[2000, 'a', 1]] },
      {
        pushMany: [
          [3000, 'a', 1, 1],
          [4000, 'a', 'x', 1],
        ],
      },
      { push: [[{ f64: 'NaN' }, 'a', 1, 1]] },
      ...each(ROWS.slice(3, 5)),
    ],
  },
  {
    name: 'series-required-column',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
    steps: [
      { push: [[0, 1]] },
      { push: [[1000, null]] },
      { push: [[2000, 2]] },
    ],
  },
  {
    name: 'series-interval-keys',
    schema: INTERVAL_SCHEMA,
    steps: [
      ...each(INTERVAL_ROWS),
      node('f', 'filter', 'root', filterGt('v', 0)),
      { push: [[['b5', 25000, 30000], 6]] },
    ],
  },
  {
    name: 'series-range-keys',
    schema: RANGE_SCHEMA,
    options: { retention: { maxEvents: 3 } },
    steps: each(RANGE_ROWS),
  },

  // ── Views ──
  {
    name: 'filter-chain',
    schema: SCHEMA,
    steps: [
      node('f', 'filter', 'root', filterGt('cpu', 1)),
      node('g', 'filter', 'f', filterEq('host', 'a')),
      ...each(ROWS),
    ],
  },
  {
    name: 'filter-built-late',
    schema: SCHEMA,
    options: { retention: { maxEvents: 6 } },
    steps: [
      ...each(ROWS.slice(0, 10)),
      node('f', 'filter', 'root', { fn: { missing: 'mem' } }),
      ...each(ROWS.slice(10)),
    ],
  },
  {
    name: 'map-select-sample',
    schema: SCHEMA,
    steps: [
      node('m', 'map', 'root', { map: { column: 'cpu', mul: 2, add: -1 } }),
      node('s', 'select', 'm', 'cpu'),
      node('t', 'sample', 'root', { stride: 3 }),
      node('bad', 'sample', 'root', { stride: 0 }),
      ...each(ROWS.slice(0, 12)),
      node('t2', 'sample', 'root', { stride: 2 }),
      ...each(ROWS.slice(12)),
    ],
  },
  {
    name: 'window-count-and-time',
    schema: SCHEMA,
    steps: [
      node('w3', 'window', 'root', 3),
      node('w5s', 'window', 'root', '5s'),
      node('wf', 'window', 'w3', '2s'),
      ...each(ROWS),
    ],
  },
  {
    name: 'diff-rate-pct',
    schema: SCHEMA,
    steps: [
      node('d', 'diff', 'root', 'cpu'),
      node('dd', 'diff', 'root', ['cpu', 'mem'], { drop: true }),
      node('r', 'rate', 'root', ['cpu', 'mem']),
      node('p', 'pctChange', 'root', 'mem', { drop: true }),
      node('bad', 'diff', 'root', 'host'),
      ...each(ROWS),
    ],
  },
  {
    name: 'fill-cumulative',
    schema: SCHEMA,
    steps: [
      node('h', 'fill', 'root', 'hold'),
      node('z', 'fill', 'root', 'zero'),
      node('m', 'fill', 'root', { cpu: 'hold', mem: 7 }, { limit: 1 }),
      node('c', 'cumulative', 'root', { cpu: 'sum', mem: 'max' }),
      node('c2', 'cumulative', 'root', { cpu: 'count', mem: 'min' }),
      ...each(ROWS),
    ],
  },
  {
    name: 'views-after-clear',
    schema: SCHEMA,
    steps: [
      node('d', 'diff', 'root', 'cpu'),
      node('c', 'cumulative', 'root', { cpu: 'sum' }),
      node('h', 'fill', 'root', 'hold'),
      ...each(ROWS.slice(0, 6)),
      { clear: true },
      ...each(ROWS.slice(6, 12)),
    ],
  },
  {
    name: 'views-retention',
    schema: SCHEMA,
    options: { retention: { maxEvents: 4 } },
    steps: [
      node('f', 'filter', 'root', filterGt('cpu', 0)),
      node('w', 'window', 'f', 2),
      node('d', 'diff', 'root', 'mem'),
      ...each(ROWS),
    ],
  },
  {
    name: 'view-dispose',
    schema: SCHEMA,
    steps: [
      node('f', 'filter', 'root', filterGt('cpu', 0)),
      node('g', 'filter', 'f', filterGt('mem', 12)),
      ...each(ROWS.slice(0, 8)),
      { dispose: 'f' },
      ...each(ROWS.slice(8, 12)),
    ],
  },
  {
    // Disposing the last view on an unwatched intermediate disposes the
    // intermediate too ('f' stops at 4 rows); a watched one ('k') stays.
    name: 'view-dispose-chain',
    schema: SCHEMA,
    steps: [
      quiet('f', 'filter', 'root', filterGt('cpu', 0)),
      node('g', 'filter', 'f', filterGt('mem', 12)),
      node('k', 'filter', 'root', filterGt('mem', 0)),
      node('h', 'diff', 'k', 'mem'),
      ...each(ROWS.slice(0, 6)),
      { dispose: 'g' },
      { dispose: 'h' },
      ...each(ROWS.slice(6, 12)),
    ],
  },

  // ── Aggregation ──
  {
    name: 'aggregate-5s',
    schema: SCHEMA,
    steps: [
      node('a', 'aggregate', 'root', every('5s'), {
        cpu: 'sum',
        mem: 'avg',
        n: { from: 'cpu', using: 'count' },
      }),
      ...each(ROWS),
    ],
  },
  {
    name: 'aggregate-late-and-chained',
    schema: SCHEMA,
    options: { ordering: 'reorder' },
    steps: [
      ...each(ROWS.slice(0, 9)),
      node('a', 'aggregate', 'root', every('2s'), {
        cpu: 'max',
        mem: 'last',
      }),
      node('f', 'filter', 'a', filterGt('cpu', 2)),
      node('r', 'rolling', 'a', 2, { cpu: 'avg' }),
      { push: [[6000, 'a', 50, 50]] },
      { push: [[1500, 'b', 60, 60]] },
      ...each(ROWS.slice(9)),
    ],
  },
  {
    name: 'aggregate-retention',
    schema: SCHEMA,
    options: { retention: { maxEvents: 3 } },
    steps: [
      node('a', 'aggregate', 'root', every('10s'), { cpu: 'avg' }),
      ...each(ROWS),
      { clear: true },
      ...each(ROWS.slice(0, 3)),
    ],
  },
  {
    name: 'aggregate-calendar',
    schema: SCHEMA,
    steps: [
      node(
        'a',
        'aggregate',
        'root',
        { sequence: { calendar: 'day', timeZone: 'UTC' } },
        { cpu: 'sum' },
      ),
      ...each(ROWS.slice(0, 4)),
    ],
  },
  {
    name: 'aggregate-bad-mapping',
    schema: SCHEMA,
    steps: [
      node('a', 'aggregate', 'root', every('5s'), { nope: 'sum' }),
      node('b', 'aggregate', 'root', every('5s'), { host: 'avg' }),
      ...each(ROWS.slice(0, 2)),
    ],
  },

  // ── Rolling ──
  {
    name: 'rolling-time-window',
    schema: SCHEMA,
    steps: [
      node('r', 'rolling', 'root', '5s', {
        cpu: 'avg',
        mem: 'max',
        n: { from: 'cpu', using: 'count' },
      }),
      node('m', 'rolling', 'root', '3s', { cpu: 'sum' }, { minSamples: 2 }),
      ...each(ROWS),
    ],
  },
  {
    name: 'rolling-count-window',
    schema: SCHEMA,
    steps: [
      node('r', 'rolling', 'root', 3, { cpu: 'sum', mem: 'min' }),
      node('s', 'rolling', 'root', 4, { cpu: 'stdev' }),
      ...each(ROWS.slice(0, 12)),
      node('late', 'rolling', 'root', 2, { mem: 'avg' }),
      ...each(ROWS.slice(12)),
    ],
  },
  {
    name: 'rolling-triggers',
    schema: SCHEMA,
    steps: [
      node('e', 'rolling', 'root', '5s', { cpu: 'avg' }, { trigger: 'event' }),
      node(
        'c',
        'rolling',
        'root',
        '5s',
        { cpu: 'avg' },
        { trigger: { every: '5s' } },
      ),
      node(
        'k',
        'rolling',
        'root',
        '5s',
        { cpu: 'avg' },
        { trigger: { count: 3 } },
      ),
      node(
        'q',
        'rolling',
        'root',
        '10s',
        { mem: 'sum' },
        { trigger: { clock: every('4s') } },
      ),
      node(
        'bad',
        'rolling',
        'root',
        '5s',
        { cpu: 'avg' },
        {
          trigger: {
            clock: { sequence: { calendar: 'day', timeZone: 'UTC' } },
          },
        },
      ),
      node('neg', 'rolling', 'root', '5s', { cpu: 'avg' }, { minSamples: -1 }),
      ...each(ROWS),
    ],
  },
  {
    name: 'rolling-retention-and-clear',
    schema: SCHEMA,
    options: { retention: { maxEvents: 4 } },
    steps: [
      node('r', 'rolling', 'root', '10s', { cpu: 'sum', mem: 'avg' }),
      ...each(ROWS.slice(0, 14)),
      { clear: true },
      ...each(ROWS.slice(14)),
    ],
  },
  {
    name: 'fused-rolling',
    schema: SCHEMA,
    steps: [
      node(
        'f',
        'rolling',
        'root',
        {
          '2s': { cpu: 'avg' },
          '10s': { mem: 'max', total: { from: 'cpu', using: 'sum' } },
        },
        { trigger: { every: '5s' } },
      ),
      node('fe', 'rolling', 'root', { '3s': { cpu: 'count' } }),
      ...each(ROWS),
    ],
  },

  // ── Reduce ──
  {
    name: 'reduce-whole-buffer',
    schema: SCHEMA,
    options: { retention: { maxEvents: 5 } },
    steps: [
      node('r', 'reduce', 'root', { cpu: 'sum', mem: 'avg' }),
      node('k', 'reduce', 'root', { cpu: 'max' }, { trigger: { count: 2 } }),
      node('c', 'reduce', 'root', { mem: 'min' }, { trigger: { every: '5s' } }),
      ...each(ROWS.slice(0, 10)),
      { push: ROWS.slice(10, 14) },
      { pushMany: ROWS.slice(14) },
    ],
  },
  {
    name: 'reduce-built-late',
    schema: SCHEMA,
    steps: [
      ...each(ROWS.slice(0, 6)),
      node('r', 'reduce', 'root', { cpu: 'sum' }),
      node('f', 'filter', 'root', filterGt('cpu', 0)),
      node('rf', 'reduce', 'f', { cpu: 'count' }),
      ...each(ROWS.slice(6, 10)),
      { clear: true },
      ...each(ROWS.slice(10, 12)),
    ],
  },

  // ── Partitioned ──
  {
    name: 'partition-collect',
    schema: SCHEMA,
    steps: [
      node('p', 'partitionBy', 'root', 'host'),
      node('all', 'collect', 'p'),
      node('d', 'diff', 'p', 'cpu'),
      node('dall', 'collect', 'd'),
      ...each(ROWS.slice(0, 10)),
      node('pa', 'partition', 'p', 'a'),
      ...each(ROWS.slice(10)),
    ],
  },
  {
    // [PND-PARTBATCH] A multi-row pushMany into a strict source: each
    // partition stores its slice, runs retention, fires one 'batch' and
    // settles (one reduce output) once per pushMany, while 'event' (and so
    // collect and the clock-triggered rolling) stays in source order.
    name: 'partition-pushmany',
    schema: SCHEMA,
    steps: [
      node('p', 'partitionBy', 'root', 'host', {
        retention: { maxEvents: 2 },
      }),
      node('all', 'collect', 'p'),
      { pushMany: ROWS.slice(0, 5) },
      node('pa', 'partition', 'p', 'a'),
      node('pb', 'partition', 'p', 'b'),
      node('ra', 'reduce', 'pa', { cpu: 'sum' }),
      node(
        'fused',
        'rolling',
        'p',
        { '2s': { cpu: 'max' }, '5s': { mem: 'avg' } },
        { trigger: { every: '5s' } },
      ),
      { pushMany: ROWS.slice(5, 16) },
      { pushMany: ROWS.slice(16) },
    ],
  },
  {
    name: 'partition-groups',
    schema: SCHEMA,
    steps: [
      node('p', 'partitionBy', 'root', 'host', { groups: ['a', 'b'] }),
      node('all', 'collect', 'p'),
      ...each(ROWS.slice(0, 8)),
    ],
  },
  {
    name: 'partition-rolling',
    schema: SCHEMA,
    steps: [
      node('p', 'partitionBy', 'root', 'host'),
      node('r', 'rolling', 'p', '5s', { cpu: 'avg' }),
      node('rall', 'collect', 'r'),
      node(
        'sync',
        'rolling',
        'p',
        '5s',
        { cpu: 'sum' },
        { trigger: { every: '5s' } },
      ),
      node(
        'fused',
        'rolling',
        'p',
        { '2s': { cpu: 'max' }, '5s': { mem: 'avg' } },
        { trigger: { every: '5s' } },
      ),
      node('nofuse', 'rolling', 'p', { '2s': { cpu: 'max' } }),
      ...each(ROWS),
    ],
  },
  {
    name: 'partition-apply-and-retention',
    schema: SCHEMA,
    options: { ordering: 'reorder', retention: { maxEvents: 20 } },
    steps: [
      node('p', 'partitionBy', 'root', 'host', {
        retention: { maxEvents: 2 },
      }),
      node('ap', 'apply', 'p', {
        chain: [
          ['fill', 'hold'],
          ['cumulative', { cpu: 'sum' }],
        ],
      }),
      node('f', 'fill', 'p', { mem: 0 }),
      node('fall', 'collect', 'f'),
      ...LATE_STEPS,
    ],
  },
  {
    name: 'partition-bad-options',
    schema: SCHEMA,
    steps: [
      node('p', 'partitionBy', 'root', 'host', { nope: 1 }),
      node('q', 'partitionBy', 'root', 'nope'),
      ...each(ROWS.slice(0, 2)),
    ],
  },
];

// ── Runner ───────────────────────────────────────────────────────

const KINDS = {
  LiveSeries: ['event', 'batch', 'evict'],
  LiveView: ['event', 'evict'],
  LiveAggregation: ['event', 'bucket', 'update'],
  LiveRollingAggregation: ['event', 'update'],
  LiveFusedRolling: ['event'],
  LiveReduce: ['event'],
  LivePartitionedFusedRolling: ['event'],
  LivePartitionedSyncRolling: ['event'],
  LivePartitionedSeries: [],
  LivePartitionedView: [],
};

function decodeCell(cell) {
  if (Array.isArray(cell)) return cell.map(decodeCell);
  if (cell === null) return undefined;
  if (typeof cell === 'object' && 'f64' in cell) {
    return { '-0': -0, NaN: NaN, inf: Infinity, '-inf': -Infinity }[cell.f64];
  }
  return cell;
}

const decodeRows = (rows) => rows.map((row) => row.map(decodeCell));

function decodeSequence(pond, spec) {
  const { every: step, calendar, timeZone } = spec;
  return step !== undefined
    ? pond.Sequence.every(step)
    : pond.Sequence.calendar(calendar, { timeZone });
}

function decodeTrigger(pond, spec) {
  if (spec === 'event') return pond.Trigger.event();
  if ('every' in spec) return pond.Trigger.every(spec.every);
  if ('count' in spec) return pond.Trigger.count(spec.count);
  if ('clock' in spec) {
    return pond.Trigger.clock(decodeSequence(pond, spec.clock.sequence));
  }
  throw new Error(`unknown trigger ${JSON.stringify(spec)}`);
}

function decodeArg(pond, arg) {
  if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return arg;
  if ('sequence' in arg) return decodeSequence(pond, arg.sequence);
  if ('fn' in arg) return closure(arg.fn);
  if ('map' in arg) {
    const { column, mul, add } = arg.map;
    return (e) => {
      const v = e.get(column);
      return v === undefined ? e : e.set(column, v * mul + add);
    };
  }
  if ('chain' in arg) {
    return (sub) =>
      arg.chain.reduce(
        (src, [op, ...args]) => src[op](...args.map((a) => decodeArg(pond, a))),
        sub,
      );
  }
  if ('trigger' in arg) {
    return { ...arg, trigger: decodeTrigger(pond, arg.trigger) };
  }
  return arg;
}

const errorOf = (e) => ({ name: e.name, message: e.message });

function encodeEvent(event, schema) {
  const key = event.toJsonRow(schema)[0];
  return [
    key,
    ...schema.slice(1).map((c) => encodeCell(event.get(c.name) ?? null)),
  ];
}

const encodeRecord = (value) =>
  Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, encodeCell(v ?? null)]),
  );

const encodeRows = (series) =>
  series.toJSON().rows.map((row) => row.map(encodeCell));

function rowsOf(source) {
  const rows = [];
  for (let i = 0; i < source.length; i += 1) {
    rows.push(encodeEvent(source.at(i), source.schema));
  }
  return rows;
}

function attach(obj, id, record) {
  const kind = obj.constructor.name;
  const kinds = KINDS[kind];
  if (kinds === undefined) throw new Error(`no listener table for ${kind}`);
  for (const type of kinds) {
    obj.on(type, (payload) => {
      let encoded;
      if (type === 'batch' || type === 'evict') {
        encoded = payload.map((e) => encodeEvent(e, obj.schema));
      } else if (type === 'update') {
        encoded = payload === undefined ? null : encodeRecord(payload);
      } else {
        encoded = encodeEvent(payload, obj.schema);
      }
      record({ node: id, kind: type, payload: encoded });
    });
  }
}

function finalOf(obj) {
  const kind = obj.constructor.name;
  const out = { class: kind, schema: JSON.parse(JSON.stringify(obj.schema)) };
  if (kind === 'LiveAggregation') {
    out.closed = encodeRows(obj.closed());
    out.snapshot = encodeRows(obj.snapshot());
    out.hasOpenBucket = obj.hasOpenBucket;
    return out;
  }
  if (kind === 'LivePartitionedSeries' || kind === 'LivePartitionedView') {
    out.partitions = [...obj.toMap()].map(([k, src]) => [k, rowsOf(src)]);
    return out;
  }
  out.rows = rowsOf(obj);
  if (kind === 'LiveSeries') out.stats = obj.stats();
  if (typeof obj.value === 'function') out.value = encodeRecord(obj.value());
  return out;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function runCase(pond, spec) {
  const out = { name: spec.name, schema: spec.schema };
  if (spec.options) out.options = spec.options;
  let root;
  try {
    root = new pond.LiveSeries({
      name: spec.name,
      schema: spec.schema,
      ...spec.options,
    });
  } catch (e) {
    return { ...out, error: errorOf(e), steps: [] };
  }
  let sink = [];
  const record = (o) => sink.push(o);
  const nodes = new Map([['root', root]]);
  const disposed = new Set();
  attach(root, 'root', record);
  out.steps = [];
  for (const step of spec.steps) {
    sink = [];
    const result = { ...step };
    try {
      if ('push' in step) root.push(...decodeRows(step.push));
      else if ('pushMany' in step) root.pushMany(decodeRows(step.pushMany));
      else if ('pushJson' in step) root.pushJson(step.pushJson);
      else if ('clear' in step) root.clear();
      else if ('dispose' in step) {
        nodes.get(step.dispose).dispose();
        disposed.add(step.dispose);
      } else if ('node' in step) {
        const { id, op, from, args } = step.node;
        const parent = nodes.get(from);
        if (parent === undefined) throw new Error(`no node ${from} for ${id}`);
        const made =
          op === 'partition'
            ? parent.toMap().get(args[0])
            : parent[op](...args.map((a) => decodeArg(pond, a)));
        if (made === undefined) throw new Error(`${op} gave nothing`);
        nodes.set(id, made);
        if (step.node.watch !== false) attach(made, id, record);
      } else throw new Error(`unknown step ${JSON.stringify(step)}`);
    } catch (e) {
      result.error = errorOf(e);
    }
    result.outputs = sink;
    sink = [];
    await flush();
    if (sink.length > 0) result.deferred = sink;
    out.steps.push(result);
  }
  out.final = Object.fromEntries(
    [...nodes].map(([id, obj]) => [
      id,
      disposed.has(id)
        ? { class: obj.constructor.name, disposed: true }
        : finalOf(obj),
    ]),
  );
  return out;
}

export async function buildLiveFixture(pond) {
  const cases = [];
  for (const spec of CASES) cases.push(await runCase(pond, spec));
  return {
    meta: {
      generator: 'packages/core/scripts/parity/generate.mjs',
      reference: 'pond-ts',
      encoding: 'see packages/core/scripts/parity/live.mjs header',
    },
    cases,
  };
}
