import {
  type AggregateMap,
  type SeriesSchema,
  BoundedSequence,
  type CalendarOptions,
  type CalendarUnit,
  Interval,
  type JsonObjectRowForSchema,
  type JsonRowForSchema,
  type JsonTimeRangeInput,
  type JsonTimestampInput,
  type JsonValueForKind,
  type NumericColumnNameForSchema,
  type RollingAlignment,
  type RollingSchema,
  type SmoothMethod,
  type SmoothAppendSchema,
  type SmoothSchema,
  Sequence,
  Time,
  TimeRange,
  TimeSeries,
  type TimeZoneOptions,
  type AggregateSchema,
  type AlignSchema,
  type EventForSchema,
  type IntervalKeyedSchema,
  type JoinConflictMode,
  type JoinManySchema,
  type JoinSchema,
  type JoinType,
  type PrefixedJoinManySchema,
  type PrefixedJoinSchema,
  type RowForSchema,
  type TimeRangeKeyedSchema,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'label', kind: 'string' },
] as const;

type Row = RowForSchema<typeof schema>;
const validRow: Row = [Date.now(), 42, 'ok'];
void validRow;
const calendarOptions: CalendarOptions = { timeZone: 'UTC', weekStartsOn: 1 };
const timeZoneOptions: TimeZoneOptions = { timeZone: 'Europe/Madrid' };
const calendarUnitDay: CalendarUnit = 'day';
const calendarUnitWeek: CalendarUnit = 'week';
const calendarUnitMonth: CalendarUnit = 'month';
const rollingAlignmentTrailing: RollingAlignment = 'trailing';
const rollingAlignmentLeading: RollingAlignment = 'leading';
const rollingAlignmentCentered: RollingAlignment = 'centered';
const smoothMethodEma: SmoothMethod = 'ema';
const smoothMethodMovingAverage: SmoothMethod = 'movingAverage';
const smoothMethodLoess: SmoothMethod = 'loess';
void calendarOptions;
void timeZoneOptions;
void calendarUnitDay;
void calendarUnitWeek;
void calendarUnitMonth;
void rollingAlignmentTrailing;
void rollingAlignmentLeading;
void rollingAlignmentCentered;
void smoothMethodEma;
void smoothMethodMovingAverage;
void smoothMethodLoess;

new TimeSeries({
  name: 'valid',
  schema,
  rows: [
    [new Date(), 1, 'x'],
    [new Time(Date.now()), 2, 'y'],
  ],
});

const jsonTimestamp: JsonTimestampInput = '2025-01-01T09:00';
const jsonTimeRange: JsonTimeRangeInput = {
  start: '2025-01-01',
  end: '2025-01-02',
};
const jsonValueTime: JsonValueForKind<'time'> = '2025-01-01T09:00';
const jsonRow: JsonRowForSchema<typeof schema> = ['2025-01-01T09:00', 1, 'ok'];
const jsonObjectRow: JsonObjectRowForSchema<typeof schema> = {
  time: '2025-01-01T09:00',
  value: 1,
  label: 'ok',
};
void jsonTimestamp;
void jsonTimeRange;
void jsonValueTime;
void jsonRow;
void jsonObjectRow;

const jsonSeries = TimeSeries.fromJSON({
  name: 'json',
  schema,
  rows: [jsonRow, jsonObjectRow],
  parse: { timeZone: 'UTC' },
});
const jsonSeriesEvent = jsonSeries.first();
if (!jsonSeriesEvent) {
  throw new Error('missing json event');
}
const jsonSeriesValue: number = jsonSeriesEvent.get('value');
const jsonSeriesLabel: string = jsonSeriesEvent.get('label');
void jsonSeriesValue;
void jsonSeriesLabel;

const parsedTime = Time.parse('2025-01-01T09:00', {
  timeZone: 'Europe/Madrid',
});
const parsedDayRange = TimeRange.fromDate('2025-01-01', { timeZone: 'UTC' });
const parsedWeekRange = TimeRange.fromCalendar('week', '2025-01-01', {
  timeZone: 'UTC',
  weekStartsOn: 1,
});
const parsedMonthInterval = Interval.fromCalendar('month', '2025-01', {
  timeZone: 'UTC',
  value: 'jan-2025',
});
void parsedTime;
void parsedDayRange;
void parsedWeekRange;
void parsedMonthInterval;

const rangeSchema = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'value', kind: 'number' },
] as const;

new TimeSeries({
  name: 'range',
  schema: rangeSchema,
  rows: [[new TimeRange({ start: new Date(), end: Date.now() }), 1]],
});

const indexSchema = [
  { name: 'interval', kind: 'interval' },
  { name: 'value', kind: 'number' },
] as const;

new TimeSeries({
  name: 'interval',
  schema: indexSchema,
  rows: [[new Interval({ value: 'a', start: 0, end: 1 }), 1]],
});

const cpuSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
  { name: 'healthy', kind: 'boolean' },
] as const;
type CpuNumericColumn = NumericColumnNameForSchema<typeof cpuSchema>;
const cpuNumericColumn: CpuNumericColumn = 'cpu';
void cpuNumericColumn;

const cpuSeries = new TimeSeries({
  name: 'cpu-usage',
  schema: cpuSchema,
  rows: [
    [new Date('2025-01-01T00:00:00.000Z'), 0.42, 'api-1', true],
    [new Date('2025-01-01T00:01:00.000Z'), 0.51, 'api-2', true],
  ],
});

const nth = cpuSeries.at(1);
if (!nth) {
  throw new Error('missing event');
}

const first = cpuSeries.first();
const last = cpuSeries.last();
if (!first || !last) {
  throw new Error('missing boundary events');
}

const typedNth: EventForSchema<typeof cpuSchema> = nth;
void typedNth;
const typedFirst: EventForSchema<typeof cpuSchema> = first;
const typedLast: EventForSchema<typeof cpuSchema> = last;
void typedFirst;
void typedLast;

const cpuValue: number = nth.data().cpu;
const hostValue: string = nth.data().host;
const healthyValue: boolean = nth.data().healthy;
const cpuValueFromGet: number = nth.get('cpu');
const hostValueFromGet: string = nth.get('host');
const keyTime: Time = nth.key();
const eventRange: TimeRange = nth.timeRange();
const eventType: 'time' = nth.type();
const eventOverlaps: boolean = nth.overlaps(
  new TimeRange({ start: 1735689599000, end: 1735689601000 }),
);
const eventContains: boolean = nth.contains(new Time(1735689600000));
const eventBefore: boolean = nth.isBefore(new Time(1735689700000));
const eventAfter: boolean = nth.isAfter(new Time(1735689500000));
const eventIntersection: TimeRange | undefined = nth.intersection(
  new TimeRange({ start: 1735689599000, end: 1735689601000 }),
);
const eventTrimmed = nth.trim(
  new TimeRange({ start: 1735689599000, end: 1735689601000 }),
);
const asTimeCenter = nth.asTime({ at: 'center' });
const asTimeRangeEvent = nth.asTimeRange();
const asIntervalEvent = nth.asInterval('cpu');
const updatedNth = nth.set('cpu', 0.75);
const updatedCpuValue: number = updatedNth.get('cpu');
const mergedNth = nth.merge({ source: 'derived', healthy: false });
const mergedSource: string = mergedNth.get('source');
const mergedHealthy: boolean = mergedNth.get('healthy');
const renamedNth = nth.rename({ cpu: 'usage', host: 'server' });
const renamedUsage: number = renamedNth.get('usage');
const renamedServer: string = renamedNth.get('server');
const selectedNth = nth.select('cpu', 'healthy');
const selectedCpuValue: number = selectedNth.get('cpu');
const selectedHealthyValue: boolean = selectedNth.get('healthy');
const collapsedEvent = nth.collapse(
  ['cpu', 'healthy'],
  'score',
  ({ cpu, healthy }) => {
    return healthy ? cpu : 0;
  },
);
const collapsedScore: number = collapsedEvent.get('score');
const asTimeCenterKey: Time = asTimeCenter.key();
const asTimeRangeKey: TimeRange = asTimeRangeEvent.key();
const asIntervalKey: Interval = asIntervalEvent.key();
void cpuValue;
void hostValue;
void healthyValue;
void cpuValueFromGet;
void hostValueFromGet;
void keyTime;
void eventRange;
void eventType;
void eventOverlaps;
void eventContains;
void eventBefore;
void eventAfter;
void eventIntersection;
void eventTrimmed;
void asTimeCenter;
void asTimeRangeEvent;
void asIntervalEvent;
void updatedNth;
void updatedCpuValue;
void mergedNth;
void mergedSource;
void mergedHealthy;
void renamedNth;
void renamedUsage;
void renamedServer;
void selectedNth;
void selectedCpuValue;
void selectedHealthyValue;
void collapsedEvent;
void collapsedScore;
void asTimeCenterKey;
void asTimeRangeKey;
void asIntervalKey;

