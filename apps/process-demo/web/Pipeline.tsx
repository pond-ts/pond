/**
 * The pipeline, as a graph you can click — M4.
 *
 * This is the demo's payoff, and the plan's claim about it is that it
 * "costs almost nothing, because every intermediate is already a named,
 * cached, addressable value." Building it, that held:
 *
 * - the **label** is `explain[id]`, which the library derives;
 * - the **badge** is `cached` / `ms` from the same `nodes` array M1 added;
 * - the **edges** are `node.inputs`, added in M4 because they were the
 *   one thing genuinely missing — a consumer cannot derive them without
 *   reimplementing `specId`;
 * - **clicking** a node is one more `columns: true` selector on an id the
 *   response already names.
 *
 * Nothing here holds intermediate state or invents a name. In a fold you
 * would have to deliberately retain every intermediate and name it
 * yourself; that asymmetry is the clearest argument the graph has.
 *
 * Layout is dagre — React Flow ships no layout engine deliberately, and a
 * DAG is exactly what dagre is for. **Top to bottom**, not left to right:
 * the request panel is a tall narrow column, and an LR graph three nodes
 * wide hit React Flow's 0.5 zoom floor and clipped. Source at the top,
 * result at the bottom also reads the way a pipeline is described.
 */

import { useCallback, useMemo } from 'react';
import dagre from 'dagre';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { colorsForNodes } from './palette.js';

export interface NodeTiming {
  id: string;
  /** The caller's name for this position, when the request used slots. */
  slot?: string;
  /** False for a node the plan resolved but this request never read. */
  pulled: boolean;
  cached: boolean;
  ms: number;
  inputs: string[];
}

interface NodeData extends Record<string, unknown> {
  label: string;
  detail: string;
  kind: 'source' | 'node';
  state: 'cached' | 'computed' | 'idle';
  selected: boolean;
  /** This node's colour, the same one its curves and cards carry. */
  color: string | undefined;
  /**
   * The content-addressed id. The view is keyed by slot so a param edit
   * does not read as a new graph, but everything downstream — drawing,
   * selection, addressing an intermediate — still goes by id.
   */
  specId: string;
}

const NODE_W = 190;
const NODE_H = 52;

function StepNode({ data }: NodeProps<Node<NodeData>>) {
  const cls = ['flow-node', data.kind, data.state, data.selected ? 'on' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      style={{
        width: NODE_W,
        height: NODE_H,
        // The border is the node's **identity**; warm/cold moved to the
        // badge text. Two channels, two meanings — colouring the border
        // by state would have cost the thread that ties this box to its
        // curve in the workbook and its card in the output.
        ...(data.color !== undefined &&
          !data.selected && {
            borderColor: data.color,
            borderLeftColor: data.color,
          }),
      }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flow-label" title={data.detail}>
        {data.label}
      </div>
      <div className={`flow-badge ${data.state}`}>{data.detail}</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const NODE_TYPES = { step: StepNode };

/**
 * Lays the DAG out left to right.
 *
 * Source columns become nodes too. They are not in `nodes` — they are not
 * computed — but an edge from `px` is the difference between a pipeline
 * you can read and a set of floating boxes.
 */
function layout(
  nodes: readonly NodeTiming[],
  explain: Record<string, string>,
  selected: string | undefined,
) {
  // **Keyed by slot, not by id.** A param edit changes every derived id,
  // so keying on those made React Flow see the whole graph replaced:
  // nodes remounted, `fitView` re-ran, and the pipeline jumped on every
  // slider move. A slot is stable across exactly that edit — which is
  // what it is for. A nested plan has no slots, and there the id is the
  // only identity available.
  const stable = new Map(nodes.map((n) => [n.id, n.slot ?? n.id]));
  const ref = (id: string) => stable.get(id) ?? id;
  // Derived exactly as the results panel derives it, so a box and the
  // curve it produced carry the same hue with neither told about the other.
  const colors = colorsForNodes(nodes);

  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: 16,
    ranksep: 34,
    marginx: 8,
    marginy: 8,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const known = new Set(nodes.map((n) => n.id));
  const sources = new Set<string>();
  for (const n of nodes) {
    for (const input of n.inputs) if (!known.has(input)) sources.add(input);
  }

  for (const id of [...sources, ...nodes.map((n) => ref(n.id))]) {
    g.setNode(id, { width: NODE_W, height: NODE_H });
  }
  const edges: Edge[] = [];
  for (const n of nodes) {
    for (const input of n.inputs) {
      g.setEdge(ref(input), ref(n.id));
      edges.push({
        id: `${ref(input)}->${ref(n.id)}`,
        source: ref(input),
        target: ref(n.id),
        animated: n.pulled && !n.cached,
      });
    }
  }
  dagre.layout(g);

  const place = (id: string, data: NodeData): Node<NodeData> => {
    const p = g.node(id) as { x: number; y: number } | undefined;
    return {
      id,
      type: 'step',
      position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 },
      // Given rather than measured, so `fitView` has bounds on the first
      // render instead of after a layout pass.
      width: NODE_W,
      height: NODE_H,
      data,
      draggable: false,
    };
  };

  const flowNodes: Node<NodeData>[] = [
    ...[...sources].map((id) =>
      place(id, {
        label: id,
        detail: 'source column',
        kind: 'source',
        state: 'idle',
        selected: false,
        color: undefined,
        specId: id,
      }),
    ),
    ...nodes.map((n) =>
      place(ref(n.id), {
        label: explain[n.id] ?? n.id,
        // A node nothing selected has no timing to report — saying
        // "cached · 0 ms" there would be a lie dressed as a measurement.
        // The slot leads when there is one: it is the name the caller
        // chose, and the one thing on this node that survives a param
        // edit ([PND-PROCSLOT]).
        detail:
          (n.slot === undefined ? '' : `${n.slot} · `) +
          (n.pulled
            ? `${n.cached ? 'cached' : 'computed'} · ${n.ms} ms`
            : n.cached
              ? 'not requested · holds a value'
              : 'not requested'),
        kind: 'node',
        state: n.pulled ? (n.cached ? 'cached' : 'computed') : 'idle',
        selected: n.id === selected,
        color: colors.get(n.id),
        specId: n.id,
      }),
    ),
  ];
  return { flowNodes, edges };
}

export function Pipeline(props: {
  nodes: readonly NodeTiming[];
  explain: Record<string, string>;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  const { flowNodes, edges } = useMemo(
    () => layout(props.nodes, props.explain, props.selected),
    [props.nodes, props.explain, props.selected],
  );

  const onNodeClick = useCallback(
    (_: unknown, node: Node) => {
      const data = node.data as NodeData;
      if (data.kind === 'source') return;
      props.onSelect(data.specId === props.selected ? undefined : data.specId);
    },
    [props],
  );

  if (props.nodes.length === 0) {
    return <p className="muted">No nodes in this response yet.</p>;
  }

  return (
    <div className="flow">
      <ReactFlow
        // Re-mounting re-runs `fitView` — which a genuinely new plan
        // wants and a param edit does not. Keyed by the ids *after* the
        // slot mapping, so it changes when the topology does and holds
        // still when only a value moved.
        key={flowNodes.map((n) => n.id).join('|')}
        nodes={flowNodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={onNodeClick}
        onPaneClick={() => props.onSelect(undefined)}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        // Below React Flow's 0.5 default, so a deep plan shrinks to fit
        // rather than being clipped at the floor.
        minZoom={0.25}
        proOptions={{ hideAttribution: true }}
        nodesConnectable={false}
        elementsSelectable={false}
      >
        <Background gap={18} color="#2b3038" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
