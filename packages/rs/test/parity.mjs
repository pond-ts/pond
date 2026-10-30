// Runs pond-ts's core parity fixture through @pond-ts/rs: every case must
// give what pond-ts gave (or throw where pond-ts threw), through the public
// JS API. The same fixture checks pond-rs natively in
// crates/pond-rs/tests/core_parity.rs; this run checks the bridge on top.
//
//   node test/parity.mjs           (after ./build.sh)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TimeSeries, Sequence, alive } from '../index.js';

const FIXTURE = fileURLToPath(
  new URL('../../core/test/fixtures/parity.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));

// Cases the bridge cannot run yet: callbacks (filter, mapColumns, scan,
// collapse, asInterval with a function) arrive in step J1b.
const STATICS = new Set(['partitionBy', 'joinMany', 'concat']);
const usesCallback = (c) =>
  JSON.stringify(c.args).includes('"fn":') ||
  !(STATICS.has(c.op) || typeof TimeSeries.prototype[c.op] === 'function');

// A pond-ts error case matches any error pond-rs raises (the messages
// differ), but not a slip in the bridge: a JS TypeError (a missing method,
// a bad argument in index.js) never matches, and the dispatcher's own
// argument checks match only in these cases, where pond-ts refuses the
// same argument.
const DECODER_ERROR =
  /argument \d+ must be|option '\w+' must be|give \{ stride \}|expected a (mapping|Sequence|series)/;
const DECODER_REFUSES = new Set([
  'error-shift-fraction',
  'smooth-ema-warmup-neg',
  'smooth-ema-warmup-frac',
  'smooth-ema-minSamples-frac',
  'sample-stride-frac',
  'sample-reservoir-frac',
]);

// Known differences between pond-rs and pond-ts, the same list (and the same
// reasons) as crates/pond-rs/tests/core_parity.rs.
// On an empty series pond-ts never builds the range, so a backwards one is
// no error there; pond-rs checks a key when it is built.
const REFUSES_BACKWARDS = new Set([
  'span-overlapping-emptyHosts-8',
  'span-trim-emptyHosts-8',
]);
// Without a kind, pond-ts writes number arrays' elements as text and throws;
// pond-rs takes the elements' kind, as pond-ts does with `kind: 'number'`.
const SAME_AS = new Map([
  ['arrayAggregate-nums-first', 'arrayAggregate-nums-first-number'],
  ['arrayExplode-nums', 'arrayExplode-nums-number'],
]);
// pond-ts smooths / baselines a text column to gaps and passes an unknown
// column through; pond-rs refuses them.
const REFUSED = new Set([
  'smooth-ema-text',
  'smooth-ema-unknown',
  'baseline-text',
  'partition-smooth-text',
]);

// ---- fixture encoding -> JS values ----------------------------------------

function number(tag) {
  return { '-0': -0, NaN: NaN, inf: Infinity, '-inf': -Infinity }[tag];
}

/** Rows with the fixture's number tags read back to numbers. */
function untagRows(rows) {
  const cell = (v) =>
    Array.isArray(v)
      ? v.map(cell)
      : v && typeof v === 'object' && 'f64' in v
        ? number(v.f64)
        : v;
  return rows.map((r) => r.map(cell));
}

const inputs = new Map();
function input(name) {
  let s = inputs.get(name);
  if (!s) {
    const json = fixture.inputs[name];
    s = new TimeSeries({ ...json, rows: untagRows(json.rows) });
    inputs.set(name, s);
  }
  return s;
}

/** A fixture argument as the JS value a caller would pass. */
function arg(v) {
  if (Array.isArray(v)) return v.map(arg);
  if (v && typeof v === 'object') {
    if ('series' in v) return input(v.series);
    if ('sequence' in v) return new Sequence(v.sequence);
    if ('f64' in v) return number(v.f64);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, arg(x)]));
  }
  return v;
}

// ---- JS values -> fixture encoding ----------------------------------------

