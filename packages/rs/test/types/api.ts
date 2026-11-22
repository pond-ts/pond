// Hand-written uses of @pond-ts/wasm, compiled by test/types/check.mjs:
// what the README and docs show must compile, return types must be what
// the runtime gives, and mistakes must not compile (`@ts-expect-error`
// fails the build if the line after it compiles).
import {
  Event,
  LiveAggregation,
  LiveSeries,
  Sequence,
  Time,
  TimeRange,
  TimeSeries,
  TradingCalendar,
  Trigger,
  col,
  lit,
  studies,
  studyInfo,
  version,
  when,
  type Cell,
  type LiveRollingAggregation,
  type ReducedRecord,
} from '@pond-ts/wasm';
import { TimeSeries as PondSeries } from 'pond-ts';

// The README's first example.
const cpu = new TimeSeries({
  name: 'cpu',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ],
  rows: [
    [0, 0.31],
    [60_000, 0.44],
    [120_000, 0.52],
  ],
});
const busy: TimeSeries = cpu.filter(col('value').gt(0.4));
const perTwoMinutes = cpu.aggregate(Sequence.every('2m'), { value: 'avg' });
const n: number = busy.length;
void n;

// A schema declared once, `as const`, works too.
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'v', kind: 'number', required: false },
] as const;
const hosts = new TimeSeries({
  schema,
  rows: [
    [0, 'a', 1],
    [1000, 'b', undefined],
  ],
});

// Reads.
const first: Event | undefined = cpu.at(0);
const cell: Cell | undefined = first?.get('value');
void cell;
const record: ReducedRecord = cpu.reduce({
  peak: { from: 'value', using: 'max' },
  p95: 'p95',
});
void record;
const span: TimeRange | undefined = cpu.timeRange();
void span;
const groups: Map<string, TimeSeries> = hosts.groupBy('host');
void groups;
const values: Float64Array = cpu.numbers('value');
void values;
const json = cpu.toJSON();
const objects = cpu.toJSON({ rowFormat: 'object' });
void json.rows[0]?.[0];
void objects.rows[0]?.['time'];

// Expressions and functions.
cpu.withColumn('pct', lit(100).mul(col('value')));
cpu.withColumn('band', when(col('value').gt(0.5), 'high', 'low'));
cpu.filter((e, i) => (e.get('value') as number) > 0.4 && i > 0);
cpu.mapColumns({ value: (v: number) => v * 2 });
cpu.scan('value', (acc: number, v, i) => [acc + v, acc + i] as const, 0);

// Partitioned chains and studies.
const perHost: TimeSeries = hosts
  .partitionBy('host')
  .fill('hold')
  .rolling('5m', { v: 'avg' })
  .collect();
void perHost;
cpu.rsi({ period: 14 });
cpu.study('bollinger', { period: 20, stdDev: 2 });
hosts.partitionBy('host').sma({ period: 3, column: 'v' }).collect();
const rsiInfo = studyInfo('rsi');
void rsiInfo?.params;
void studies()[0]?.name;

// Trading calendars and session studies.
const cal = TradingCalendar.fromRules(
  { timeZone: 'America/New_York', open: '09:30', close: '16:00' },
  { from: '2026-01-05', to: '2026-02-13' },
);
cpu.sessionVwap({ sessions: cal });
cpu.sessionVwap({ session: 'session' });
cpu.anchoredVwap({ anchor: new Date(0) });
cal.free();

// Keys.
const t = Time.parse('2025-01-01T09:00', { timeZone: 'Europe/Madrid' });
cpu.before(t);
cpu.trim([0, 60_000]);
cpu.after({ time: 60_000 });
new TimeRange({ start: 0, end: 1 }).duration();

// The route to @pond-ts/charts: pond-ts reads `toColumns()` back.
const forCharts = PondSeries.fromColumns(cpu.toColumns<'number'>());
void forCharts.column('value');
// @ts-expect-error: without the type argument a column may hold true/false
PondSeries.fromColumns(cpu.toColumns());
void forCharts;

// Live.
const live = new LiveSeries({
  name: 'cpu',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'cpu', kind: 'number' },
  ],
  retention: { maxEvents: 1000 },
});
const avg: LiveRollingAggregation = live.rolling('1m', {
  avg: { from: 'cpu', using: 'avg' },
});
const perMinute: LiveAggregation = live.aggregate(Sequence.every('1m'), {
  cpu: 'max',
});
const stop: () => void = perMinute.on('event', (bucket: Event) =>
  bucket.get('cpu'),
);
perMinute.on('bucket', (bucket: Event) => bucket.begin());
live.on('batch', (events: Event[]) => events.length);
live.on('columns', (batch: TimeSeries) => batch.free());
avg.on('update', (v) => v?.['avg']);
live.push([0, 0.31]);
live.pushMany([
  [30_000, 0.44],
  [61_000, 0.52],
]);
void avg.value()['avg'];
live.reduce({ n: 'count' }, { trigger: Trigger.count(10) });
const parts = live.partitionBy('cpu');
parts
  .apply((sub) => sub.fill('hold').rolling('1m', { cpu: 'avg' }))
  .on('event', () => {});
parts.rolling('1m', { cpu: 'avg' }, { trigger: Trigger.every('1m') }).stats();
stop();
live.free();

const v: string = version;
void v;
for (const s of [busy, perTwoMinutes, cpu, hosts]) s.free();

// ---- mistakes that must not compile -----------------------------------------

// @ts-expect-error: the key column comes first
new TimeSeries({ schema: [{ name: 'v', kind: 'number' }], rows: [] });
// @ts-expect-error: no such reducer
cpu.aggregate(Sequence.every('1m'), { value: 'average' });
// @ts-expect-error: aggregate takes a Sequence, not a duration
cpu.aggregate('1m', { value: 'avg' });
// @ts-expect-error: rsi has no `length` option
cpu.rsi({ length: 14 });
// @ts-expect-error: bollinger needs a period
cpu.bollinger();
// @ts-expect-error: beta needs a benchmark column
cpu.beta({ period: 5 });
// @ts-expect-error: no such study
cpu.study('rsx', {});
// @ts-expect-error: a session study needs sessions or a session column
cpu.sessionVwap({});
// @ts-expect-error: not both
cpu.sessionVwap({ sessions: [], session: 'session' });
// @ts-expect-error: a LiveSeries emits no buckets
live.on('bucket', () => {});
// @ts-expect-error: pushJson reads UTC only
live.pushJson([], { timeZone: 'Europe/Madrid' });
// @ts-expect-error: smooth has no 'kalman' method
cpu.smooth('value', 'kalman');