// @ts-expect-error cpu is number
const badCpuText: string = nth.data().cpu;
void badCpuText;

// @ts-expect-error host is string
const badHostFlag: boolean = nth.data().host;
void badHostFlag;

// @ts-expect-error cpu is number
const badCpuFromGet: string = nth.get('cpu');
void badCpuFromGet;

// @ts-expect-error cpu only accepts numbers
const badUpdatedNth = nth.set('cpu', 'high');
void badUpdatedNth;

// @ts-expect-error selected event no longer has host
const badSelectedHost = selectedNth.get('host');
void badSelectedHost;

// @ts-expect-error renamed event no longer has cpu
const badRenamedCpu = renamedNth.get('cpu');
void badRenamedCpu;

const trafficSchema = [
  { name: 'time', kind: 'time' },
  { name: 'in', kind: 'number' },
  { name: 'out', kind: 'number' },
] as const;

const trafficSeries = new TimeSeries({
  name: 'traffic',
  schema: trafficSchema,
  rows: [[new Date('2025-01-01T00:00:00.000Z'), 10, 20]],
});

const collapsedSeries = trafficSeries.collapse(
  ['in', 'out'],
  'avg',
  ({ in: inValue, out }) => {
    return (inValue + out) / 2;
  },
);
const collapsedSeriesEvent = collapsedSeries.at(0);
if (!collapsedSeriesEvent) {
  throw new Error('missing collapsed event');
}
const collapsedAvg: number = collapsedSeriesEvent.get('avg');
void collapsedAvg;

const selectedSeries = cpuSeries.select('host', 'healthy');
const selectedSeriesEvent = selectedSeries.at(0);
if (!selectedSeriesEvent) {
  throw new Error('missing selected event');
}
const selectedSeriesHost: string = selectedSeriesEvent.get('host');
const selectedSeriesHealthy: boolean = selectedSeriesEvent.get('healthy');
void selectedSeriesHost;
void selectedSeriesHealthy;

const filteredSeries = cpuSeries.filter((event) => event.get('healthy'));
const filteredEvent = filteredSeries.first();
if (!filteredEvent) {
  throw new Error('missing filtered event');
}
const filteredCpu: number = filteredEvent.get('cpu');
const filteredHost: string = filteredEvent.get('host');
void filteredCpu;
void filteredHost;

const foundCpuEvent = cpuSeries.find((event) => event.get('cpu') > 0.5);
if (!foundCpuEvent) {
  throw new Error('missing found event');
}
const foundCpuValue: number = foundCpuEvent.get('cpu');
const foundHostValue: string = foundCpuEvent.get('host');
const hasHealthyCpu: boolean = cpuSeries.some((event) => event.get('healthy'));
const allHealthyCpu: boolean = cpuSeries.every((event) => event.get('healthy'));
void foundCpuValue;
void foundHostValue;
void hasHealthyCpu;
void allHealthyCpu;

const slicedSeries = cpuSeries.slice(0, 1);
const slicedEvent = slicedSeries.last();
if (!slicedEvent) {
  throw new Error('missing sliced event');
}
const slicedHealthy: boolean = slicedEvent.get('healthy');
void slicedHealthy;

const withinSeries = cpuSeries.within(
  new Date('2025-01-01T00:00:00.000Z'),
  new Date('2025-01-01T00:01:00.000Z'),
);
const withinEvent = withinSeries.first();
if (!withinEvent) {
  throw new Error('missing within event');
}
const withinCpu: number = withinEvent.get('cpu');
void withinCpu;

const beforeSeries = cpuSeries.before(new Date('2025-01-01T00:01:00.000Z'));
const afterSeries = cpuSeries.after(new Time(1735689600000));
const cpuSeriesRange: TimeRange | undefined = cpuSeries.timeRange();
const cpuSeriesOverlaps: boolean = cpuSeries.overlaps(
  new TimeRange({ start: 1735689600000, end: 1735689700000 }),
);
const cpuSeriesContains: boolean = cpuSeries.contains(
  new TimeRange({ start: 1735689600000, end: 1735689660000 }),
);
const cpuSeriesIntersection: TimeRange | undefined = cpuSeries.intersection(
  new TimeRange({ start: 1735689600000, end: 1735689630000 }),
);
const overlappingCpuSeries = cpuSeries.overlapping(
  new TimeRange({ start: 1735689599000, end: 1735689601000 }),
);
const containedCpuSeries = cpuSeries.containedBy(
  new TimeRange({ start: 1735689599000, end: 1735689661000 }),
);
const trimmedCpuSeries = cpuSeries.trim(
  new TimeRange({ start: 1735689599000, end: 1735689601000 }),
);
const alignedCpuSeries = cpuSeries.align(Sequence.every('1m'), {
  method: 'hold',
  range: new TimeRange({ start: 1735689600000, end: 1735689660000 }),
});
const cpuSeriesAsTimeRange = cpuSeries.asTimeRange();
const cpuSeriesAsInterval = cpuSeries.asInterval((event) => event.begin());
const boundedMinuteSequence = new BoundedSequence([
  new Interval({
    value: 1735689600000,
    start: 1735689600000,
    end: 1735689660000,
  }),
]);
const defaultCalendarDaySequence = Sequence.calendar('day');
const calendarDaySequence = Sequence.calendar('day', { timeZone: 'UTC' });
const calendarDayBounded = calendarDaySequence.bounded(
  new TimeRange({ start: 1735689600000, end: 1735776000000 }),
);
const alignedCpuSeriesFromBounded = cpuSeries.align(boundedMinuteSequence, {
  method: 'hold',
});
void beforeSeries;
void afterSeries;
void cpuSeriesRange;
void cpuSeriesOverlaps;
void cpuSeriesContains;
void cpuSeriesIntersection;
void overlappingCpuSeries;
void containedCpuSeries;
void trimmedCpuSeries;
void alignedCpuSeries;
void cpuSeriesAsTimeRange;
void cpuSeriesAsInterval;
void alignedCpuSeriesFromBounded;
void defaultCalendarDaySequence;
void calendarDayBounded;