function tag(v) {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return { f64: 'NaN' };
    if (v === Infinity) return { f64: 'inf' };
    if (v === -Infinity) return { f64: '-inf' };
    if (Object.is(v, -0)) return { f64: '-0' };
    return v;
  }
  if (Array.isArray(v)) return v.map(tag);
  return v === undefined ? null : v;
}

function seriesJson(s) {
  const json = s.toJSON();
  return {
    ...json,
    rows: json.rows.map((r) => [r[0], ...r.slice(1).map(tag)]),
  };
}

const recordJson = (r) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, tag(v)]));

// ---- run one case ---------------------------------------------------------

/** The case's outcome through the JS API: { series | groups | record | records } or { error }. */
function run(c) {
  const self = input(c.input);
  const args = arg(c.args);
  const made = [];
  const keep = (s) => (made.push(s), s);
  try {
    let out;
    if (c.op === 'partitionBy') {
      const [by, steps, end] = args;
      let view = self.partitionBy(by);
      for (const [method, ...rest] of steps) view = view[method](...rest);
      out = view[end]();
    } else if (c.op === 'joinMany') {
      out = TimeSeries.joinMany([self, ...args[0]], args[1]);
    } else if (c.op === 'concat') {
      out = TimeSeries.concat([self, ...args[0]]);
    } else {
      out = self[c.op](...args);
    }
    if (out instanceof TimeSeries) return { series: seriesJson(keep(out)) };
    if (out instanceof Map)
      return {
        groups: [...out].map(([k, s]) => [k, seriesJson(keep(s))]),
      };
    if (Array.isArray(out)) return { records: out.map(recordJson) };
    return { record: recordJson(out) };
  } catch (e) {
    return { error: e.message, errorName: e.name };
  } finally {
    for (const s of made) s.free();
  }
}

// ---- compare --------------------------------------------------------------

const asNumber = (v) =>
  typeof v === 'number'
    ? v
    : v && typeof v === 'object' && 'f64' in v
      ? number(v.f64)
      : undefined;

/** Same bits, or within `tol` when both finite; signed zeros always exact. */
function sameNumber(e, a, tol) {
  if (e === 0 && a === 0) return Object.is(e, a);
  if (Number.isNaN(e) || Number.isNaN(a))
    return Number.isNaN(e) && Number.isNaN(a);
  if (tol !== undefined && Number.isFinite(e) && Number.isFinite(a))
    return Math.abs(e - a) <= tol;
  return e === a;
}

