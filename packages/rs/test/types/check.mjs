// Checks index.d.ts ([PND-RSTYPES]):
//
// 1. The study block is what scripts/types.mjs writes from the catalog.
// 2. Every export, and every method the classes have at runtime, is
//    declared (a few internals are left out on purpose, listed below).
// 3. The calls the parity fixtures make compile under `tsc --strict`:
//    every core case and row lookup (packages/core/test/fixtures/
//    parity.json), every study call (packages/financial/test/fixtures/
//    study-parity.json), and every live session (packages/core/test/
//    fixtures/live-parity.json), written out as TypeScript a user would
//    write. Cases pond-ts refuses are left out (some pass wrong arguments
//    on purpose). `api.ts` beside this file adds hand-written uses,
//    including ones that must not compile (`@ts-expect-error`).
//
//   node test/types/check.mjs     (after ./build.sh and the root npm ci)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as rs from '../../index.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const json = (p) => JSON.parse(readFileSync(here(p), 'utf8'));

execFileSync(process.execPath, [here('../../scripts/types.mjs'), '--check'], {
  stdio: 'inherit',
});

// ---- TypeScript text for fixture values ------------------------------------

const F64 = { '-0': '-0', NaN: 'NaN', inf: 'Infinity', '-inf': '-Infinity' };
const str = (s) => JSON.stringify(s);
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : str(k));

function expr(n) {
  if ('col' in n) return `col(${str(n.col)})`;
  if ('lit' in n) return `lit(${ts(n.lit)})`;
  if (n.op === 'when') return `when(${n.args.map(expr).join(', ')})`;
  const [first, ...rest] = n.args;
  if (n.op === 'in') return `${expr(first)}.in(${ts(n.values)})`;
  return `${expr(first)}.${n.op}(${rest.map(expr).join(', ')})`;
}

const sequence = (s) =>
  s.every !== undefined
    ? `Sequence.every(${ts(s.every)})`
    : `Sequence.calendar(${str(s.calendar)}, ${ts({ timeZone: s.timeZone, weekStartsOn: s.weekStartsOn })})`;

/** A fixture value as TypeScript; `special` renders tagged objects first. */
function ts(v, special) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
  if (typeof v !== 'object') return str(v);
  if (special) {
    const s = special(v);
    if (s !== undefined) return s;
  }
  if (Array.isArray(v)) return `[${v.map((x) => ts(x, special)).join(', ')}]`;
  if ('f64' in v && Object.keys(v).length === 1) return F64[v.f64];
  const fields = Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${key(k)}: ${ts(x, special)}`);
  return `{ ${fields.join(', ')} }`;
}

// A fixture function, as a user would write one for `op`.
function fn(op, spec) {
  if (spec.expr) return expr(spec.expr);
  switch (op) {
    case 'filter':
    case 'find':
    case 'some':
    case 'every':
      return `(e, i) => e.get(${str(spec.column ?? 'v')}) !== undefined || i % 2 === 0`;
    case 'liveFilter':
      return `(e) => e.get(${str(spec.column ?? 'v')}) !== undefined`;
    case 'mapColumns':
      if (spec === 'upper') return '(v: string) => v.toUpperCase()';
      if (spec === 'not') return '(v: boolean) => !v';
      return `(v: number) => v * ${ts(spec.mul)} + ${ts(spec.add)}`;
    case 'scan':
      return '(acc, value, index) => [acc, value + index] as const';
    case 'collapse':
      return '(values) => Object.keys(values).length';
    case 'asInterval':
      return '(range, index) => `${range.begin()}-${index}`';
    default:
      throw new Error(`no function for ${op}: ${JSON.stringify(spec)}`);
  }
}

const coreArg = (op) => (v) => {
  if (Array.isArray(v)) return undefined;
  if ('series' in v) return 'other';
  if ('sequence' in v) return sequence(v.sequence);
  if ('expr' in v && Object.keys(v).length === 1) return expr(v.expr);
  if ('fn' in v) return fn(op, v.fn);
  return undefined;
};
const args = (op, list) => list.map((a) => ts(a, coreArg(op))).join(', ');

// ---- core fixture ----------------------------------------------------------

const core = json('../../../core/test/fixtures/parity.json');
const lines = [];
let calls = 0;
for (const c of core.cases) {
  if (c.error) continue;
  let call;
  if (c.op === 'partitionBy') {
    const [by, steps, end] = c.args;
    const chain = steps.map(([op, ...a]) => `.${op}(${args(op, a)})`).join('');
    call = `input.partitionBy(${ts(by)})${chain}.${end ?? 'collect'}()`;
  } else if (c.op === 'joinMany' || c.op === 'concat') {
    const [list, ...rest] = c.args;
    call = `TimeSeries.${c.op}([input, ${list.map(() => 'other').join(', ')}]${rest.length ? `, ${args(c.op, rest)}` : ''})`;
  } else call = `input.${c.op}(${args(c.op, c.args)})`;
  lines.push(`  ${call}; // ${c.id}`);
  calls++;
}
const TESTS = new Set(['find', 'some', 'every']);
for (const q of core.queries) {
  // A query's test is the closure spec itself (or `{ expr }`).
  const arg =
    q.op === 'timeRange'
      ? ''
      : TESTS.has(q.op) && !q.arg.expr
        ? fn(q.op, q.arg)
        : args(q.op, [q.arg]);
  lines.push(`  input.${q.op}(${arg});`);
  calls++;
}