type AlignedCpuSchema = AlignSchema<typeof cpuSchema>;
type CpuAsTimeRangeSchema = TimeRangeKeyedSchema<typeof cpuSchema>;
type CpuAsIntervalSchema = IntervalKeyedSchema<typeof cpuSchema>;
const alignedCpuEvent = alignedCpuSeries.first();
const cpuSeriesAsTimeRangeEvent = cpuSeriesAsTimeRange.first();
const cpuSeriesAsIntervalEvent = cpuSeriesAsInterval.first();
if (!alignedCpuEvent) {
  throw new Error('missing aligned event');
}
if (!cpuSeriesAsTimeRangeEvent || !cpuSeriesAsIntervalEvent) {
  throw new Error('missing rekeyed event');
}
const alignedCpuKey: Interval = alignedCpuEvent.key();
const cpuSeriesAsTimeRangeKey: TimeRange = cpuSeriesAsTimeRangeEvent.key();
const cpuSeriesAsIntervalKey: Interval = cpuSeriesAsIntervalEvent.key();
const alignedCpuValue: number | undefined = alignedCpuEvent.get('cpu');
const cpuSeriesAsTimeRangeCpu: number = cpuSeriesAsTimeRangeEvent.get('cpu');
const cpuSeriesAsIntervalCpu: number = cpuSeriesAsIntervalEvent.get('cpu');
const alignedCpuHost: string | undefined = alignedCpuEvent.get('host');
const alignedCpuHealthy: boolean | undefined = alignedCpuEvent.get('healthy');
const alignedTypedSchemaEvent: EventForSchema<AlignedCpuSchema> =
  alignedCpuEvent;
const cpuSeriesAsTimeRangeTypedEvent: EventForSchema<CpuAsTimeRangeSchema> =
  cpuSeriesAsTimeRangeEvent;
const cpuSeriesAsIntervalTypedEvent: EventForSchema<CpuAsIntervalSchema> =
  cpuSeriesAsIntervalEvent;
void alignedCpuKey;
void cpuSeriesAsTimeRangeKey;
void cpuSeriesAsIntervalKey;
void alignedCpuValue;
void cpuSeriesAsTimeRangeCpu;
void cpuSeriesAsIntervalCpu;
void alignedCpuHost;
void alignedCpuHealthy;
void alignedTypedSchemaEvent;
void cpuSeriesAsTimeRangeTypedEvent;
void cpuSeriesAsIntervalTypedEvent;

const aggregatedCpuSeries = cpuSeries.aggregate(
  Sequence.every('1m'),
  { cpu: 'avg', host: 'first', healthy: 'last' },
  { range: new TimeRange({ start: 1735689600000, end: 1735689660000 }) },
);
type AggregatedCpuSchema = AggregateSchema<
  typeof cpuSchema,
  {
    readonly cpu: 'avg';
    readonly host: 'first';
    readonly healthy: 'last';
  }
>;
const aggregatedCpuEvent = aggregatedCpuSeries.first();
if (!aggregatedCpuEvent) {
  throw new Error('missing aggregated event');
}
const aggregatedCpuKey: Interval = aggregatedCpuEvent.key();
const aggregatedCpuValue: number | undefined = aggregatedCpuEvent.get('cpu');
const aggregatedCpuHost: string | undefined = aggregatedCpuEvent.get('host');
const aggregatedCpuHealthy: boolean | undefined =
  aggregatedCpuEvent.get('healthy');
const aggregatedTypedSchemaEvent: EventForSchema<AggregatedCpuSchema> =
  aggregatedCpuEvent;
void aggregatedCpuKey;
void aggregatedCpuValue;
void aggregatedCpuHost;
void aggregatedCpuHealthy;
void aggregatedTypedSchemaEvent;

const customAggregatedCpuSeries = cpuSeries.aggregate(
  Sequence.every('1m'),
  {
    cpu: (values) =>
      values.reduce<number>(
        (sum, value) => sum + (typeof value === 'number' ? value : 0),
        0,
      ),
    host: (values) =>
      values.find((value): value is string => typeof value === 'string'),
  },
  { range: new TimeRange({ start: 1735689600000, end: 1735689660000 }) },
);
const customAggregatedCpuEvent = customAggregatedCpuSeries.first();
if (!customAggregatedCpuEvent) {
  throw new Error('missing custom aggregated event');
}
const customAggregatedCpuValue: number | undefined =
  customAggregatedCpuEvent.get('cpu');
const customAggregatedCpuHost: string | undefined =
  customAggregatedCpuEvent.get('host');
void customAggregatedCpuValue;
void customAggregatedCpuHost;

const renamedAggregatedCpuSeries = cpuSeries.aggregate(
  Sequence.every('1m'),
  {
    cpu_avg: { from: 'cpu', using: 'avg' },
    host_last: { from: 'host', using: 'last' },
  },
  { range: new TimeRange({ start: 1735689600000, end: 1735689660000 }) },
);
const renamedAggregatedCpuEvent = renamedAggregatedCpuSeries.first();
if (!renamedAggregatedCpuEvent) {
  throw new Error('missing renamed aggregated event');
}
// Renamed-output (`{ from, using }`) specs narrow per output key: the
// `avg` spec emits `number`, the `last` spec emits the source string
// column's `string`. (Before v0.23.0 / audit v2 §5 F1 these erased to
// the wide `ColumnValue` union; the unified result schema now narrows
// them — see the assertions further down on `mixed*` and the all-spec
// block below.) The values stay assignable to the wide union too.
const renamedAggregatedCpuAvg: number | undefined =
  renamedAggregatedCpuEvent.get('cpu_avg');
const renamedAggregatedHostLast: string | undefined =
  renamedAggregatedCpuEvent.get('host_last');
void renamedAggregatedCpuAvg;
void renamedAggregatedHostLast;

const rolledCpuSeries = cpuSeries.rolling('1m', {
  cpu: 'avg',
  host: 'last',
  healthy: 'last',
});
type RolledCpuSchema = RollingSchema<
  typeof cpuSchema,
  {
    readonly cpu: 'avg';
    readonly host: 'last';
    readonly healthy: 'last';
  }
>;
const rolledCpuEvent = rolledCpuSeries.first();
if (!rolledCpuEvent) {
  throw new Error('missing rolled event');
}
const rolledCpuKey: Time = rolledCpuEvent.key();
const rolledCpuValue: number | undefined = rolledCpuEvent.get('cpu');
const rolledCpuHost: string | undefined = rolledCpuEvent.get('host');
const rolledCpuHealthy: boolean | undefined = rolledCpuEvent.get('healthy');
const rolledCpuTypedEvent: EventForSchema<RolledCpuSchema> = rolledCpuEvent;
void rolledCpuKey;
void rolledCpuValue;
void rolledCpuHost;
void rolledCpuHealthy;
void rolledCpuTypedEvent;

const customRolledCpuSeries = cpuSeries.rolling('1m', {
  cpu: (values) => values.filter((value) => typeof value === 'number').length,
  host: (values) =>
    values
      .slice()
      .reverse()
      .find((value): value is string => typeof value === 'string'),
  healthy: (values) =>
    values.some((value): boolean => typeof value === 'boolean'),
});
const customRolledCpuEvent = customRolledCpuSeries.first();
if (!customRolledCpuEvent) {
  throw new Error('missing custom rolled event');
}
const customRolledCpuValue: number | undefined =
  customRolledCpuEvent.get('cpu');
const customRolledCpuHost: string | undefined =
  customRolledCpuEvent.get('host');
const customRolledCpuHealthy: boolean | undefined =
  customRolledCpuEvent.get('healthy');
void customRolledCpuValue;
void customRolledCpuHost;
void customRolledCpuHealthy;

const rolledCpuOnSequence = cpuSeries.rolling(
  Sequence.every('1m'),
  '5m',
  { cpu: 'avg', host: 'last', healthy: 'last' },
  { range: new TimeRange({ start: 1735689600000, end: 1735689660000 }) },
);
type RolledCpuSequenceSchema = AggregateSchema<
  typeof cpuSchema,
  {
    readonly cpu: 'avg';
    readonly host: 'last';
    readonly healthy: 'last';
  }