function cellDiff(e, a, tol) {
  const [en, an] = [asNumber(e), asNumber(a)];
  if (en !== undefined && an !== undefined)
    return sameNumber(en, an, tol)
      ? null
      : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`;
  if (Array.isArray(e) && Array.isArray(a)) {
    if (e.length !== a.length)
      return `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`;
    for (let i = 0; i < e.length; i++) {
      const d = cellDiff(e[i], a[i], tol);
      if (d) return d;
    }
    return null;
  }
  return JSON.stringify(e) === JSON.stringify(a)
    ? null
    : `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`;
}

function seriesDiff(e, a, tol) {
  if (e.name !== a.name) return `name: expected ${e.name}, got ${a.name}`;
  if (JSON.stringify(e.schema) !== JSON.stringify(a.schema))
    return `schema: expected ${JSON.stringify(e.schema)}, got ${JSON.stringify(a.schema)}`;
  if (e.rows.length !== a.rows.length)
    return `rows: expected ${e.rows.length}, got ${a.rows.length}`;
  for (let r = 0; r < e.rows.length; r++) {
    const [er, ar] = [e.rows[r], a.rows[r]];
    if (er.length !== ar.length) return `row ${r}: width differs`;
    // Keys are exact (no tolerance), compared as numbers.
    const k = cellDiff(er[0], ar[0], undefined);
    if (k) return `row ${r} key: ${k}`;
    for (let c = 1; c < er.length; c++) {
      const d = cellDiff(er[c], ar[c], tol);
      if (d) return `row ${r} column '${e.schema[c].name}': ${d}`;
    }
  }
  return null;
}

function recordDiff(e, a, tol) {
  const [ek, ak] = [Object.keys(e), Object.keys(a)];
  if (ek.join() !== ak.join()) return `outputs: expected ${ek}, got ${ak}`;
  for (const k of ek) {
    const d = cellDiff(e[k], a[k], tol);
    if (d) return `output '${k}': ${d}`;
  }
  return null;
}

/** Why the outcome differs from the case's expectation, or null. */
function check(c, got) {
  const tol = c.tolerance ?? undefined;
  if (c.error) {
    if (got.error === undefined) return 'pond-ts throws, bridge succeeded';
    if (got.errorName === 'TypeError')
      return `pond-ts throws, bridge failed in JS: ${got.error}`;
    if (DECODER_ERROR.test(got.error) && !DECODER_REFUSES.has(c.id))
      return `pond-ts throws, bridge refused an argument: ${got.error}`;
    return null;
  }
  if (got.error !== undefined)
    return `pond-ts succeeds, bridge threw: ${got.error}`;
  if (c.expected)
    return got.series
      ? seriesDiff(c.expected, got.series, tol)
      : 'expected a series';
  if (c.groups) {
    if (!got.groups) return 'expected groups';
    if (c.groups.length !== got.groups.length)
      return `groups: expected ${c.groups.length}, got ${got.groups.length}`;
    for (let i = 0; i < c.groups.length; i++) {
      const [[ek, es], [ak, as]] = [c.groups[i], got.groups[i]];
      if (ek !== ak) return `group ${i}: expected key ${ek}, got ${ak}`;
      const d = seriesDiff(es, as, tol);
      if (d) return `group ${ek}: ${d}`;
    }
    return null;
  }
  if (c.reduced)
    return got.record
      ? recordDiff(c.reduced, got.record, tol)
      : 'expected a record';
  if (c.records) {
    if (!got.records) return 'expected records';
    if (c.records.length !== got.records.length)
      return `records: expected ${c.records.length}, got ${got.records.length}`;
    for (let i = 0; i < c.records.length; i++) {
      const d = recordDiff(c.records[i], got.records[i], tol);
      if (d) return `record ${i}: ${d}`;
    }
    return null;
  }
  return 'fixture case has no expectation';
}

/** [PND-COLLAPSEREQ]: pond-rs marks a collapse output with gaps optional. */
function adjust(c) {
  if (c.op !== 'collapse' || !c.expected) return c;
  const expected = structuredClone(c.expected);
  const at = expected.schema.findIndex((d) => d.name === c.args[1]);
  if (expected.rows.some((r) => r[at] === null))
    expected.schema[at].required = false;
  return { ...c, expected };
}

// ---- main -----------------------------------------------------------------

const byId = new Map(fixture.cases.map((c) => [c.id, c]));
let ran = 0;
let skipped = 0;
const failures = [];
for (const c of fixture.cases) {
  if (usesCallback(c)) {
    skipped++;
    continue;
  }
  ran++;
  const got = run(c);
  let why;
  if (REFUSES_BACKWARDS.has(c.id) || REFUSED.has(c.id)) {
    why =
      got.error !== undefined
        ? null
        : 'pond-rs should refuse (a known difference)';
  } else if (SAME_AS.has(c.id)) {
    why = check(byId.get(SAME_AS.get(c.id)), got);
  } else {
    why = check(adjust(c), got);
  }
  if (why) failures.push(`${c.id} (${c.op}): ${why}`);
}

for (const s of inputs.values()) s.free();
const leaked = alive();

console.log(
  `core parity through @pond-ts/rs: ${ran - failures.length}/${ran} match pond-ts; ` +
    `${skipped} skipped (callbacks, step J1b); ${leaked} series left in memory`,
);
for (const f of failures) console.log('  ' + f);
if (failures.length || leaked) process.exit(1);
