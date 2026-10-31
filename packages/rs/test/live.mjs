// Runs pond-ts's live parity fixture through @pond-ts/rs's public JS API.
//
// The fixture (packages/core/test/fixtures/live-parity.json) is what
// pond-ts's live layer emits for scripted sessions. Here the generator that
// wrote it (packages/core/scripts/parity/live.mjs, `buildLiveFixture`) runs
// again with this package in place of pond-ts: the same calls (`new
// LiveSeries`, `on(type, fn)`, `push`, `filter(fn)`, `new LiveAggregation`,
// `toMap()`, …) and the same encoding. Every case must then equal the
// committed fixture: each step's outputs and deferred outputs in order,
// each node's class, schema, rows, values, counters and partitions, numbers
// bit for bit (`-0` and NaN are tagged). An error matches pond-ts's when
// both throw (the messages differ), but a JS TypeError from this package
// never does.
//
// The two nodes and one push pond-rs refuses on purpose are the Rust
// harness's (crates/pond-rs/tests/live_parity.rs), with the same reasons.
//
// The second half pins what the fixture cannot see: functions that throw,
// the fast push paths against the JSON one, re-entrant calls, `free()`.
//
//   node test/live.mjs           (after ./build.sh)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rs from '../index.js';
import { buildLiveFixture } from '../../core/scripts/parity/live.mjs';

const FIXTURE = fileURLToPath(
  new URL('../../core/test/fixtures/live-parity.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// Nodes pond-ts builds that pond-rs refuses on purpose (see the Rust test).
const REFUSED = new Set(['aggregate-bad-mapping/b', 'diff-rate-pct/bad']);
// A push pond-ts stores in the root and then throws on; pond-rs refuses it
// whole, so the root's rows and counts are compared without it.
const PUSH_REFUSED_WHOLE = new Set(['partition-groups/6']);

const failures = [];
const fail = (what) => failures.push(what);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The first place two JSON values differ, for the failure message. */
function diff(e, a, path = '') {
  if (same(e, a)) return null;
  if (Array.isArray(e) && Array.isArray(a)) {
    if (e.length !== a.length)
      return `${path}: ${e.length} entries, got ${a.length}`;
    for (let i = 0; i < e.length; i++) {
      const d = diff(e[i], a[i], `${path}[${i}]`);
      if (d) return d;
    }
  }
  if (e && a && typeof e === 'object' && typeof a === 'object') {
    const ek = Object.keys(e);
    if (!same(ek, Object.keys(a)))
      return `${path}: keys ${JSON.stringify(ek)}, got ${JSON.stringify(Object.keys(a))}`;
    for (const k of ek) {
      const d = diff(e[k], a[k], `${path}.${k}`);
      if (d) return d;
    }
  }
  return `${path}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`;
}

// The errors the bridge threw, by case and step (the generator records only
// name and message).
const run = await buildLiveFixture(rs);

let matched = 0;
let outputs = 0;
let rows = 0;
let errorsAgree = 0;
let refusedNodes = 0;
let refusedPushes = 0;
const countRows = (state) =>
  (state.rows?.length ?? 0) +
  (state.closed?.length ?? 0) +
  (state.snapshot?.length ?? 0) +
  (state.partitions ?? []).reduce((n, [, r]) => n + r.length, 0);

function compareCase(want, got) {
  if (want.name !== got.name) return `case order: ${got.name}`;
  if (Boolean(want.error) !== Boolean(got.error))
    return want.error
      ? `pond-ts refused the root (${want.error.message}), the bridge built it`
      : `root: ${got.error.name}: ${got.error.message}`;
  if (want.error) {
    errorsAgree++;
    return null;
  }
  if (want.steps.length !== got.steps.length) return 'step count';
  const refused = new Set();
  const refusedRows = [];
  for (let s = 0; s < want.steps.length; s++) {
    const w = want.steps[s];
    const g = got.steps[s];
    const id = w.node?.id;
    if (id !== undefined && REFUSED.has(`${want.name}/${id}`)) {
      if (!g.error) return `step ${s}: pond-rs should refuse node ${id}`;
      refused.add(id);
      refusedNodes++;
      continue;
    }
    if (Boolean(w.error) !== Boolean(g.error))
      return w.error
        ? `step ${s}: pond-ts failed (${w.error.message}), the bridge did not`
        : `step ${s}: the bridge failed: ${g.error.name}: ${g.error.message}`;
    if (g.error) {
      if (g.error.name === 'TypeError')
        return `step ${s}: a TypeError from the bridge (${g.error.message}) is not pond-rs refusing it`;
      errorsAgree++;
      if (PUSH_REFUSED_WHOLE.has(`${want.name}/${s}`)) {
        refusedRows.push(...(w.push ?? w.pushMany));
        refusedPushes++;
      }
    }
    const keep = (list) => (list ?? []).filter((o) => !refused.has(o.node));
    for (const part of ['outputs', 'deferred']) {
      const d = diff(keep(w[part]), keep(g[part]), part);
      if (d) return `step ${s}: ${d}`;
      outputs += keep(w[part]).length;
    }
  }
  for (const [id, state] of Object.entries(want.final)) {
    if (refused.has(id)) continue;
    let expected = state;
    if (id === 'root' && refusedRows.length > 0) {
      // Rows pond-ts stored before it threw, which pond-rs refused whole.
      const out = (r) => !refusedRows.some((x) => same(x, r));
      const n = refusedRows.length;
      expected = {
        ...state,
        rows: state.rows.filter(out),
        stats: {
          ...state.stats,
          ingested: state.stats.ingested - n,
          length: state.stats.length - n,
        },
      };
    }
    const d = diff(expected, got.final[id], `final ${id}`);
    if (d) return d;
    rows += countRows(expected);
  }
  return null;
}

if (run.cases.length !== fixture.cases.length)
  fail(`${run.cases.length} cases run, fixture has ${fixture.cases.length}`);
for (let i = 0; i < fixture.cases.length; i++) {
  const why = compareCase(fixture.cases[i], run.cases[i]);
  if (why) fail(`${fixture.cases[i].name}: ${why}`);
  else matched++;
}
if (refusedNodes !== REFUSED.size)
  fail(`${refusedNodes} nodes refused, want ${REFUSED.size}`);
if (refusedPushes !== PUSH_REFUSED_WHOLE.size)
  fail(
    `${refusedPushes} pushes refused whole, want ${PUSH_REFUSED_WHOLE.size}`,
  );

// ---- what the fixture cannot see ---------------------------------------------

const { LiveSeries, col, livesAlive } = rs;
const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'mem', kind: 'number', required: false },
];
const check = (what, ok) => {
  if (!ok) fail(`extra: ${what}`);
};
const throws = (f, test = () => true) => {
  try {
    f();
  } catch (e) {
    return test(e);
  }
  return false;
};
let extra = 0;
const step = (what, f) => {
  extra++;
  try {
    f();
  } catch (e) {
    fail(`extra: ${what}: threw ${e?.name}: ${e?.message}`);
  }
};
const before = livesAlive();