>;
const rolledCpuOnSequenceEvent = rolledCpuOnSequence.first();
if (!rolledCpuOnSequenceEvent) {
  throw new Error('missing rolled sequence event');
}
const rolledCpuOnSequenceKey: Interval = rolledCpuOnSequenceEvent.key();
const rolledCpuOnSequenceValue: number | undefined =
  rolledCpuOnSequenceEvent.get('cpu');
const rolledCpuOnSequenceHost: string | undefined =
  rolledCpuOnSequenceEvent.get('host');
const rolledCpuOnSequenceHealthy: boolean | undefined =
  rolledCpuOnSequenceEvent.get('healthy');
const rolledCpuOnSequenceTypedEvent: EventForSchema<RolledCpuSequenceSchema> =
  rolledCpuOnSequenceEvent;
void rolledCpuOnSequenceKey;
void rolledCpuOnSequenceValue;
void rolledCpuOnSequenceHost;
void rolledCpuOnSequenceHealthy;
void rolledCpuOnSequenceTypedEvent;

// `rolling` with `AggregateOutputMap` (multi-reducer-per-column).
// v0.5.4 landed the runtime parity; v0.5.5 threads per-spec narrowing
// through so callers don't have to `as`-cast.
const rolledMultiCpu = cpuSeries.rolling('1m', {
  cpuAvg: { from: 'cpu', using: 'avg' },
  cpuSd: { from: 'cpu', using: 'stdev' },
  hosts: { from: 'host', using: 'unique' },
  lastHost: { from: 'host', using: 'last' },
});
const rolledMultiCpuEvent = rolledMultiCpu.first();
if (!rolledMultiCpuEvent) {
  throw new Error('missing rolled multi event');
}

// Payload values narrow per-spec:
// - 'avg' / 'stdev'   -> number | undefined
// - 'unique' on string -> ReadonlyArray<ScalarValue> | undefined
//   (the output schema tracks kind='array'; element-level narrowing
//    to ReadonlyArray<string> requires bypassing NormalizedValueForKind
//    and is only available today on `reduce(...)`'s ReduceResult — see
//    v0.5.3. For rolling's output-map path, the ArrayValue union is the
//    best we can do without a bigger schema-layer change.)
// - 'last' on string   -> string | undefined
const rolledMultiCpuAvg: number | undefined = rolledMultiCpuEvent.get('cpuAvg');
const rolledMultiCpuSd: number | undefined = rolledMultiCpuEvent.get('cpuSd');
const rolledMultiHosts: ReadonlyArray<string | number | boolean> | undefined =
  rolledMultiCpuEvent.get('hosts');
const rolledMultiLastHost: string | undefined =
  rolledMultiCpuEvent.get('lastHost');
void rolledMultiCpuAvg;
void rolledMultiCpuSd;
void rolledMultiHosts;
void rolledMultiLastHost;

// First-column kind preserved: Time key for a Time-keyed source.
const rolledMultiKey: Time = rolledMultiCpuEvent.key();
void rolledMultiKey;

// Same narrowing via the sequence-driven overload; first column is
// `Interval` (sequence output).
const rolledMultiCpuOnSequence = cpuSeries.rolling(
  Sequence.every('1m'),
  '5m',
  {
    cpuAvg: { from: 'cpu', using: 'avg' },
    cpuMax: { from: 'cpu', using: 'max' },
  },
  { range: new TimeRange({ start: 1735689600000, end: 1735689660000 }) },
);
const rolledMultiSeqEvent = rolledMultiCpuOnSequence.first();
if (!rolledMultiSeqEvent) {
  throw new Error('missing rolled multi sequence event');
}
const rolledMultiSeqKey: Interval = rolledMultiSeqEvent.key();
const rolledMultiSeqAvg: number | undefined = rolledMultiSeqEvent.get('cpuAvg');
const rolledMultiSeqMax: number | undefined = rolledMultiSeqEvent.get('cpuMax');
void rolledMultiSeqKey;
void rolledMultiSeqAvg;
void rolledMultiSeqMax;

// `aggregate` with `AggregateOutputMap` narrows the same way (parity
// fix landed in v0.5.5 alongside the rolling fix).
const aggregatedOutputMap = cpuSeries.aggregate(Sequence.every('1m'), {
  cpu_avg: { from: 'cpu', using: 'avg' },
  host_last: { from: 'host', using: 'last' },
});
const aggregatedOutputEvent = aggregatedOutputMap.first();
if (!aggregatedOutputEvent) {
  throw new Error('missing aggregated output-map event');
}
const aggregatedOutputAvg: number | undefined =
  aggregatedOutputEvent.get('cpu_avg');
const aggregatedOutputLast: string | undefined =
  aggregatedOutputEvent.get('host_last');
void aggregatedOutputAvg;
void aggregatedOutputLast;

// ---------------------------------------------------------------------------
// F1 (audit v2 §5): MIXED shorthand + `{ from, using }` specs in ONE call.
//
// This is the docs-blessed pattern. Before v0.23.0 a mixed literal
// silently resolved to the shorthand overload, which iterated SOURCE
// columns and kept only output keys whose name was a source-column name.
// Every spec-keyed output column (`cpu_p95`, `host_first`) was dropped
// from the result type while the runtime still emitted it — so
// `mixed.at(0)?.get('cpu_p95')` failed to compile. The unify (one
// overload over a unified map + a per-output-key result schema) keeps
// every column. Each block below asserts:
//   - the shorthand key narrows to its reducer's kind,
//   - each spec key narrows to its reducer's output kind,
//   - a string-source `first` spec narrows to `string | undefined`,
// and uses `satisfies` to pin EXACT narrowing (catches silent widening).

// `aggregate` (sequence-keyed → Interval first column).
const mixedAggregate = cpuSeries.aggregate(Sequence.every('1m'), {
  cpu: 'avg', // shorthand → number
  cpu_p95: { from: 'cpu', using: 'p95' }, // spec, numeric reducer → number
  host_first: { from: 'host', using: 'first' }, // spec, string source → string
  hosts: { from: 'host', using: 'unique' }, // spec, array reducer → array
});
const mixedAggregateEvent = mixedAggregate.first();
if (!mixedAggregateEvent) {
  throw new Error('missing mixed aggregate event');
}
const mixedAggKey: Interval = mixedAggregateEvent.key();
const mixedAggCpu = mixedAggregateEvent.get('cpu') satisfies number | undefined;
const mixedAggP95 = mixedAggregateEvent.get('cpu_p95') satisfies
  | number
  | undefined;
const mixedAggHostFirst = mixedAggregateEvent.get('host_first') satisfies
  | string
  | undefined;
const mixedAggHosts = mixedAggregateEvent.get('hosts') satisfies
  | ReadonlyArray<string | number | boolean>
  | undefined;
// Exact-narrowing: each cell must be assignable BOTH ways. A widening
// regression (e.g. `cpu_p95` back to `ColumnValue`) breaks these.
const mixedAggCpuExact: number | undefined = mixedAggCpu;
const mixedAggP95Exact: number | undefined = mixedAggP95;
const mixedAggHostFirstExact: string | undefined = mixedAggHostFirst;
void mixedAggKey;
void mixedAggCpuExact;
void mixedAggP95Exact;
void mixedAggHostFirstExact;
void mixedAggHosts;

