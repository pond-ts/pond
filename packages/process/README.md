# @pond-ts/process

**Typed dataflow graphs over [pond-ts](https://www.npmjs.com/package/pond-ts).**

A small pull-based evaluation engine: nodes with typed ports, memoized
results, and change propagation that stops as soon as a value stops
changing. Values are usually `TimeSeries` snapshots, but the engine is
value-agnostic.

```sh
npm install @pond-ts/process pond-ts
```

`pond-ts` is a peer dependency.

## When *not* to use this

Chaining is pond's mental model and stays the right default:

```ts
const out = series.rolling('5m', { cpu: 'avg' }).aggregate(Sequence.every('1h'), {
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
  recomputed value *actually differs*. A dirty node whose input versions
  all match skips `compute` entirely.

The second is the point. A source change that produces an identical
downstream value stops the cascade there, so expensive transforms below it
never run:

```ts
const bucket = derive({ x: raw.out.value }, ({ x }) => Math.floor(x / 10), {
  equals: (a, b) => a === b,
});
const expensive = derive({ b: bucket.out.value }, ({ b }) => heavyWork(b));

raw.set(11);
expensive.out.value.get(); // computes
raw.set(13); // different input, same bucket
expensive.out.value.get(); // cache hit — heavyWork never re-runs
```

Equality defaults to `Object.is`, which is right for immutable pond values
— a transform that changed something returns a new instance. Supply
`equals` where a node produces scalars or small records.

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
