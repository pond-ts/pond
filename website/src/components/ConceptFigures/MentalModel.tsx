import {
  BASE,
  BODY,
  GRID,
  INK,
  MONO,
  SURFACE2,
  TEAL,
  svgStyle,
} from './tokens';

const W = 545;
const H = 470;
const BX = 70; // box left
const BW = 290; // box width
const BH = 58; // box height
const CX = BX + BW / 2; // arrow / box center x
const AX = BX + BW + 22; // right-annotation x

function Box({ y, l1, l2 }: { y: number; l1: string; l2: string }) {
  return (
    <g>
      <rect
        x={BX}
        y={y}
        width={BW}
        height={BH}
        rx={9}
        style={{ fill: SURFACE2, stroke: GRID }}
        strokeWidth={1.25}
      />
      <text
        x={CX}
        y={y + 24}
        textAnchor="middle"
        fontSize={14}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        {l1}
      </text>
      <text
        x={CX}
        y={y + 43}
        textAnchor="middle"
        fontSize={12.5}
        fontFamily={MONO}
        style={{ fill: BODY }}
      >
        {l2}
      </text>
    </g>
  );
}

function FlowArrow({
  y1,
  y2,
  name,
  sub,
  ops,
}: {
  y1: number;
  y2: number;
  name: string;
  sub: string;
  ops: string[];
}) {
  const my = (y1 + y2) / 2;
  return (
    <g>
      <line
        x1={CX}
        y1={y1}
        x2={CX}
        y2={y2 - 7}
        style={{ stroke: TEAL }}
        strokeWidth={1.75}
      />
      <path
        d={`M ${CX - 4.5} ${y2 - 8} L ${CX + 4.5} ${y2 - 8} L ${CX} ${y2} Z`}
        style={{ fill: TEAL }}
      />
      <text
        x={CX - 16}
        y={my - 3}
        textAnchor="end"
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: INK }}
      >
        {name}
      </text>
      <text
        x={CX - 16}
        y={my + 13}
        textAnchor="end"
        fontSize={11.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        {sub}
      </text>
      {ops.map((op, i) => (
        <text
          key={op}
          x={CX + 18}
          y={my - 3 + i * 16}
          fontSize={11.5}
          fontFamily={MONO}
          style={{ fill: BODY }}
        >
          {op}
        </text>
      ))}
    </g>
  );
}

/**
 * The Concepts index "mental model" flow: a series runs through
 * grid-preserving transforms, then grid-changing windowing, down to a
 * bucketed series or scalar record.
 */
export default function MentalModel() {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={svgStyle(620)}
      role="img"
      aria-label="Mental model: a TimeSeries or LiveSeries flows through grid-preserving transforms (filter, map, rolling, smooth, and more) into another TimeSeries or accumulator, then through grid-changing windowing (aggregate, rolling, reduce) into a bucketed series or scalar record"
    >
      <text
        x={CX}
        y={22}
        textAnchor="middle"
        fontSize={12}
        fontFamily={MONO}
        style={{ fill: BODY }}
      >
        S — the schema, threaded through every step
      </text>

      <Box y={36} l1="TimeSeries<S>" l2="(or LiveSeries<S>)" />
      <text
        x={AX}
        y={60}
        fontSize={12}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        immutable, complete
      </text>
      <text
        x={AX}
        y={76}
        fontSize={12}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        (or mutable, streaming)
      </text>

      <FlowArrow
        y1={94}
        y2={188}
        name="transforms"
        sub="(preserve the grid)"
        ops={[
          'filter, map, select, fill,',
          'diff, rate, rolling, smooth,',
          'cumulative, pctChange, …',
        ]}
      />

      <Box y={188} l1="TimeSeries<S'>" l2="(or accumulator)" />

      <FlowArrow
        y1={246}
        y2={340}
        name="windowing"
        sub="(changes the grid)"
        ops={[
          'aggregate(seq, mapping)',
          'rolling(window, mapping)',
          'reduce(mapping)',
        ]}
      />

      <Box y={340} l1="Bucketed series" l2="or scalar record" />
    </svg>
  );
}