// `rolling` (event-driven → Time first column preserved).
const mixedRolling = cpuSeries.rolling('1m', {
  cpu: 'avg', // shorthand → number
  cpu_max: { from: 'cpu', using: 'max' }, // spec → number
  host_last: { from: 'host', using: 'last' }, // spec, string source → string
  healthy: 'last', // shorthand, boolean source → boolean
});
const mixedRollingEvent = mixedRolling.first();
if (!mixedRollingEvent) {
  throw new Error('missing mixed rolling event');
}
const mixedRollKey: Time = mixedRollingEvent.key();
const mixedRollCpu: number | undefined = mixedRollingEvent.get('cpu');
const mixedRollMax: number | undefined = mixedRollingEvent.get('cpu_max');
const mixedRollHostLast: string | undefined =
  mixedRollingEvent.get('host_last');
const mixedRollHealthy: boolean | undefined = mixedRollingEvent.get('healthy');
void mixedRollKey;
void mixedRollCpu;
void mixedRollMax;
void mixedRollHostLast;
void mixedRollHealthy;

// `rolling` (sequence-driven → Interval first column).
const mixedRollingSeq = cpuSeries.rolling(
  Sequence.every('1m'),
  '5m',
  {
    cpu: 'avg', // shorthand → number
    cpu_sd: { from: 'cpu', using: 'stdev' }, // spec → number
    host_first: { from: 'host', using: 'first' }, // spec, string source → string
  },
  { range: new TimeRange({ start: 1735689600000, end: 1735689660000 }) },
);
const mixedRollingSeqEvent = mixedRollingSeq.first();
if (!mixedRollingSeqEvent) {
  throw new Error('missing mixed rolling sequence event');
}
const mixedRollSeqKey: Interval = mixedRollingSeqEvent.key();
const mixedRollSeqCpu: number | undefined = mixedRollingSeqEvent.get('cpu');
const mixedRollSeqSd: number | undefined = mixedRollingSeqEvent.get('cpu_sd');
const mixedRollSeqHostFirst: string | undefined =
  mixedRollingSeqEvent.get('host_first');
void mixedRollSeqKey;
void mixedRollSeqCpu;
void mixedRollSeqSd;
void mixedRollSeqHostFirst;

// `reduce` (record output, no first column).
const mixedReduce = cpuSeries.reduce({
  cpu: 'avg', // shorthand → number
  cpu_p99: { from: 'cpu', using: 'p99' }, // spec → number
  host_first: { from: 'host', using: 'first' }, // spec, string source → string
  hosts: { from: 'host', using: 'unique' }, // spec, array reducer → ReadonlyArray<string>
});
const mixedReduceCpu = mixedReduce.cpu satisfies number | undefined;
const mixedReduceP99 = mixedReduce.cpu_p99 satisfies number | undefined;
const mixedReduceHostFirst = mixedReduce.host_first satisfies
  | string
  | undefined;
// `unique` on a string column narrows to ReadonlyArray<string> in reduce
// (ReduceResult tracks element kind from the spec's `from`).
const mixedReduceHosts = mixedReduce.hosts satisfies
  | ReadonlyArray<string>
  | undefined;
const mixedReduceCpuExact: number | undefined = mixedReduceCpu;
const mixedReduceP99Exact: number | undefined = mixedReduceP99;
const mixedReduceHostFirstExact: string | undefined = mixedReduceHostFirst;
const mixedReduceHostsExact: ReadonlyArray<string> | undefined =
  mixedReduceHosts;
void mixedReduceCpuExact;
void mixedReduceP99Exact;
void mixedReduceHostFirstExact;
void mixedReduceHostsExact;

// Spec entries in `reduce` also respect an explicit `kind` override and
// keep the custom-reducer fallback wide.
const mixedReduceExplicit = cpuSeries.reduce({
  cpu_str: { from: 'cpu', using: 'first', kind: 'string' }, // explicit kind wins
  cpu_custom: { from: 'cpu', using: (values) => values.length }, // custom fn → wide
});
const mixedReduceExplicitStr: string | undefined = mixedReduceExplicit.cpu_str;
const mixedReduceCustomWide:
  | string
  | number
  | boolean
  | ReadonlyArray<string | number | boolean>
  | undefined = mixedReduceExplicit.cpu_custom;
void mixedReduceExplicitStr;
void mixedReduceCustomWide;

// ---------------------------------------------------------------------------
// Guard preservation (F1 follow-through): unifying the mapping shapes
// must NOT lose the shorthand compile-time guards the pre-unification
// overloads had. ValidatedAggregateMap validates inline literals per
// key at every public aggregate/rolling/reduce signature.

// (1) Wrong-kind shorthand: 'avg' is not a valid reducer for the
// string column `host` (runtime would emit an always-empty column).
// @ts-expect-error — shorthand reducer kind-checked against its source column
cpuSeries.aggregate(Sequence.every('1m'), { host: 'avg' });
// @ts-expect-error — same guard on event-driven rolling
cpuSeries.rolling('1m', { host: 'avg' });
// @ts-expect-error — same guard on reduce
cpuSeries.reduce({ host: 'avg' });

// (2) Shorthand typo: `ghost` is not a source column, so a bare
// reducer is rejected (the runtime throws "unknown source column").
// @ts-expect-error — bare reducer on a non-source key
cpuSeries.aggregate(Sequence.every('1m'), { ghost: 'avg' });
// @ts-expect-error — bare reducer on a non-source key (rolling)
cpuSeries.rolling('1m', { ghost: 'avg' });
// @ts-expect-error — bare reducer on a non-source key (reduce)
cpuSeries.reduce({ ghost: 'avg' });

// Spec keys remain free output names — the same key with a spec is fine
// and narrows by its reducer.
const ghostSpecOk = cpuSeries.reduce({ ghost: { from: 'cpu', using: 'avg' } });
const ghostSpecVal: number | undefined = ghostSpecOk.ghost;
void ghostSpecVal;

// (3) The guards hold inside MIXED mappings — one bad entry fails the
// whole call.
// @ts-expect-error — wrong-kind shorthand inside an otherwise-valid mixed mapping
cpuSeries.reduce({ cpu: 'avg', host: 'avg' });

// (4) Kind-appropriate shorthand on every kind still accepted.
const kindOkShorthand = cpuSeries.reduce({
  cpu: 'p99',
  host: 'first',
  healthy: 'last',
});
const kindOkHost: string | undefined = kindOkShorthand.host;
const kindOkHealthy: boolean | undefined = kindOkShorthand.healthy;
void kindOkHost;
void kindOkHealthy;

// (5) Deliberate escape hatches, pinned so a future tightening is a
// conscious decision: a value pre-widened to AggregateMap<S> has
// index-signature keys (no literals to validate)…
const widenedMapping: AggregateMap<typeof cpuSchema> = { host: 'avg' };
const widenedResult = cpuSeries.aggregate(Sequence.every('1m'), widenedMapping);
void widenedResult;
// …and broad-schema receivers have no column names to validate against.
const broadGuardSeries = cpuSeries as unknown as TimeSeries<SeriesSchema>;
const broadGuardResult = broadGuardSeries.reduce({ anything: 'avg' });
void broadGuardResult;

const smoothedCpuSeries = cpuSeries.smooth('cpu', 'ema', { alpha: 0.5 });
type SmoothedCpuSchema = SmoothSchema<typeof cpuSchema, 'cpu'>;
const smoothedCpuEvent = smoothedCpuSeries.first();
if (!smoothedCpuEvent) {
  throw new Error('missing smoothed cpu event');
}
const smoothedCpuKey: Time = smoothedCpuEvent.key();
const smoothedCpuValue: number | undefined = smoothedCpuEvent.get('cpu');
const smoothedCpuHost: string = smoothedCpuEvent.get('host');
const smoothedCpuHealthy: boolean = smoothedCpuEvent.get('healthy');
const smoothedCpuTypedEvent: EventForSchema<SmoothedCpuSchema> =
  smoothedCpuEvent;
