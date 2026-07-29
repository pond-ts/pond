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
  port,
  source,
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
void [rowCount, lo, snapshot, json, outlet];