step(
  'a filter that throws: outputs delivered, first exception rethrown',
  () => {
    const live = new LiveSeries({ name: 'f', schema: SCHEMA });
    const boom = new Error('boom');
    let calls = 0;
    const f = live.filter((e) => {
      calls++;
      if (e.get('cpu') === 2) throw boom;
      if (e.get('cpu') === 3) throw new Error('second');
      return true;
    });
    const seen = [];
    f.on('event', (e) => seen.push(e.get('cpu')));
    const mapped = live.map((e) => e.set('cpu', e.get('cpu') * 10));
    const got = [];
    mapped.on('event', (e) => got.push(e.get('cpu')));
    let caught;
    try {
      live.pushMany([
        [0, 1, 1],
        [1000, 2, 1],
        [2000, 3, 1],
        [3000, 4, 1],
      ]);
    } catch (e) {
      caught = e;
    }
    check('the first exception itself', caught === boom);
    check('every event reached the filter', calls === 4);
    check('the filter left out what threw', same(seen, [1, 4]));
    check('other nodes kept running', same(got, [10, 20, 30, 40]));
    check('the push happened', live.length === 4);
    live.push([4000, 5, 1]);
    check('the next push is clean', same(seen, [1, 4, 5]));
    live.free();
  },
);

step('a map that throws gives gaps; a fold keeps its value', () => {
  const live = new LiveSeries({ name: 'm', schema: SCHEMA });
  const m = live.map((e) => {
    if (e.get('cpu') === 2) throw new Error('no');
    return e.set('cpu', -e.get('cpu'));
  });
  const c = live.cumulative({
    cpu: (acc, v) => {
      if (v === 2) throw new Error('no');
      return acc + v;
    },
  });
  check(
    'throws',
    throws(() =>
      live.pushMany([
        [0, 1, 7],
        [1000, 2, 8],
        [2000, 3, 9],
      ]),
    ),
  );
  const rowsOf = (n) =>
    [...Array(n.length).keys()].map((i) => n.at(i).toJsonRow(n.schema));
  check(
    'map gaps on the event that threw',
    same(rowsOf(m), [
      [0, -1, 7],
      [1000, null, null],
      [2000, -3, 9],
    ]),
  );
  check(
    'fold kept its value',
    same(
      rowsOf(c).map((r) => r[1]),
      [1, 1, 4],
    ),
  );
  const moved = { get: () => 1, begin: () => 9, end: () => 9, key: () => ({}) };
  check(
    'changing the key is an error',
    throws(
      () => live.map(() => moved),
      (e) => /changed the event's key/.test(e.message),
    ),
  );
  live.free();
});