void smoothedCpuKey;
void smoothedCpuValue;
void smoothedCpuHost;
void smoothedCpuHealthy;
void smoothedCpuTypedEvent;

const appendedSmoothedCpuSeries = cpuSeries.smooth('cpu', 'ema', {
  alpha: 0.5,
  output: 'cpuEma',
});
type AppendedSmoothedCpuSchema = SmoothAppendSchema<typeof cpuSchema, 'cpuEma'>;
const appendedSmoothedCpuEvent = appendedSmoothedCpuSeries.first();
if (!appendedSmoothedCpuEvent) {
  throw new Error('missing appended smoothed cpu event');
}
const appendedSmoothedCpuValue: number = appendedSmoothedCpuEvent.get('cpu');
const appendedSmoothedCpuOutput: number | undefined =
  appendedSmoothedCpuEvent.get('cpuEma');
const appendedSmoothedCpuHost: string = appendedSmoothedCpuEvent.get('host');
const appendedSmoothedCpuTypedEvent: EventForSchema<AppendedSmoothedCpuSchema> =
  appendedSmoothedCpuEvent;
void appendedSmoothedCpuValue;
void appendedSmoothedCpuOutput;
void appendedSmoothedCpuHost;
void appendedSmoothedCpuTypedEvent;

const loessSmoothedCpuSeries = cpuSeries.smooth('cpu', 'loess', {
  span: 0.75,
  output: 'cpuLoess',
});
type LoessSmoothedCpuSchema = SmoothAppendSchema<typeof cpuSchema, 'cpuLoess'>;
const loessSmoothedCpuEvent = loessSmoothedCpuSeries.first();
if (!loessSmoothedCpuEvent) {
  throw new Error('missing loess smoothed cpu event');
}
const loessSmoothedCpuValue: number = loessSmoothedCpuEvent.get('cpu');
const loessSmoothedCpuOutput: number | undefined =
  loessSmoothedCpuEvent.get('cpuLoess');
const loessSmoothedCpuTypedEvent: EventForSchema<LoessSmoothedCpuSchema> =
  loessSmoothedCpuEvent;
void loessSmoothedCpuValue;
void loessSmoothedCpuOutput;
void loessSmoothedCpuTypedEvent;

// @ts-expect-error host is not a numeric smoothing target
const badSmoothedHostSeries = cpuSeries.smooth('host', 'ema', { alpha: 0.5 });
void badSmoothedHostSeries;

const hostSchema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
] as const;

const hostSeries = new TimeSeries({
  name: 'hosts',
  schema: hostSchema,
  rows: [
    [new Date('2025-01-01T00:00:00.000Z'), 'api-1'],
    [new Date('2025-01-01T00:01:00.000Z'), 'api-2'],
  ],
});

const alignedHostSeries = hostSeries.align(Sequence.every('1m'), {
  method: 'hold',
  range: new TimeRange({ start: 1735689600000, end: 1735689660000 }),
});

const joinedAlignedSeries = alignedCpuSeries.join(alignedHostSeries);
const joinedLeftSeries = alignedCpuSeries.join(alignedHostSeries, {
  type: 'left',
});
const joinedInnerSeries = alignedCpuSeries.join(alignedHostSeries, {
  type: 'inner',
});
const prefixedJoinedAlignedSeries = alignedCpuSeries.join(alignedHostSeries, {
  onConflict: 'prefix',
  prefixes: ['cpu', 'host'] as const,
});
type JoinedAlignedSchema = JoinSchema<
  AlignSchema<typeof cpuSchema>,
  AlignSchema<typeof hostSchema>
>;
type PrefixedJoinedAlignedSchema = PrefixedJoinSchema<
  AlignSchema<typeof cpuSchema>,
  AlignSchema<typeof hostSchema>,
  readonly ['cpu', 'host']
>;
const joinedAlignedEvent = joinedAlignedSeries.first();
if (!joinedAlignedEvent) {
  throw new Error('missing joined aligned event');
}
const prefixedJoinedAlignedEvent = prefixedJoinedAlignedSeries.first();
if (!prefixedJoinedAlignedEvent) {
  throw new Error('missing prefixed joined aligned event');
}
const joinedAlignedKey: Interval = joinedAlignedEvent.key();
const joinedAlignedCpu: number | undefined = joinedAlignedEvent.get('cpu');
const joinedAlignedHost: string | undefined = joinedAlignedEvent.get('host');
const joinedAlignedHealthy: boolean | undefined =
  joinedAlignedEvent.get('healthy');
const joinedAlignedTypedEvent: EventForSchema<JoinedAlignedSchema> =
  joinedAlignedEvent;
void joinedAlignedKey;
void joinedAlignedCpu;
void joinedAlignedHost;
void joinedAlignedHealthy;
void joinedAlignedTypedEvent;
const prefixedJoinedAlignedCpu: number | undefined =
  prefixedJoinedAlignedEvent.get('cpu');
const prefixedJoinedAlignedHost: string | undefined =
  prefixedJoinedAlignedEvent.get('host_host');
const prefixedJoinedAlignedHealthy: boolean | undefined =
  prefixedJoinedAlignedEvent.get('healthy');
const prefixedJoinedAlignedTypedEvent: EventForSchema<PrefixedJoinedAlignedSchema> =
  prefixedJoinedAlignedEvent;
void prefixedJoinedAlignedCpu;
void prefixedJoinedAlignedHost;
void prefixedJoinedAlignedHealthy;
void prefixedJoinedAlignedTypedEvent;
const joinedLeftEvent = joinedLeftSeries.first();
const joinedInnerEvent = joinedInnerSeries.first();
void joinedLeftEvent;
void joinedInnerEvent;

const joinConflictError: JoinConflictMode = 'error';
const joinConflictPrefix: JoinConflictMode = 'prefix';
const joinTypeLeft: JoinType = 'left';
const joinTypeRight: JoinType = 'right';
const joinTypeInner: JoinType = 'inner';
const joinTypeOuter: JoinType = 'outer';
void joinConflictError;
void joinConflictPrefix;
void joinTypeLeft;
void joinTypeRight;
void joinTypeInner;
void joinTypeOuter;

const statusSchema = [
  { name: 'interval', kind: 'interval' },
  { name: 'status', kind: 'string' },
] as const;

const statusSeries = new TimeSeries({
  name: 'status',
  schema: statusSchema,
  rows: [
    [
      new Interval({
        value: 1735689600000,
        start: 1735689600000,
        end: 1735689660000,
      }),
      'ok',
    ],
  ],
});

const joinedManySeries = TimeSeries.joinMany([
  alignedCpuSeries,
  alignedHostSeries,
  statusSeries,
]);
const prefixedJoinedManySeries = TimeSeries.joinMany(
  [alignedCpuSeries, alignedHostSeries, statusSeries],
  {
    onConflict: 'prefix',
    prefixes: ['cpu', 'host', 'status'] as const,
  },
);
type JoinedManyAlignedSchema = JoinManySchema<
  readonly [
    AlignSchema<typeof cpuSchema>,
    AlignSchema<typeof hostSchema>,
    typeof statusSchema,
  ]
>;
type PrefixedJoinedManyAlignedSchema = PrefixedJoinManySchema<
  readonly [
    AlignSchema<typeof cpuSchema>,
    AlignSchema<typeof hostSchema>,
    typeof statusSchema,
  ],
  readonly ['cpu', 'host', 'status']
