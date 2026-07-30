# @pond-ts/process

> **Work in progress. Not published, and the public shape is expected to
> change.** This package is `private: true` — the release workflow skips it. It
> lives on `main` so the design can be iterated in the open against
> [RFC #543](../../docs/rfcs/process.md), not because it is ready to consume.
>
> The RFC concludes that the **declarative plan layer** is the consumer surface
> and that this engine belongs underneath it as an internal module. That call is
> tracked as **[PND-PROCSUB]**; the investigation behind it and its measured
> follow-ups are in
> [PND_PROCESS_PLAN.md](../../docs/plans/PND_PROCESS_PLAN.md). Interactive
> consumers remain gated on the identity/lifetime and shared cache-budget work.
>
> The measurements those tickets are sized against are reproducible from
> [`scripts/`](scripts/) — run them after `npm run build --workspaces`.

**Typed dataflow graphs over [pond-ts](https://www.npmjs.com/package/pond-ts).**

A small pull-based evaluation engine: nodes with typed ports, memoized
results, and change propagation that stops as soon as a value stops
changing. Values are usually `TimeSeries` snapshots, but the engine is
value-agnostic.

```sh
npm install @pond-ts/process pond-ts
```

`pond-ts` is a peer dependency.

## When _not_ to use this

Chaining is pond's mental model and stays the right default:

```ts
const out = series
  .rolling('5m', { cpu: 'avg' })
  .aggregate(Sequence.every('1h'), {
    cpu: 'max',
  });
```

That is clearer than any graph, and pond's design notes deliberately
[resist operator-graph vocabulary](../../docs/rfcs/streaming.md) for the
core API — you do not submit a job graph to a runtime.

This package exists for the case chaining genuinely cannot express: when
**the pipeline itself is data**. Assembled at runtime from config,
reshaped by a user in an editor, or fanning one expensive computation out
to several consumers that each want a different slice. If your pipeline is
known when you write the code, chain it and skip this package.

## Fluent plans

Bind authoring to a registry when application code constructs the graph.
The registry's literal type supplies the operation methods, params, secondary
input roles, and multi-output suffixes:

```ts
const graph = process(registry, 'ACME_5m').as('bands_and_stretch');
const close = graph.column('close');

const bands = close.bollinger({
  as: 'bands',
  period: 20,
  stdDev: 2,
});

const width = bands.output('Upper').subtract({
  as: 'width',
  right: bands.output('Lower'),
});

const request = graph.outputs({
  bands: bands.columns(),
  upper: bands.output('Upper').columns(),
  latestWidth: width.last(),
});

const result = host.run(request);
```

`period: '20'`, `bands.output('Banana')`, or an omitted `right` input are
compile errors. The result is nevertheless plain slot-plan data: the fluent
surface has no resolver or cache of its own, and a model-composed JSON request
lands on the same nodes.

Use `plan(from).add(...)` when the operation itself is dynamic and cannot be
known to TypeScript.

## Remote sources

A graph may name an opaque asynchronous source instead of a preloaded dataset.
The request carries its name and params; URLs, credentials, and loader code stay
on the host:

```ts
const marketBars = defineSource({
  name: 'market.bars',
  async load(
    {
      symbol,
      interval,
    }: {
      symbol: string;
      interval: '1m' | '5m' | '1h';
    },
    { previous },
  ) {
    const response = await fetch(
      `${MARKET_API}/bars?symbol=${symbol}&interval=${interval}`,
      {
        headers: {
          Authorization: `Bearer ${MARKET_TOKEN}`,
          ...(previous && { 'If-None-Match': previous.revision }),
        },
      },
    );
    if (response.status === 304) return previous!;
    return {
      value: TimeSeries.fromJSON(await response.json()),
      revision: response.headers.get('etag')!,
    };
  },
});

const sources = createSourceRegistry().define(marketBars);
const host = createHost({ registry, sources, units });

const graph = process(
  registry,
  marketBars.ref({ symbol: 'ACME', interval: '5m' }),
);
const close = graph.column('close');
const average = close.sma({ as: 'average', period: 20 });

const result = await host.runAsync(
  graph.outputs({ average: average.columns(), latest: average.last() }),
);
```

The canonical source reference chooses a long-lived bound graph. The loader's
`revision` decides freshness: an equal revision preserves every cached node; a
new revision updates the source in place and lets ordinary graph invalidation
run. Use synchronous `host.run()` for string-keyed datasets added with
`host.add()`.

## Worker pool (Node)

`@pond-ts/process/pool` runs **whole requests** across worker threads, each
holding a long-lived `Host`. It scales throughput under concurrent load; it
does not make one request faster.

```ts
// setup.mjs — imported by BOTH isolates, because a registry is functions
// and functions do not survive structured clone.
export default function setup() {
  return { registry, datasets: { px: series } };
}
```

```ts
import { HostPool } from '@pond-ts/process/pool';

const pool = await HostPool.start({
  setup: new URL('./setup.mjs', import.meta.url),
  size: 4,
});
const result = await pool.run({ from: 'px', process: plan, select });
await pool.close();
```

Requests run with `assemble: false` — the pool answers `columns` (which cross
as transferable buffers) and the caller assembles a `TimeSeries` if it wants
one. Pass an `affinity` key as the second argument to pin related requests to
one worker, so its warm nodes get reused.

**When it pays.** Measured at 32 requests over 8 workers: 3.6× when each
request costs ~58 ms, 2.6× at ~2.4 ms, **0.94× at ~0.7 ms**, and **0.14×** on a
workload of repeated questions that the in-process memo already answers for
free. Every answer is shipped whether or not it was cheap, and each worker
warms its _own_ graph — so pooling competes with caching rather than
complementing it. Worth it when requests are numerous, mostly distinct, and
individually cost more than a millisecond or two. Find your own crossover with
`node packages/process/scripts/perf-pool.mjs`.

## Quick start

```ts
import { source, derive } from '@pond-ts/process';

const raw = source<TimeSeries<Schema>>();

const hourly = derive({ s: raw.out.value }, ({ s }) =>
  s.aggregate(Sequence.every('1h'), { cpu: 'avg' }),
);
const peak = derive({ s: hourly.out.value }, ({ s }) => s.column('cpu').max());

raw.set(series);
peak.out.value.get(); // aggregates once, caches
peak.out.value.get(); // cache hit — nothing recomputes
```

## How evaluation works

Two mechanisms doing two different jobs:

- **Dirty marking (push).** Setting a source marks everything downstream
  as "revalidate before answering," cutting off at nodes already marked.
  A change costs O(affected nodes) regardless of graph size.
- **Version stamps (pull).** Each outlet's version increments only when a
  recomputed value _actually differs_. A dirty node whose input versions
  all match skips `compute` entirely.

The second is the point. A source change that produces an identical
downstream value stops the cascade there, so expensive transforms below it
never run:

```ts
const level = source<number>();
const bucket = derive({ x: level.out.value }, ({ x }) => Math.floor(x / 10), {
  equals: (a, b) => a === b,
});
const expensive = derive({ b: bucket.out.value }, ({ b }) => heavyWork(b));

level.set(11);
expensive.out.value.get(); // computes
level.set(13); // different input, same bucket
expensive.out.value.get(); // cache hit — heavyWork never re-runs
```

Equality defaults to `Object.is`, which is right for immutable pond values
— a transform that changed something returns a new instance. Supply
`equals` where a node produces scalars or small records. Note that a
`true` from `equals` also **keeps the old value** and discards the new
one, so compare everything a consumer can observe, not just an id.

## Types are enforced, not documented

Ports are typed fields, so mismatches are compile errors:

```ts
text.out.value.connect(add.in.a); // ✗ Outlet<string> → Inlet<number>
add.in.nope; // ✗ 'nope' is not a declared input
```

## Live sources

`fromLive` binds a pond `LiveSeries` / `LiveView` into a graph. Events
**invalidate**; they don't snapshot. A burst of 10,000 events costs one
dirty mark each and exactly one `toTimeSeries()` at the next pull:

```ts
const feed = fromLive(liveSeries);
const hourly = derive({ s: feed.out.value }, ({ s }) =>
  s.aggregate(Sequence.every('1h'), { cpu: 'avg' }),
);

// ... 10k events arrive ...
hourly.out.value.get(); // one snapshot, one aggregate
feed.dispose(); // unsubscribe
```

That keeps the layer on the right side of pond's split: incremental
per-event work stays in the live layer, and the graph composes whole-value
batch transforms over snapshots.

### There is no partial invalidation — bind the aggregation instead

A dirty node recomputes from a _whole_ snapshot. The pipeline above
therefore re-aggregates every retained event on every pull, even though
only the tail moved. The graph does not track which rows changed, and
deliberately doesn't try to: pond's live layer already does incremental
per-event computation, and reimplementing it behind ports would be a
second engine to keep correct.

So push the windowed work down and bind _its_ output:

```ts
const feed = fromLive(live.aggregate(Sequence.every('1h'), { cpu: 'avg' }));
const peak = derive({ s: feed.out.value }, ({ s }) => s.column('cpu').max());
```

`LiveAggregation` maintains its buckets per event, so a pull materializes
bucket count instead of event count. At 200k events through a 50k-event
buffer, pulling every 1k events: **9.05 ms/pull re-aggregating the buffer
vs 0.04 ms/pull off the live aggregation — 235×**, and the gap widens with
buffer size (O(retained events) vs O(buckets)).

**Read the tradeoff before switching.** A live aggregation exposes _closed_
buckets only. Data is the clock, so the newest bucket is invisible until an
event crosses its end — two hours of minute data ending at 1h59m reads as
one row this way and two by re-aggregating the buffer. If the currently
filling bucket must be on screen, stay on the buffer and pay for it, or use
a `Trigger` so buckets close on a schedule you control.

## Multi-output nodes

`derive` covers single-output nodes. `defineNode` declares a reusable node
type, with as many outputs as you like — all computed in one pass:

```ts
const Extent = defineNode({
  kind: 'extent',
  inputs: { series: port<TimeSeries<Schema>>() },
  outputs: { min: port<number>(), max: port<number>() },
  compute: ({ series }) => ({
    min: series.column('cpu').min(),
    max: series.column('cpu').max(),
  }),
});

const extent = Extent();
hourly.out.value.connect(extent.in.series);
extent.out.min.get(); // computes both outputs once
```

## Inspecting a graph

`Graph` is a read-only view over already-wired nodes — evaluation never
consults it.

```ts
const graph = Graph.from(peak); // discovers every reachable node
graph.order(); // dependency order
graph.toJSON(); // structure: nodes, ports, edges
```

`toJSON()` is a description, not a serialization — there is no `fromJSON`.
Rebuilding a graph needs a `kind` → factory registry and per-node config in
the dump; neither exists yet.

## Errors

A node caches the error its `compute` threw and rethrows it without
re-running until an input changes, so a broken node stays cheap to poll.
`node.error` exposes it. Cycles are rejected by `connect()`, so the graph
is acyclic by construction and evaluation never guards against recursion.
