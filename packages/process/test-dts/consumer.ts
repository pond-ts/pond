/**
 * Typechecks the **emitted declarations** the way a consumer sees them:
 * importing from `dist/`, with `skipLibCheck: false`.
 *
 * The package's own `tsconfig.json` sets `skipLibCheck: true` and never
 * typechecks its own output, so a `.d.ts` that references a type
 * `stripInternal` deleted builds green and only breaks downstream. That
 * happened once already (an `@internal` interface named in the public
 * signatures of `Inlet.node` / `Outlet.node`), which is why this file
 * exists. Run by `npm run test:dts`.
 *
 * Nothing here executes — it only has to compile.
 */

import {
  Graph,
  defineNode,
  derive,
  fromLive,
  process,
  createRegistry,
  int,
  num,
  port,
  source,
  type AsyncEnvelope,
  type Envelope,
  type GraphJson,
  type Node,
  type Outlet,
} from '../dist/index.js';
import type { LiveSeries, TimeSeries } from 'pond-ts';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
] as const;

declare const series: TimeSeries<typeof schema>;
declare const live: LiveSeries<typeof schema>;

// Sources and derived nodes carry their value types through.
const raw = source<TimeSeries<typeof schema>>();
raw.set(series);
const rowCount: number = derive(
  { s: raw.out.value },
  ({ s }) => s.length,
).out.value.get();

// Multi-output node types.
const Extent = defineNode({
  kind: 'extent',
  inputs: { values: port<readonly number[]>() },
  outputs: { min: port<number>(), max: port<number>() },
  compute: ({ values }) => ({
    min: Math.min(...values),
    max: Math.max(...values),
  }),
});
const extent = Extent();
const lo: number = extent.out.min.get();

// Live binding.
const feed = fromLive(live);
const snapshot: TimeSeries<typeof schema> = feed.out.value.get();
feed.dispose();

// Graph traversal — the path that broke: `edge.from.node` must be a real
// `Node`, not an unresolved type that silently degrades to `any`.
const graph = Graph.from(extent);
const json: GraphJson = graph.toJSON();
for (const edge of graph.edges()) {
  const kind: string = edge.from.node.kind;
  const id: string = edge.to.node.id;
  const dirty: boolean = edge.to.node.dirty;
  const err: unknown = edge.from.node.error;
  void kind;
  void id;
  void dirty;
  void err;
}
for (const node of graph.order()) {
  const n: Node<any, any> = node;
  void n;
}

// Port handles keep their value type when passed around.
const outlet: Outlet<number> = extent.out.max;

// Synchronous envelopes stay string-bound even though runAsync also accepts
// opaque source references. Local-host callers may rely on this narrowing.
declare const localEnvelope: Envelope;
const localDatasetId: string = localEnvelope.from;
declare const eitherEnvelope: AsyncEnvelope;
const asyncSource = eitherEnvelope.from;

// Registry-bound fluent plans retain op params, extra input roles and outputs.
const ops = createRegistry()
  .define({
    name: 'scale',
    family: 'test',
    summary: 'Scale.',
    params: { by: num({ default: 2 }) },
    inputs: [{ role: 'source' }],
    outputs: [{ id: '', unit: 'inherit' }],
    run: () => [],
  })
  .define({
    name: 'band',
    family: 'test',
    summary: 'Band.',
    params: { period: int({ default: 20 }) },
    inputs: [{ role: 'source' }],
    outputs: [
      { id: 'Upper', unit: 'inherit' },
      { id: 'Lower', unit: 'inherit' },
    ],
    run: () => [[], []],
  })
  .define({
    name: 'difference',
    family: 'test',
    summary: 'Difference.',
    params: {},
    inputs: [{ role: 'left' }, { role: 'right' }],
    outputs: [{ id: '', unit: 'inherit' }],
    run: () => [],
  });

const fluent = process(ops, 'prices');
const px = fluent.column('px');
const scaled = px.scale({ as: 'scaled', by: 4 });
const band = scaled.band({ as: 'band', period: 20 });
const difference = band
  .output('Upper')
  .difference({ as: 'width', right: band.output('Lower') });
fluent.outputs({
  band: band.columns(),
  upper: band.output('Upper').columns(),
  latest: difference.last(),
});

// @ts-expect-error `by` is numeric.
px.scale({ as: 'bad-param', by: '4' });
// @ts-expect-error Params come from the selected op only.
px.scale({ as: 'bad-name', period: 20 });
// @ts-expect-error Multi-output suffixes come from the registry.
band.output('Middle');
// @ts-expect-error The second input role is required and named.
band.output('Upper').difference({ as: 'missing-right' });

void [
  rowCount,
  lo,
  snapshot,
  json,
  outlet,
  localDatasetId,
  asyncSource,
  difference,
];