>;
const joinedManyEvent = joinedManySeries.first();
if (!joinedManyEvent) {
  throw new Error('missing joinMany event');
}
const prefixedJoinedManyEvent = prefixedJoinedManySeries.first();
if (!prefixedJoinedManyEvent) {
  throw new Error('missing prefixed joinMany event');
}
const joinedManyKey: Interval = joinedManyEvent.key();
const joinedManyCpu: number | undefined = joinedManyEvent.get('cpu');
const joinedManyHost: string | undefined = joinedManyEvent.get('host');
const joinedManyHealthy: boolean | undefined = joinedManyEvent.get('healthy');
const joinedManyStatus: string | undefined = joinedManyEvent.get('status');
const joinedManyTypedEvent: EventForSchema<JoinedManyAlignedSchema> =
  joinedManyEvent;
void joinedManyKey;
void joinedManyCpu;
void joinedManyHost;
void joinedManyHealthy;
void joinedManyStatus;
void joinedManyTypedEvent;
const prefixedJoinedManyCpu: number | undefined =
  prefixedJoinedManyEvent.get('cpu');
const prefixedJoinedManyHost: string | undefined =
  prefixedJoinedManyEvent.get('host_host');
const prefixedJoinedManyHealthy: boolean | undefined =
  prefixedJoinedManyEvent.get('healthy');
const prefixedJoinedManyStatus: string | undefined =
  prefixedJoinedManyEvent.get('status');
const prefixedJoinedManyTypedEvent: EventForSchema<PrefixedJoinedManyAlignedSchema> =
  prefixedJoinedManyEvent;
void prefixedJoinedManyCpu;
void prefixedJoinedManyHost;
void prefixedJoinedManyHealthy;
void prefixedJoinedManyStatus;
void prefixedJoinedManyTypedEvent;

// @ts-expect-error prefixed join renames duplicate host columns
const badPrefixedJoinedHost = prefixedJoinedAlignedEvent.get('host');
void badPrefixedJoinedHost;

const hasFirstCpuKey: boolean = cpuSeries.includesKey(new Time(1735689600000));
const cpuInsertIndex: number = cpuSeries.bisect(new Time(1735689630000));
const cpuAtOrBefore = cpuSeries.atOrBefore(new Time(1735689630000));
const cpuAtOrAfter = cpuSeries.atOrAfter(new Time(1735689630000));
void hasFirstCpuKey;
void cpuInsertIndex;
if (!cpuAtOrBefore || !cpuAtOrAfter) {
  throw new Error('missing bisected events');
}
const beforeCpuValue: number = cpuAtOrBefore.get('cpu');
const afterCpuHost: string = cpuAtOrAfter.get('host');
void beforeCpuValue;
void afterCpuHost;

const appendedSeries = trafficSeries.collapse(
  ['in', 'out'],
  'avg',
  ({ in: inValue, out }) => (inValue + out) / 2,
  { append: true },
);
const appendedEvent = appendedSeries.at(0);
if (!appendedEvent) {
  throw new Error('missing appended event');
}
const appendedIn: number = appendedEvent.get('in');
const appendedOut: number = appendedEvent.get('out');
const appendedAvg: number = appendedEvent.get('avg');
void appendedIn;
void appendedOut;
void appendedAvg;

const avgSchema = [
  { name: 'time', kind: 'time' },
  { name: 'avg', kind: 'number' },
] as const;

const mappedSeries = trafficSeries.map(avgSchema, (event) =>
  event.collapse(
    ['in', 'out'],
    'avg',
    ({ in: inValue, out }) => (inValue + out) / 2,
  ),
);
const mappedEvent = mappedSeries.at(0);
if (!mappedEvent) {
  throw new Error('missing mapped event');
}
const mappedAvg: number = mappedEvent.get('avg');
void mappedAvg;

const enrichedCpuSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
  { name: 'healthy', kind: 'boolean' },
] as const;

const enrichedCpuSeries = cpuSeries.map(enrichedCpuSchema, (event) =>
  event.merge({ healthy: event.get('cpu') < 0.9 }),
);
const enrichedCpuEvent = enrichedCpuSeries.at(0);
if (!enrichedCpuEvent) {
  throw new Error('missing enriched event');
}
const enrichedHealthy: boolean = enrichedCpuEvent.get('healthy');
void enrichedHealthy;

const renamedCpuSeries = cpuSeries.rename({ cpu: 'usage', host: 'server' });
const renamedCpuEvent = renamedCpuSeries.at(0);
if (!renamedCpuEvent) {
  throw new Error('missing renamed event');
}
const renamedCpuUsage: number = renamedCpuEvent.get('usage');
const renamedCpuServer: string = renamedCpuEvent.get('server');
void renamedCpuUsage;
void renamedCpuServer;

// @ts-expect-error collapsed event no longer has "in"
const badCollapsedIn = collapsedSeriesEvent.get('in');
void badCollapsedIn;

// @ts-expect-error selected series event no longer has cpu
const badSelectedSeriesCpu = selectedSeriesEvent.get('cpu');
void badSelectedSeriesCpu;

// @ts-expect-error renamed series event no longer has host
const badRenamedSeriesHost = renamedCpuEvent.get('host');
void badRenamedSeriesHost;

// @ts-expect-error mapped event no longer has "in"
const badMappedIn = mappedEvent.get('in');
void badMappedIn;

// @ts-expect-error merged source is string
const badMergedSource: number = mergedNth.get('source');
void badMergedSource;

// @ts-expect-error - wrong first column type for "time"
const badTime: Row = ['not-a-time', 10, 'bad'];
void badTime;

// @ts-expect-error - wrong second column type for "number"
const badValue: Row = [Date.now(), 'NaN', 'bad'];
void badValue;

new TimeSeries({
  name: 'bad-shape',
  schema,
  // @ts-expect-error - wrong row shape (missing label)
  rows: [[Date.now(), 1]],
});

// ── `reduce(mapping)` per-entry narrowing ───────────────────────────────
//
// Regression guard for the narrow `ReduceResult` lifted in v0.5.2. The
// dashboard paper-cut was that numeric reducers returned
// `ColumnValue | undefined`, forcing an `as number | undefined` cast.
// These assignments must keep compiling — they're the whole point.
const reduceSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
  { name: 'healthy', kind: 'boolean' },
] as const;

const reduceSeries = new TimeSeries({
  name: 'reduce-narrowing',
  schema: reduceSchema,
  rows: [[Date.now(), 0.5, 'api-1', true]],
});

// Numeric reducers narrow to `number | undefined`.
const reduceAvg: number | undefined = reduceSeries.reduce({ cpu: 'avg' }).cpu;
const reduceSum: number | undefined = reduceSeries.reduce({ cpu: 'sum' }).cpu;
const reduceCount: number | undefined = reduceSeries.reduce({
  host: 'count',
}).host;
const reduceP95: number | undefined = reduceSeries.reduce({
  cpu: 'p95',
}).cpu;
void reduceAvg;
void reduceSum;
void reduceCount;
void reduceP95;

// `unique` narrows to `ReadonlyArray<T>` where T is the source column's
// element type — not the wide scalar union.
const reduceUniqueHosts: ReadonlyArray<string> | undefined =
  reduceSeries.reduce({ host: 'unique' }).host;
const reduceUniqueCpu: ReadonlyArray<number> | undefined = reduceSeries.reduce({
  cpu: 'unique',
}).cpu;
const reduceUniqueHealthy: ReadonlyArray<boolean> | undefined =
  reduceSeries.reduce({ healthy: 'unique' }).healthy;
void reduceUniqueHosts;
void reduceUniqueCpu;
void reduceUniqueHealthy;

