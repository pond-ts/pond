// [PND-PARTCOL] — the partition column survives, in the static type, a
// schema-changing operator under `partitionBy`. Runtime already re-injected
// it (`augmentMappingWithPartitionCols`); these assertions pin that the type
// now says the same thing, for `aggregate` and `rolling`, single and
// composite partitions, and the "mapping key wins" rule.
import {
  PartitionedTimeSeries,
  Sequence,
  TimeSeries,
  type SeriesSchema,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'region', kind: 'string' },
  { name: 'host', kind: 'string' },
  { name: 'ms', kind: 'number' },
] as const;

const s = TimeSeries.fromJSON({ name: 'latency', schema, rows: [] });

// ── aggregate: partition column present in the collected type ──────────
const p95 = s
  .partitionBy('host')
  .aggregate(Sequence.every('5m'), { p95: { from: 'ms', using: 'p95' } })
  .collect();
const host1: string | undefined = p95.at(0)!.get('host');
void host1;
const p951: number | undefined = p95.at(0)!.get('p95');
void p951;
// A non-partition source column that the mapping dropped stays dropped.
// @ts-expect-error — `region` is neither mapped nor a partition column
p95.at(0)!.get('region');
// @ts-expect-error — `ms` was reduced away
p95.at(0)!.get('ms');

// ── rolling: same rule ─────────────────────────────────────────────────
const rolled = s.partitionBy('host').rolling('5m', { ms: 'avg' }).collect();
const host2: string | undefined = rolled.at(0)!.get('host');
void host2;
// @ts-expect-error — `region` not carried
rolled.at(0)!.get('region');

// ── composite partition: both columns carried ──────────────────────────
const both = s
  .partitionBy(['region', 'host'])
  .aggregate(Sequence.every('1h'), { ms: 'max' })
  .collect();
const region3: string | undefined = both.at(0)!.get('region');
const host3: string | undefined = both.at(0)!.get('host');
void region3;
void host3;

// ── mapping key wins, kind and all ─────────────────────────────────────
const counted = s
  .partitionBy('host')
  .aggregate(Sequence.every('5m'), { host: 'count', ms: 'avg' })
  .collect();
const hostCount: number | undefined = counted.at(0)!.get('host');
void hostCount;
// @ts-expect-error — the user's `count` made `host` a number, not a string
const notString: string | undefined = counted.at(0)!.get('host');
void notString;

// ── chained: the carried column is available to the next operator ──────
const chained = s
  .partitionBy('host')
  .aggregate(Sequence.every('5m'), { p95: { from: 'ms', using: 'p95' } })
  .baseline('p95', { window: '1h', sigma: 2 })
  .collect();
const host4: string | undefined = chained.at(0)!.get('host');
const upper4: number | undefined = chained.at(0)!.get('upper');
void host4;
void upper4;

// ── typed groups keep working and still carry the column ───────────────
const grouped = s
  .partitionBy('host', { groups: ['a', 'b'] })
  .aggregate(Sequence.every('5m'), { ms: 'avg' });
const m: Map<'a' | 'b', unknown> = grouped.toMap();
void m;
const host5: string | undefined = grouped.collect().at(0)!.get('host');
void host5;

// ── schema-preserving operators are unchanged ──────────────────────────
const filled = s.partitionBy('host').fill({ ms: 'hold' }).collect();
const host6: string | undefined = filled.at(0)!.get('host');
const ms6: number | undefined = filled.at(0)!.get('ms');
void host6;
void ms6;

// ── rolling(sequence, window, mapping) overload — same augmentation ────
const gridRolled = s
  .partitionBy('host')
  .rolling(Sequence.every('1m'), '5m', { ms: 'avg' })
  .collect();
const host7: string | undefined = gridRolled.at(0)!.get('host');
void host7;

// ── broad schema + non-literal column: no regression ────────────────────
// `By` widens to `string`; an index signature would have swallowed every
// output column's type (review finding on #724). The guard leaves the
// mapping alone, so outputs stay narrow exactly as on main.
declare const broad: TimeSeries<SeriesSchema>;
declare const anyCol: string;
const broadOut = broad
  .partitionBy(anyCol)
  .aggregate(Sequence.every('5m'), { cpu: 'avg' })
  .collect();
const cpuBroad: number | undefined = broadOut.at(0)!.get('cpu');
void cpuBroad;

// ── Codex findings on #724 ─────────────────────────────────────────────
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// (1) Broad schema + LITERAL column: the injected `'first'` cannot look up a
// kind on `TimeSeries<SeriesSchema>` and used to resolve to `undefined`.
// The guard now leaves the mapping alone, so the result schema is exactly
// main's — the mapping's columns only. The type does not claim `host` (an
// honest "unknown" beats a wrong `undefined`), and `cpu` stays narrow.
const broadLit = broad
  .partitionBy('host')
  .aggregate(Sequence.every('5m'), { cpu: 'avg' })
  .collect();
// @ts-expect-error — broad schema: `host` is not claimed by the type (as on main)
broadLit.at(0)!.get('host');
const cpuBroadLit: number | undefined = broadLit.at(0)!.get('cpu');
void cpuBroadLit;
// Exact-type probe on the unannotated expression (an annotated const would
// be tautological): `cpu` is precisely `number | undefined`, not the broad
// value union the pre-guard build produced.
const cpuIsNumber: Equal<
  NonNullable<ReturnType<typeof broadLit.at>> extends { get(f: 'cpu'): infer V }
    ? V
    : never,
  number | undefined
> = true;
void cpuIsNumber;

// (2) `By` is pinned contravariantly: a view partitioned by `region` cannot
// be claimed as one partitioned by `host` …
// @ts-expect-error — By='region' is not assignable to By='host'
const claimed: PartitionedTimeSeries<typeof schema, string, 'host'> =
  s.partitionBy('region');
void claimed;
// … and an untyped (legacy) view cannot be narrowed to a specific column …
declare const legacy: PartitionedTimeSeries<typeof schema>;
// @ts-expect-error — By=never cannot be widened to 'host'
const narrowed: PartitionedTimeSeries<typeof schema, string, 'host'> = legacy;
void narrowed;
// … while a specialised view still assigns to the legacy shapes.
const asLegacy: PartitionedTimeSeries<typeof schema> = s.partitionBy('host');
const asLegacyK: PartitionedTimeSeries<typeof schema, string> =
  s.partitionBy('host');
void asLegacy;
void asLegacyK;

// (3) Typed `K` survives `smooth` and `baseline` (CHANGELOG claim).
const smoothed = s
  .partitionBy('host', { groups: ['a', 'b'] })
  .smooth('ms', 'ema', { alpha: 0.3 });
const smoothedMap: Map<'a' | 'b', unknown> = smoothed.toMap();
void smoothedMap;
const based = s
  .partitionBy('host', { groups: ['a', 'b'] })
  .baseline('ms', { window: '1h', sigma: 2 });
const basedMap: Map<'a' | 'b', unknown> = based.toMap();
void basedMap;
const basedHost: string | undefined = based.collect().at(0)!.get('host');
void basedHost;