// ---- study fixture ---------------------------------------------------------

const study = json('../../../financial/test/fixtures/study-parity.json');
const studyArg = (v) =>
  v && v.rules && v.from !== undefined ? 'calendar' : undefined;
// Options a study does not have: the fixture passes some (pond-ts and
// pond-rs ignore them at runtime), but pond-ts's types refuse them as these
// do, so they are left out of the calls written here.
const ANCHOR_KEYS = ['sessions', 'session', 'stamped', 'anchor'];
const known = new Map(
  rs
    .studies()
    .map((d) => [
      d.name,
      new Set([
        ...d.inputs.map((i) => i.role),
        ...Object.keys(d.params),
        d.naming.kind,
        ...ANCHOR_KEYS,
      ]),
    ]),
);
let studyCalls = 0;
let extraOptions = 0;
for (const c of study.cases) {
  if (c.error) continue;
  const kept = Object.entries(c.options ?? {}).filter(([k]) => {
    const ok = known.get(c.study).has(k);
    if (!ok) extraOptions++;
    return ok;
  });
  const options = ts(Object.fromEntries(kept), studyArg);
  // Both doors: the named method and `study(name, options)`.
  lines.push(`  bars.${c.study}(${options}); // ${c.id}`);
  lines.push(`  bars.study(${str(c.study)}, ${options});`);
  studyCalls += 2;
}

// ---- live fixture ----------------------------------------------------------