// `top${N}` (helper + literal form) mirrors the same source-kind
// narrowing.
const reduceTopHosts: ReadonlyArray<string> | undefined = reduceSeries.reduce({
  host: 'top3',
}).host;
const reduceTopCpu: ReadonlyArray<number> | undefined = reduceSeries.reduce({
  cpu: 'top5',
}).cpu;
void reduceTopHosts;
void reduceTopCpu;

// `samples` (v0.14.1) — same source-kind narrowing as `unique` and
// `top${N}`. Returns the source column's values as an array, with
// duplicates preserved (distinct from `unique` which deduplicates).
const reduceSamplesHosts: ReadonlyArray<string> | undefined =
  reduceSeries.reduce({ host: 'samples' }).host;
const reduceSamplesCpu: ReadonlyArray<number> | undefined = reduceSeries.reduce(
  { cpu: 'samples' },
).cpu;
const reduceSamplesHealthy: ReadonlyArray<boolean> | undefined =
  reduceSeries.reduce({ healthy: 'samples' }).healthy;
void reduceSamplesHosts;
void reduceSamplesCpu;
void reduceSamplesHealthy;

// `samples` is also accepted in `aggregate` mappings — pre-v0.14.2
// the type system rejected it with "Type '\"samples\"' is not
// assignable to type 'AggregateReducer'". Now narrows to an
// array-output column kind via AggregateKindForColumn.
const aggregateWithSamples = reduceSeries.aggregate(Sequence.every('5s'), {
  host: 'samples',
  cpu: 'samples',
});
void aggregateWithSamples;

// The narrow type is assignable to the wide one — code written against
// v0.5.2's `ReadonlyArray<ScalarValue>` assertion keeps compiling.
const reduceUniqueWide: ReadonlyArray<string | number | boolean> | undefined =
  reduceSeries.reduce({ host: 'unique' }).host;
void reduceUniqueWide;

// `first` / `last` / `keep` preserve the source column kind.
const reduceFirstNumber: number | undefined = reduceSeries.reduce({
  cpu: 'first',
}).cpu;
const reduceLastString: string | undefined = reduceSeries.reduce({
  host: 'last',
}).host;
const reduceKeepBool: boolean | undefined = reduceSeries.reduce({
  healthy: 'keep',
}).healthy;
void reduceFirstNumber;
void reduceLastString;
void reduceKeepBool;

// Custom reducer functions fall back to `ColumnValue | undefined`.
const reduceCustom = reduceSeries.reduce({
  cpu: (values) => {
    const nums = values.filter((v): v is number => typeof v === 'number');
    return nums.length === 0 ? undefined : nums[0];
  },
}).cpu;
// Must be assignable to the wide fallback:
const reduceCustomWide:
  | string
  | number
  | boolean
  | ReadonlyArray<string | number | boolean>
  | undefined = reduceCustom;
void reduceCustomWide;

// pivotByGroup: typed variant via declared `groups`.
const longSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;
const longSeries = new TimeSeries({
  name: 'metrics',
  schema: longSchema,
  rows: [[0, 0.31, 'api-1']],
});

// Untyped overload: schema widens to SeriesSchema (loose).
const wideUntyped = longSeries.pivotByGroup('host', 'cpu');
void wideUntyped;

// Typed overload: schema is literal-typed from declared groups.
const HOSTS = ['api-1', 'api-2'] as const;
const wideTyped = longSeries.pivotByGroup('host', 'cpu', { groups: HOSTS });

// `.baseline('api-1_cpu', ...)` should type-check without `as never` —
// the typed overload propagates literal column names through.
const widenedWithBaseline = wideTyped.baseline('api-1_cpu', {
  window: '1m',
  sigma: 2,
});
void widenedWithBaseline;

// Reading a known column out of `toPoints()` returns the source column's
// kind (`number` here).
const wideTypedPoint = wideTyped.toPoints()[0];
const apiCpu: number | undefined = wideTypedPoint?.['api-1_cpu'];
void apiCpu;

// @ts-expect-error declared groups make 'api-3_cpu' an invalid column name
const badBaselineColumn = wideTyped.baseline('api-3_cpu', {
  window: '1m',
  sigma: 2,
});
void badBaselineColumn;

// ── partitionBy().rolling overload coverage with options variables ─────
//
// Codex flagged (2026-05-01) that the four narrowed overloads on
// `LivePartitionedSeries.rolling` and `LivePartitionedView.rolling` did
// not accept callers passing `options` as a variable typed
// `LiveRollingOptions` — only inline literals worked. The catch-all
// overloads added in v0.13.0 close this hole; these assertions pin it.

import { LiveSeries, Trigger } from '../src/index.js';
import type { LiveRollingOptions } from '../src/live/live-rolling-aggregation.js';

const liveCpuSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const liveCpu = new LiveSeries({ name: 'cpu', schema: liveCpuSchema });

// Guard preservation on the live mirrors (same ValidatedAggregateMap
// constraint as the batch methods).
// @ts-expect-error — wrong-kind shorthand on LiveSeries.rolling
liveCpu.rolling('1m', { host: 'avg' });
// @ts-expect-error — bare reducer on a non-source key (live aggregate)
liveCpu.aggregate(Sequence.every('1m'), { ghost: 'avg' });

// Inline literal: untyped → routes to event-trigger overload (returns
// LivePartitionedView).
const inlineEvt = liveCpu.partitionBy('host').rolling('1m', { cpu: 'avg' });
void inlineEvt;

// Inline literal with explicit clock trigger → routes to clock-trigger
// overload (returns LiveSource<SeriesSchema>).
const inlineClock = liveCpu
  .partitionBy('host')
  .rolling(
    '1m',
    { cpu: 'avg' },
    { trigger: Trigger.clock(Sequence.every('30s')) },
  );
void inlineClock;

// Variable-typed options — Codex's failing case. Catch-all overload
// accepts it and returns the union of both branches.
const optsVar: LiveRollingOptions = { trigger: Trigger.event() };
const varEvt = liveCpu
  .partitionBy('host')
  .rolling('1m', { cpu: 'avg' }, optsVar);
void varEvt;

const optsVarEmpty: LiveRollingOptions = {};
const varEmpty = liveCpu
  .partitionBy('host')
  .rolling('1m', { cpu: 'avg' }, optsVarEmpty);
void varEmpty;

const optsVarClock: LiveRollingOptions = {
  trigger: Trigger.clock(Sequence.every('30s')),
};
const varClock = liveCpu
  .partitionBy('host')
  .rolling('1m', { cpu: 'avg' }, optsVarClock);
void varClock;

// Same coverage with the AggregateOutputMap shape.
const varAlias = liveCpu
  .partitionBy('host')
  .rolling('1m', { mean: { from: 'cpu', using: 'avg' } }, optsVar);
void varAlias;

const varAliasEmpty = liveCpu
  .partitionBy('host')
  .rolling('1m', { mean: { from: 'cpu', using: 'avg' } }, optsVarEmpty);
void varAliasEmpty;

const varAliasClock = liveCpu
  .partitionBy('host')
  .rolling('1m', { mean: { from: 'cpu', using: 'avg' } }, optsVarClock);
void varAliasClock;

// Chained partitioned view (LivePartitionedView.rolling) — same catch-all
// coverage. Use fill() to land on a chained view.
const chainEvt = liveCpu
  .partitionBy('host')
  .fill({ cpu: 'hold' })
  .rolling('1m', { cpu: 'avg' }, optsVar);
void chainEvt;

const chainAlias = liveCpu
  .partitionBy('host')
  .fill({ cpu: 'hold' })
  .rolling('1m', { mean: { from: 'cpu', using: 'avg' } }, optsVarEmpty);
void chainAlias;