step('a node built over history whose function throws is removed', () => {
  const live = new LiveSeries({ name: 'h', schema: SCHEMA });
  live.push([0, 1, 1], [1000, 2, 2]);
  const boom = new Error('history');
  let caught;
  try {
    live.filter(() => {
      throw boom;
    });
  } catch (e) {
    caught = e;
  }
  check('rethrown as itself', caught === boom);
  live.push([2000, 3, 3]);
  check('the series carries on', live.length === 3);
  live.free();
});

step('a function using its own series gets an error, not a crash', () => {
  const live = new LiveSeries({ name: 'r', schema: SCHEMA });
  live.filter(() => live.length > 0);
  check(
    'busy',
    throws(
      () => live.push([0, 1, 1]),
      (e) => /in the middle of a call/.test(e.message),
    ),
  );
  check(
    'again',
    throws(() => live.push([1000, 1, 1])),
  );
  check('both pushes happened', live.length === 2);
  live.free();
});

step('a push from a listener runs after the current push', () => {
  const live = new LiveSeries({ name: 'q', schema: SCHEMA });
  const order = [];
  live.on('event', (e) => {
    order.push(e.begin());
    if (e.begin() === 0) live.push([5000, 9, 9]);
  });
  live.pushMany([
    [0, 1, 1],
    [1000, 2, 2],
  ]);
  check('queued', same(order, [0, 1000, 5000]));
  live.free();
});

step('fast and JSON push paths agree; pond-ts cell rules hold', () => {
  const live = new LiveSeries({ name: 'p', schema: SCHEMA });
  const other = new LiveSeries({
    name: 'p',
    schema: [...SCHEMA, { name: 'host', kind: 'string', required: false }],
  });
  const a = [];
  live.on('event', (e) => a.push(e.toJsonRow(live.schema)));
  const b = [];
  other.on('event', (e) => b.push(e.toJsonRow(other.schema).slice(0, 3)));
  const data = [
    [0, -0, undefined],
    [1000, 1.5, 2],
    [new Date(2000), 1e308, -1e-300],
  ];
  live.push(data[0]);
  live.pushMany(data.slice(1));
  other.push([...data[0], 'x']);
  other.pushMany(data.slice(1).map((r) => [...r, 'y']));
  check('same rows', same(a, b) && a.length === 3);
  check('-0 kept', Object.is(live.at(0).get('cpu'), -0));
  check(
    'a NaN cell is refused',
    throws(() => live.push([3000, NaN, 1])),
  );
  check(
    'an infinite cell is refused',
    throws(() => live.push([3000, Infinity, 1])),
  );
  check(
    'a null cell is refused',
    throws(() => live.push([3000, null, 1])),
  );
  check(
    'a fractional time is refused',
    throws(() => live.push([3000.5, 1, 1])),
  );
  check(
    'a bad row in a batch refuses the batch',
    throws(() =>
      live.pushMany([
        [4000, 1, 1],
        [5000, 'x', 1],
      ]),
    ) && live.length === 3,
  );
  const wide = new LiveSeries({
    name: 'w',
    schema: [
      { name: 'time', kind: 'time' },
      ...'abcde'.split('').map((name) => ({ name, kind: 'number' })),
    ],
  });
  wide.push([0, 1, 2, 3, 4, 5]);
  check(
    'five columns',
    same(wide.at(0).toJsonRow(wide.schema), [0, 1, 2, 3, 4, 5]),
  );
  check(
    'a gap in a required column is refused',
    throws(() => wide.push([1000, 1, 2, 3, 4, undefined])),
  );
  wide.free();
  live.free();
  other.free();
});