const KINDS = {
  LiveSeries: ['event', 'batch', 'columns', 'evict'],
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
const trigger = (t) =>
  t === 'event'
    ? 'Trigger.event()'
    : 'every' in t
      ? `Trigger.every(${ts(t.every)})`
      : 'count' in t
        ? `Trigger.count(${t.count})`
        : `Trigger.clock(${sequence(t.clock.sequence)})`;
const liveArg = (v) => {
  if (Array.isArray(v)) return undefined;
  if ('sequence' in v) return sequence(v.sequence);
  if ('fn' in v) return fn('liveFilter', v.fn);
  if ('map' in v)
    return `(e: Event) => e.set(${str(v.map.column)}, ${ts(v.map.add)})`;
  if ('chain' in v)
    return `(sub) => sub${v.chain.map(([op, ...a]) => `.${op}(${a.map((x) => ts(x, liveArg)).join(', ')})`).join('')}`;
  if ('trigger' in v) {
    const { trigger: t, ...rest } = v;
    const fields = Object.entries(rest).map(
      ([k, x]) => `${key(k)}: ${ts(x, liveArg)}`,
    );
    return `{ ${[`trigger: ${trigger(t)}`, ...fields].join(', ')} }`;
  }
  return undefined;
};
const cell = (v) => (v === null ? undefined : v);
const rows = (list) =>
  ts(
    list.map((r) => r.map(cell)),
    liveArg,
  ).replace(/\bnull\b/g, 'undefined');
const live = json('../../../core/test/fixtures/live-parity.json');
const liveLines = [];
let liveCalls = 0;
live.cases.forEach((c, k) => {
  if (c.error) return;
  const b = [`function live${k}() { // ${c.name}`];
  b.push(
    `  const root = new LiveSeries(${ts({ name: c.name, schema: c.schema, ...c.options })});`,
  );
  const v = (id) => (id === 'root' ? 'root' : `n_${id.replace(/\W/g, '_')}`);
  const declared = new Set(['root']);
  c.steps.forEach((s, i) => {
    if (s.error) return;
    if ('push' in s)
      b.push(
        `  root.push(${s.push.map((r) => rows([r]).slice(1, -1)).join(', ')});`,
      );
    else if ('pushMany' in s) b.push(`  root.pushMany(${rows(s.pushMany)});`);
    else if ('pushJson' in s) b.push(`  root.pushJson(${ts(s.pushJson)});`);
    else if ('clear' in s) b.push('  root.clear();');
    else if ('dispose' in s) b.push(`  ${v(s.dispose)}.dispose();`);
    else if ('node' in s) {
      const { id, op, from, args: a } = s.node;
      const call =
        op === 'partition'
          ? `${v(from)}.toMap().get(${str(a[0])})!`
          : op === 'aggregateWith'
            ? `new LiveAggregation(${v(from)}, ${a.map((x) => ts(x, liveArg)).join(', ')})`
            : `${v(from)}.${op}(${a.map((x) => ts(x, liveArg)).join(', ')})`;
      const name = declared.has(v(id)) ? `${v(id)}_${i}` : v(id);
      declared.add(name);
      b.push(`  const ${name} = ${call};`);
      // Listen to every kind the node's class emits: a kind the types
      // leave out (or a class they get wrong) fails here.
      const cls = c.final?.[id]?.class;
      if (cls) {
        b.push(`  const _${name}: ${cls} = ${name};`);
        for (const kind of KINDS[cls])
          b.push(`  ${name}.on(${str(kind)}, () => {});`);
      }
      // A later node with this id builds on this one.
      if (name !== v(id)) b.push(`  void ${name};`);
    }
    liveCalls++;
  });
  b.push('  root.free();', '}');
  liveLines.push(...b);
});

// ---- the runtime surface ---------------------------------------------------

// Internals on the prototypes that the declarations leave out on purpose.
const INTERNAL = new Set([
  'constructor',
  '_owner', // live nodes: the series that owns them
  '_handle',
  '_build',
]);
const surface = [];
for (const name of Object.keys(rs)) surface.push(`  rs.${name};`);
const methods = (cls, as) => {
  for (const m of Object.getOwnPropertyNames(cls.prototype))
    if (!INTERNAL.has(m)) surface.push(`  (null! as ${as}).${m};`);
  for (const m of Object.getOwnPropertyNames(cls))
    if (!['length', 'name', 'prototype'].includes(m))
      surface.push(`  rs.${cls.name}.${m};`);
};
methods(rs.TimeSeries, 'rs.TimeSeries');
methods(rs.PartitionedSeries, 'rs.PartitionedSeries');
for (const n of [
  'Time',
  'TimeRange',
  'Interval',
  'Event',
  'Expr',
  'Sequence',
  'Trigger',
  'TradingCalendar',
])
  methods(rs[n], `rs.${n}`);
// Live classes: the shared node methods come in through the prototype chain.
const LIVE = [
  'LiveSeries',
  'LiveView',
  'LiveAggregation',
  'LiveRollingAggregation',
  'LiveFusedRolling',
  'LiveReduce',
  'LivePartitionedSeries',
  'LivePartitionedView',
];
for (const n of LIVE) {
  for (
    let p = rs[n].prototype;
    p !== Object.prototype;
    p = Object.getPrototypeOf(p)
  )
    for (const m of Object.getOwnPropertyNames(p))
      if (!INTERNAL.has(m)) surface.push(`  (null! as rs.${n}).${m};`);
}
// Nothing builds on these two in pond-rs (the builders throw), so only
// their own methods are declared.
for (const n of ['LivePartitionedFusedRolling', 'LivePartitionedSyncRolling'])
  for (const m of Object.getOwnPropertyNames(rs[n].prototype))
    if (!INTERNAL.has(m)) surface.push(`  (null! as rs.${n}).${m};`);

// ---- write and compile -----------------------------------------------------

const out = here('generated');
mkdirSync(out, { recursive: true });
writeFileSync(
  `${out}/fixture-calls.ts`,
  `// Written by test/types/check.mjs from the parity fixtures: do not edit.
import * as rs from '@pond-ts/wasm';
import {
  TimeSeries,
  TradingCalendar,
  Sequence,
  Trigger,
  LiveSeries,
  LiveAggregation,
  LiveView,
  LiveRollingAggregation,
  LiveFusedRolling,
  LiveReduce,
  LivePartitionedSeries,
  LivePartitionedView,
  LivePartitionedFusedRolling,
  LivePartitionedSyncRolling,
  Event,
  col,
  lit,
  when,
} from '@pond-ts/wasm';

declare const input: TimeSeries;
declare const other: TimeSeries;
declare const bars: TimeSeries;
declare const calendar: TradingCalendar;

export function surface() {
${surface.join('\n')}
}

export function coreAndStudies() {
${lines.join('\n')}
}

${liveLines.join('\n')}
`,
);

const tsc = here('../../../../node_modules/.bin/tsc');
const r = spawnSync(tsc, ['-p', here('tsconfig.json')], { encoding: 'utf8' });
if (r.status !== 0) {
  process.stdout.write(r.stdout.split('\n').slice(0, 60).join('\n'));
  console.error(
    `\ntsc failed (${r.stdout.split('\n').filter((l) => l.includes('error TS')).length} errors)`,
  );
  process.exit(1);
}
console.log(
  `index.d.ts: ${surface.length} runtime names declared; ${calls} core calls, ${studyCalls} study calls (${extraOptions} options studies do not have left out) and ${liveCalls} live steps from the fixtures compile under tsc --strict`,
);
