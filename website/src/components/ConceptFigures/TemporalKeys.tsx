import {
  BASE,
  BLUE,
  BODY,
  GRID,
  INK,
  MONO,
  PINK,
  SURFACE,
  TEAL,
  svgStyle,
} from './tokens';

const W = 900;
const H = 264;
const X0 = 210; // 00:00
const STEP = 124; // 5 units of timeline
const TICKS = ['00:00', '00:05', '00:10', '00:15', '00:20', '00:25'];
const TL_Y = 46;
const xOf = (i: number) => X0 + i * STEP;

function RowLabel({ y, name, sub }: { y: number; name: string; sub: string }) {
  return (
    <g>
      <text
        x={24}
        y={y - 2}
        fontSize={13.5}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        {name}
      </text>
      <text
        x={24}
        y={y + 15}
        fontSize={11.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        {sub}
      </text>
    </g>
  );
}

function EndLabel({ x, y, t }: { x: number; y: number; t: string }) {
  return (
    <text
      x={x}
      y={y + 24}
      textAnchor="middle"
      fontSize={11.5}
      fontFamily={MONO}
      style={{ fill: BODY }}
    >
      {t}
    </text>
  );
}

/**
 * The three temporal-key shapes: `Time` (one instant), `TimeRange` (an
 * unlabeled span), `Interval` (a span that carries its bucket identity).
 */
export default function TemporalKeys() {
  const timeY = 108;
  const rangeY = 162;
  const intervalY = 222;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={svgStyle(860)}
      role="img"
      aria-label="Three temporal-key shapes on a timeline: Time as one instant at 00:05, TimeRange as an unlabeled span from 00:10 to 00:15, and Interval as a labeled span from 00:20 to 00:25 that carries the identity of the bucket that produced it"
    >
      {/* timeline */}
      <text
        x={24}
        y={TL_Y + 4}
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: INK }}
      >
        Timeline
      </text>
      <line
        x1={X0 - 40}
        y1={TL_Y}
        x2={xOf(TICKS.length - 1) + 42}
        y2={TL_Y}
        style={{ stroke: BODY }}
        strokeWidth={1.5}
      />
      <path
        d={`M ${xOf(TICKS.length - 1) + 40} ${TL_Y - 4.5} L ${xOf(TICKS.length - 1) + 50} ${TL_Y} L ${xOf(TICKS.length - 1) + 40} ${TL_Y + 4.5} Z`}
        style={{ fill: BODY }}
      />
      {TICKS.map((t, i) => (
        <g key={t}>
          <line
            x1={xOf(i)}
            y1={TL_Y - 4}
            x2={xOf(i)}
            y2={TL_Y + 4}
            style={{ stroke: BODY }}
            strokeWidth={1.5}
          />
          <text
            x={xOf(i)}
            y={TL_Y - 12}
            textAnchor="middle"
            fontSize={12}
            fontFamily={MONO}
            style={{ fill: BODY }}
          >
            {t}
          </text>
          <line
            x1={xOf(i)}
            y1={TL_Y + 8}
            x2={xOf(i)}
            y2={intervalY + 10}
            style={{ stroke: GRID }}
            strokeWidth={1}
            strokeDasharray="3 4"
          />
        </g>
      ))}

      {/* Time — one instant */}
      <RowLabel y={timeY} name="Time" sub="one instant" />
      <circle cx={xOf(1)} cy={timeY} r={6} style={{ fill: BLUE }} />
      <EndLabel x={xOf(1)} y={timeY} t="00:05" />

      {/* TimeRange — an unlabeled span */}
      <RowLabel y={rangeY} name="TimeRange" sub="an unlabeled span" />
      <g style={{ stroke: PINK }} fill="none" strokeWidth={2.25}>
        <line x1={xOf(2)} y1={rangeY - 8} x2={xOf(2)} y2={rangeY + 8} />
        <line x1={xOf(2)} y1={rangeY} x2={xOf(3)} y2={rangeY} />
        <line x1={xOf(3)} y1={rangeY - 8} x2={xOf(3)} y2={rangeY + 8} />
      </g>
      <EndLabel x={xOf(2)} y={rangeY} t="00:10" />
      <EndLabel x={xOf(3)} y={rangeY} t="00:15" />

      {/* Interval — a labeled span */}
      <RowLabel y={intervalY} name="Interval" sub="a labeled span" />
      <g style={{ stroke: TEAL }} fill="none" strokeWidth={2.25}>
        {/* [ closed start, ) open end — the half-open bucket it came from */}
        <path d={`M ${xOf(4) + 7} ${intervalY - 8} h -6 v 16 h 6`} />
        <line x1={xOf(4) + 1} y1={intervalY} x2={xOf(5) - 8} y2={intervalY} />
        <path d={`M ${xOf(5) - 9} ${intervalY - 8} q 7 8 0 16`} />
      </g>
      <g>
        <rect
          x={(xOf(4) + xOf(5)) / 2 - 34}
          y={intervalY - 34}
          width={68}
          height={21}
          rx={6}
          style={{
            fill: `color-mix(in srgb, ${TEAL} 12%, ${SURFACE})`,
            stroke: TEAL,
          }}
          strokeWidth={1}
        />
        <text
          x={(xOf(4) + xOf(5)) / 2}
          y={intervalY - 19}
          textAnchor="middle"
          fontSize={11}
          fontFamily={MONO}
          style={{ fill: INK }}
        >
          "label"
        </text>
      </g>
      <EndLabel x={xOf(4)} y={intervalY} t="00:20" />
      <EndLabel x={xOf(5)} y={intervalY} t="00:25" />
    </svg>
  );
}