step('fast push paths equal the JSON path over random rows', () => {
  // The same rows into a number-only series (fast paths) and into one with
  // an extra text column (JSON path), with rolling and aggregate nodes on
  // both: every output must be the same bits.
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = () => {
    const r = rand();
    if (r < 0.1) return undefined;
    if (r < 0.15) return -0;
    if (r < 0.2) return (rand() - 0.5) * 1e-300;
    if (r < 0.25) return (rand() - 0.5) * 1e300;
    return Math.round((rand() - 0.5) * 2000) / 8;
  };
  const fast = new LiveSeries({ name: 'r', schema: SCHEMA });
  const slow = new LiveSeries({
    name: 'r',
    schema: [...SCHEMA, { name: 'tag', kind: 'string', required: false }],
  });
  const record = (live, out) => {
    const nodes = [
      live,
      live.rolling('5s', { cpu: 'avg', mem: 'sum' }),
      live.aggregate(rs.Sequence.every('3s'), {
        cpu: 'max',
        n: { from: 'mem', using: 'count' },
      }),
    ];
    nodes.forEach((n, i) => {
      for (const kind of n === live ? ['event', 'batch'] : ['event']) {
        n.on(kind, (p) => {
          const evs = Array.isArray(p) ? p : [p];
          for (const e of evs)
            // The root's rows without the text column.
            out.push(
              [
                i,
                kind,
                ...e.toJsonRow(n.schema).slice(0, i === 0 ? 3 : undefined),
              ].map(encodeNum),
            );
        });
      }
    });
  };
  const encodeNum = (v) => (Object.is(v, -0) ? '-0' : v);
  const a = [];
  const b = [];
  record(fast, a);
  record(slow, b);
  let t = 0;
  for (let i = 0; i < 400; i++) {
    const n = rand() < 0.5 ? 1 : 1 + Math.floor(rand() * 20);
    const rows = [];
    for (let j = 0; j < n; j++)
      rows.push([(t += Math.floor(rand() * 900)), pick(), pick()]);
    if (n === 1 && rand() < 0.5) {
      fast.push(rows[0]);
      slow.push([...rows[0], 'x']);
    } else {
      fast.pushMany(rows);
      slow.pushMany(rows.map((r) => [...r, 'x']));
    }
  }
  check(
    `random rows: ${a.length} outputs equal`,
    a.length > 1000 && same(a, b),
  );
  fast.free();
  slow.free();
});

step('expressions, unsubscribe, dispose, toTimeSeries, free', () => {
  const live = new LiveSeries({ name: 'e', schema: SCHEMA });
  const f = live.filter(col('cpu').gt(1));
  const got = [];
  const off = f.on('event', (e) => got.push(e.get('cpu')));
  live.push([0, 1, 1], [1000, 2, 2]);
  off();
  live.push([2000, 3, 3]);
  check('expression filter and unsubscribe', same(got, [2]));
  const ts = f.toTimeSeries();
  check(
    'toTimeSeries',
    same(ts.toJSON().rows, [
      [1000, 2, 2],
      [2000, 3, 3],
    ]),
  );
  ts.free();
  f.dispose();
  live.push([3000, 4, 4]);
  check(
    'a disposed view cannot be read',
    throws(() => f.length),
  );
  check(
    'the root cannot be disposed',
    throws(() => live.dispose()),
  );
  live.free();
  live.free();
  check(
    'a freed series refuses calls',
    throws(() => live.push([4000, 1, 1])),
  );
});

const leaked = livesAlive() - before;
check(`${leaked} live series left after free()`, leaked === 0);

console.log(
  `live parity through @pond-ts/rs: ${matched}/${fixture.cases.length} cases ` +
    `(${outputs} outputs and ${rows} final rows equal, ${errorsAgree} errors agree; ` +
    `${refusedNodes} nodes and ${refusedPushes} push refused on purpose, as the Rust harness); ` +
    `${extra} extra checks`,
);
for (const f of failures.slice(0, 40)) console.log('  ' + f);
if (failures.length > 40) console.log(`  … and ${failures.length - 40} more`);
if (failures.length) process.exit(1);
