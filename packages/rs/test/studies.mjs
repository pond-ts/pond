// Runs @pond-ts/financial's fixtures through @pond-ts/rs's public JS API:
//
// - study-parity.json: @pond-ts/financial output, bit for bit (the Rust
//   harness crates/pond-rs/tests/study_parity.rs runs the same cases).
// - study-oracle.json: pandas / TA-Lib, within 5e-10.
// - catalog-parity.json: every descriptor equals pond-ts's; every study
//   runs from its method with its defaults.
// - calendar-parity.json: trading calendars.
//
//   node test/studies.mjs           (after ./build.sh)
import { deepStrictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TimeSeries,
  TradingCalendar,
  alive,
  calendarsAlive,
  generateSessions,
  studies,
  studyInfo,
} from '../index.js';

const load = (name) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../financial/test/fixtures/${name}`, import.meta.url),
      ),
      'utf8',
    ),
  );

const failures = [];
const report = [];
const fail = (what) => failures.push(what);

// ---- shared helpers ---------------------------------------------------------

const untag = (v) =>
  Array.isArray(v)
    ? v.map(untag)
    : v && typeof v === 'object' && 'f64' in v
      ? { '-0': -0, NaN: NaN, inf: Infinity, '-inf': -Infinity }[v.f64]
      : v;

/** Same bits (signed zeros and NaN included), or within `tol`. */
function sameNumber(e, a, tol) {
  if (e === 0 && a === 0) return Object.is(e, a);
  if (Number.isNaN(e) || Number.isNaN(a))
    return Number.isNaN(e) && Number.isNaN(a);
  if (tol !== undefined) return Math.abs(e - a) <= tol;
  return e === a;
}

/** A small stable hash, to split calls between the two doors. */
const hash = (text) => {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h >>> 0;
};

const calendars = new Map();
/** The fixture's way of writing a calendar: `{ rules, from, to }`. */
function calendarOf(spec) {
  const key = JSON.stringify(spec);
  let c = calendars.get(key);
  if (!c) {
    c = TradingCalendar.fromRules(spec.rules, { from: spec.from, to: spec.to });
    calendars.set(key, c);
  }
  return c;
}

/**
 * A study call written as pond-ts's name and options, half the time as
 * `series.study(name, options)` and half as the named method, so both doors
 * are covered.
 */
function call(series, study, options) {
  const o = { ...options };
  if (o.sessions && !Array.isArray(o.sessions) && o.sessions.rules)
    o.sessions = calendarOf(o.sessions);
  return hash(JSON.stringify([study, options])) % 2
    ? series.study(study, o)
    : series[study](o);
}

// The bridge failing in a way pond-ts never could: a JS slip (TypeError),
// or the bridge's own argument checks. Never counts as an agreeing error.
const BRIDGE_SLIP =
  /^study: argument \d+ must be|is not a study|names no calendar|was freed/;
const slip = (e) => e.name === 'TypeError' || BRIDGE_SLIP.test(e.message);

/** The columns a study reads with these options, from the catalog. */
function sources(study, options) {
  const info = studyInfo(study);
  const out = [];
  for (const i of info.inputs) {
    let def = i.default;
    if (
      (study === 'atrBands' || study === 'prettyGoodOscillator') &&
      i.role === 'column'
    )
      def = options.close ?? 'close';
    if (study === 'medianPrice' && i.role === 'close') continue; // never read
    const name = options[i.role] ?? def;
    if (name !== undefined) out.push(name);
  }
  return out;
}

// ---- study parity: @pond-ts/financial, bit for bit -------------------------

function checkStudy(source, got, expected) {
  const [src, out] = [source.schema, got.schema];
  if (
    got.length !== source.length ||
    JSON.stringify(out.slice(0, src.length)) !== JSON.stringify(src)
  )
    return "changed the input's columns or rows";
  const added = out.slice(src.length);
  if (added.length !== expected.length)
    return `added ${added.length} columns, pond-ts ${expected.length}`;
  for (let c = 0; c < added.length; c++) {
    const [d, want] = [added[c], expected[c]];
    const required = d.required !== false;
    if (
      d.name !== want.name ||
      d.kind !== want.kind ||
      required !== want.required
    )
      return `column ${JSON.stringify(d)}, pond-ts ${want.name} ${want.kind} required=${want.required}`;
    const have = got.numbers(d.name);
    for (let i = 0; i < want.values.length; i++) {
      const e = untag(want.values[i]);
      if (e === null) {
        if (!Number.isNaN(have[i]))
          return `${d.name}[${i}]: expected a gap, got ${have[i]}`;
      } else if (!sameNumber(e, have[i])) {
        return `${d.name}[${i}]: expected ${e}, got ${have[i]}`;
      }
    }
  }
  return null;
}

{
  const fixture = load('study-parity.json');
  const inputs = new Map(
    Object.entries(fixture.inputs).map(([k, json]) => [
      k,
      TimeSeries.fromJSON({ ...json, rows: untag(json.rows) }),
    ]),
  );
  const counts = { matched: 0, errors: 0, refused: 0 };
  for (const c of fixture.cases) {
    const label = `${c.id} ${JSON.stringify(c.options)}`;
    const s = inputs.get(c.input);
    let got;
    try {
      got = call(s, c.study, c.options);
    } catch (e) {
      got = e;
    }
    const isError = got instanceof Error;
    try {
      if (isError && slip(got)) {
        fail(`${label}: the bridge failed (${got.name}: ${got.message})`);
        continue;
      }
      // Known difference (the Rust harness's): pond-rs refuses a missing or
      // non-number source column, where pond-ts reads it as all gaps.
      const names = s.schema.map((d) => d.name);
      const refused = sources(c.study, c.options).some((col) => {
        const at = names.indexOf(col);
        return at < 1 || (s.schema[at].kind ?? 'number') !== 'number';
      });
      if (!c.expected) {
        if (isError) counts.errors++;
        else
          fail(
            `${label}: pond-ts throws (${c.error.message}), bridge succeeds`,
          );
      } else if (refused) {
        if (isError) counts.refused++;
        else fail(`${label}: the bridge should refuse this source column`);
      } else if (isError) {
        fail(`${label}: the bridge threw ${got.message}`);
      } else {
        const why = checkStudy(s, got, c.expected);
        if (why) fail(`${label}: ${why}`);
        else counts.matched++;
      }
    } finally {
      if (!isError) got.free();
    }
  }
  for (const s of inputs.values()) s.free();
  // The Rust harness: 3,702 matched, 827 errors agree, 526 refused.
  const want = { matched: 3702, errors: 827, refused: 526 };
  if (JSON.stringify(counts) !== JSON.stringify(want))
    fail(
      `study parity counts ${JSON.stringify(counts)}, want ${JSON.stringify(want)}`,
    );
  report.push(
    `study parity ${counts.matched} matched bit for bit, ${counts.errors} errors agree, ${counts.refused} known refusals (of ${fixture.cases.length})`,
  );
}

// ---- pandas / TA-Lib oracle --------------------------------------------------

{
  const fixture = load('study-oracle.json');
  const i = fixture.input;
  const bars = (which) => {
    let cols;
    let times;
    if (which === 'long') {
      cols = { close: i.longCloses };
      times = i.longCloses.map((_, k) => k);
    } else {
      cols = {
        open: i.opens,
        high: i.highs,
        low: i.lows,
        close: i.closes,
        volume: i.volumes,
      };
      if (which === undefined) {
        cols.bench = i.benchmarks;
        times = i.closes.map((_, k) => k);
      } else {
        times = i.sessionTimes.map(Number);
      }
    }
    const names = Object.keys(cols);
    return new TimeSeries({
      name: 'oracle',
      schema: [
        { name: 'time', kind: 'time' },
        ...names.map((name) => ({ name, kind: 'number' })),
      ],
      rows: times.map((t, k) => [t, ...names.map((n) => cols[n][k])]),
    });
  };
  const nyse = TradingCalendar.fromRules(
    {
      timeZone: 'America/New_York',
      open: '09:30',
      close: '16:00',
      holidays: ['2024-01-15'],
    },
    { from: '2024-01-08', to: '2024-01-16' },
  );
  let ok = 0;
  for (const c of fixture.cases) {
    const params = { ...c.params };
    if (c.input === 'session') params.sessions = nyse;
    const label = `${c.study}(${JSON.stringify(c.params)})`;
    const input = bars(c.input);
    let out;
    try {
      out = call(input, c.study, params);
    } catch (e) {
      fail(`oracle ${label}: ${e.message}`);
      input.free();
      continue;
    }
    let good = true;
    for (const [name, want] of Object.entries(c.expected)) {
      const have = out.numbers(name);
      for (let k = 0; k < want.length; k++) {
        const [e, a] = [want[k], have[k]];
        const bad =
          e === null
            ? !Number.isNaN(a)
            : Number.isNaN(a) || Math.abs(e - a) > 5e-10;
        if (bad) {
          fail(`oracle ${label}.${name}[${k}]: expected ${e}, got ${a}`);
          good = false;
          break;
        }
      }
    }
    if (good) ok++;
    out.free();
    input.free();
  }
  nyse.free();
  report.push(`oracle ${ok}/${fixture.cases.length} within 5e-10`);
}

// ---- the catalog -------------------------------------------------------------

{
  const fixture = load('catalog-parity.json');
  const mine = studies();
  let same = 0;
  if (mine.length !== fixture.studies.length)
    fail(`catalog: ${mine.length} studies, pond-ts ${fixture.studies.length}`);
  fixture.studies.forEach((want, k) => {
    try {
      deepStrictEqual(mine[k], want);
      deepStrictEqual(studyInfo(want.name), want);
      same++;
    } catch {
      fail(`catalog: descriptor ${want.name} differs`);
    }
  });
  if (studyInfo('nope') !== undefined)
    fail('studyInfo("nope") should be undefined');

  const names = ['open', 'high', 'low', 'close', 'volume', 'sess'];
  const bars = new TimeSeries({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      ...names.map((name) => ({ name, kind: 'number' })),
    ],
    rows: fixture.bars,
  });
  let ran = 0;
  for (const d of mine) {
    const options = {};
    for (const i of d.inputs) if (!('default' in i)) options[i.role] = 'open';
    for (const [name, p] of Object.entries(d.params))
      if (!p.optional && !('default' in p)) options[name] = p.example;
    if (d.anchor === 'session') options.session = 'sess';
    else if (d.anchor === 'time') options.anchor = fixture.bars[30][0];
    let out;
    try {
      out = bars[d.name](options);
    } catch (e) {
      fail(`catalog: ${d.name} with its defaults threw ${e.message}`);
      continue;
    }
    const outputs =
      d.naming.kind === 'output'
        ? [d.naming.default]
        : d.outputs.map((o) => d.naming.default + o.id);
    const got = out.schema.map((c) => c.name);
    const want = ['time', ...names, ...outputs];
    if (
      JSON.stringify(got) !== JSON.stringify(want) ||
      out.length !== bars.length
    )
      fail(`catalog: ${d.name} wrote ${got.slice(7)}, want ${outputs}`);
    else ran++;
    out.free();
  }

  // The doors pond-ts has besides the fixtures.
  const extra = [];
  const check = (what, ok) => ok || extra.push(what);
  const a = bars.rsi({ period: 5 });
  const b = bars.study('rsi', { period: 5, peroid: 9 }); // ignored, as pond-ts
  check('unknown options are ignored', sameColumn(a, b, 'rsi'));
  a.free();
  b.free();
  const t = fixture.bars[30][0];
  const byNumber = bars.anchoredVwap({ anchor: t });
  const byDate = bars.anchoredVwap({ anchor: new Date(t) });
  check('anchor as a Date', sameColumn(byNumber, byDate, 'avwap'));
  byNumber.free();
  byDate.free();
  // Per partition: each group as if filtered out alone.
  const syms = new TimeSeries({
    name: 'bars',
    schema: [...bars.schema, { name: 'sym', kind: 'string' }],
    rows: fixture.bars.map((r, k) => [...r, k % 2 ? 'a' : 'b']),
  });
  const per = syms.partitionBy('sym').rsi({ period: 5 }).toMap();
  check('partitioned groups', [...per.keys()].sort().join() === 'a,b');
  for (const [key, part] of per) {
    const alone = syms.filter((e) => e.get('sym') === key);
    const want = alone.rsi({ period: 5 });
    check(`partition ${key}`, sameColumn(part, want, 'rsi'));
    for (const s of [part, alone, want]) s.free();
  }
  syms.free();
  for (const [what, f] of [
    ['an unknown study', () => bars.study('nope')],
    ['a fractional bar count', () => bars.rsi({ period: 2.5 })],
    ['an output collision', () => bars.sma({ output: 'close' })],
  ]) {
    try {
      f().free();
      extra.push(`${what} should throw`);
    } catch (e) {
      if (e.name === 'TypeError') extra.push(`${what}: JS ${e.message}`);
    }
  }
  bars.free();
  for (const e of extra) fail(`catalog: ${e}`);
  report.push(
    `catalog ${same}/${fixture.studies.length} descriptors equal; ${ran}/${mine.length} run from their method with defaults`,
  );
}

function sameColumn(x, y, name) {
  const [a, b] = [x.numbers(name), y.numbers(name)];
  return a.length === b.length && a.every((v, k) => sameNumber(v, b[k]));
}

// ---- session studies: a calendar, a list or a column ----------------------

{
  const nyse = TradingCalendar.fromRules(
    { timeZone: 'America/New_York', open: '09:30', close: '16:00' },
    { from: '2024-01-08', to: new Date('2024-01-12T12:00:00Z') },
  );
  const times = nyse
    .sessions()
    .flatMap((s) =>
      Array.from({ length: 13 }, (_, k) => s.open + k * 1_800_000),
    );
  const bars = new TimeSeries({
    name: 'bars',
    schema: ['time', 'high', 'low', 'close', 'volume'].map((name, k) => ({
      name,
      kind: k ? 'number' : 'time',
    })),
    rows: times.map((t, i) => [
      t,
      101 + (i % 5),
      99 - (i % 3),
      100 + (i % 4),
      1000 + i,
    ]),
  });
  const byCalendar = bars.sessionVwap({ sessions: nyse });
  const byList = bars.sessionVwap({ sessions: nyse.sessions() });
  const tagged = nyse.tagSessions(bars);
  const byColumn = tagged.sessionVwap({ session: 'session' });
  if (
    !sameColumn(byCalendar, byList, 'svwap') ||
    !sameColumn(byCalendar, byColumn, 'svwap')
  )
    fail('sessionVwap: calendar, list and column disagree');
  const pivots = bars.pivotPoints({ sessions: nyse, method: 'camarilla' });
  if (!pivots.schema.some((d) => d.name === 'ppR4'))
    fail('pivotPoints camarilla wrote no ppR4');
  for (const s of [byCalendar, byList, tagged, byColumn, pivots, bars])
    s.free();
  nyse.free();
}

// ---- trading calendars ----------------------------------------------------------

// pond-ts errors whose text comes from Temporal or core; pond-rs words them
// its own way.
const FOREIGN = [
  'Unrecognized time zone',
  'invalid RFC 9557 string',
  'value out of range',
  'withColumnAppended',
];
const sessionsOf = (list) =>
  list.map((s) => ({
    date: s.date,
    open: s.open,
    close: s.close,
    breaks: s.breaks ?? [],
  }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Why `run()` disagrees with the case (`expected` or `error`), or null. */
function outcome(c, run, expected) {
  let got;
  try {
    got = run();
  } catch (e) {
    if ('expected' in c) return `the bridge threw ${e.message}`;
    if (e.name === 'TypeError') return `the bridge failed in JS: ${e.message}`;
    const want = c.error.message;
    if (FOREIGN.some((f) => want.startsWith(f)) || e.message.includes(want))
      return null;
    return `message differs: pond-ts ${JSON.stringify(want)}, bridge ${e.message}`;
  }
  if (!('expected' in c))
    return `pond-ts throws (${c.error.message}), the bridge gave ${JSON.stringify(got)}`;
  const want = expected(c.expected);
  return same(got, want)
    ? null
    : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
}

function fromRules(c) {
  return TradingCalendar.fromRules(c.rules, { from: c.from, to: c.to });
}

function generateCase(c) {
  // generateSessions and fromRules differ only in fromRules checking the
  // list; the fixture records both outcomes.
  const why = outcome(
    c,
    () => generateSessions(c.rules, { from: c.from, to: c.to }),
    sessionsOf,
  );
  if (why) return `generateSessions: ${why}`;
  const cal = c.calendar;
  let got;
  try {
    got = fromRules(c);
  } catch (e) {
    if (cal === true) return `fromRules threw ${e.message}`;
    if (e.name === 'TypeError') return `fromRules failed in JS: ${e.message}`;
    if (cal && typeof cal === 'object' && !e.message.includes(cal.message))
      return `message differs: pond-ts ${JSON.stringify(cal.message)}, bridge ${e.message}`;
    return null;
  }
  try {
    if (cal !== true)
      return `fromRules throws in pond-ts (${JSON.stringify(cal)}), not here`;
    if (got.timeZone !== c.rules.timeZone) return 'fromRules lost the zone';
    const want = sessionsOf(c.expected);
    return same(got.sessions(), want) ? null : 'fromRules sessions differ';
  } finally {
    got.free();
  }
}

const ISO = /^\d{4}-\d\d-\d\d$/;
let refusedDates = 0;

function queriesCase(c) {
  const cal =
    'rules' in c ? fromRules(c) : TradingCalendar.fromSessions(c.sessions);
  try {
    if (!same(cal.sessions(), sessionsOf(c.sessions)))
      return 'calendar sessions differ';
    const date = (s) => (s === undefined ? null : s.date);
    for (const q of c.queries) {
      const [m, a] = [q.call, q.arg];
      if (typeof a === 'string' && !ISO.test(a)) {
        // Known difference (as the Python bridge): pond-ts compares any text
        // with session dates as text, so "" or "2024-01-08x" quietly finds
        // nothing or the wrong neighbour; only YYYY-MM-DD is taken here.
        try {
          cal[m](a);
        } catch (e) {
          if (e.name !== 'TypeError' && /YYYY-MM-DD/.test(e.message)) {
            refusedDates++;
            continue;
          }
          return `${m}(${JSON.stringify(a)}) failed in JS: ${e.message}`;
        }
        return `${m}(${JSON.stringify(a)}) should throw`;
      }
      let got;
      if (m === 'length') got = cal.length;
      else if (m === 'sessionsInRange')
        got = cal.sessionsInRange(a).map((s) => s.date);
      else if (m === 'isTradingDay' || m === 'isOpen') got = cal[m](a);
      else got = date(cal[m](a));
      if (!same(got, q.result))
        return `${m}(${JSON.stringify(a)}): got ${JSON.stringify(got)}, want ${JSON.stringify(q.result)}`;
    }
    return null;
  } finally {
    cal.free();
  }
}

function tagCase(c) {
  const cal = TradingCalendar.fromSessions(c.sessions);
  const bars = new TimeSeries({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
    ],
    rows: c.keys.map((t, i) => [t, i]),
  });
  try {
    return outcome(
      c,
      () => {
        const tagged = cal.tagSessions(bars, c.options);
        try {
          const last = tagged.schema.at(-1);
          if (last.required !== false) return 'session ids should be optional';
          return [...tagged.numbers(last.name)].map((v) =>
            Number.isNaN(v) ? null : v,
          );
        } finally {
          tagged.free();
        }
      },
      (want) => want,
    );
  } finally {
    bars.free();
    cal.free();
  }
}

{
  const { cases } = load('calendar-parity.json');
  const counts = {};
  let ok = 0;
  for (const c of cases) {
    counts[c.kind] = (counts[c.kind] ?? 0) + 1;
    let why;
    try {
      why =
        c.kind === 'generate'
          ? generateCase(c)
          : c.kind === 'sessions'
            ? outcome(
                c,
                () => {
                  const cal = TradingCalendar.fromSessions(c.sessions);
                  const s = cal.sessions();
                  cal.free();
                  return s;
                },
                sessionsOf,
              )
            : c.kind === 'queries'
              ? queriesCase(c)
              : c.kind === 'tag'
                ? tagCase(c)
                : `unknown kind ${c.kind}`;
    } catch (e) {
      why = `threw ${e.name}: ${e.message}`;
    }
    if (why) fail(`calendar ${c.id ?? c.kind}: ${why}`);
    else ok++;
  }
  if (refusedDates !== 32)
    fail(`calendar: ${refusedDates} non-date texts refused, want 32`);
  report.push(
    `calendar ${ok}/${cases.length} (${Object.entries(counts)
      .map(([k, n]) => `${n} ${k}`)
      .join(
        ', ',
      )}; ${refusedDates} non-date lookups refused, a known difference)`,
  );
}

for (const c of calendars.values()) c.free();
const leaked = alive() + calendarsAlive();
console.log(
  `studies through @pond-ts/rs: ${report.join('; ')}; ${leaked} series / calendars left in memory`,
);
for (const f of failures.slice(0, 60)) console.log('  ' + f);
if (failures.length > 60) console.log(`  … and ${failures.length - 60} more`);
if (failures.length || leaked) process.exit(1);
