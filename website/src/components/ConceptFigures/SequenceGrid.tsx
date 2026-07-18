import { BASE, BODY, GRID, INK, MONO, TEAL, svgStyle } from './tokens';

const W = 900;
const H = 216;
const X0 = 250; // 00:00
const STEP = 148; // 5s of timeline
const TICKS = ['00:00', '00:05', '00:10', '00:15', '00:20'];
const TL_Y = 46;
const SEQ_Y = 112;
const BSEQ_Y = 176;
const xOf = (i: number) => X0 + i * STEP;

/**
 * A `Sequence` is an infinite grid over the timeline; a `BoundedSequence`
 * is a finite slice of half-open `[start, end)` buckets.
 */
export default function SequenceGrid() {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={svgStyle(860)}
      role="img"
      aria-label="A timeline with Sequence.every('5s') boundaries every 5 seconds extending infinitely in both directions, and below it a BoundedSequence of four finite half-open buckets, each closed at the start and open at the end"
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
        x1={X0 - 62}
        y1={TL_Y}
        x2={xOf(TICKS.length - 1) + 52}
        y2={TL_Y}
        style={{ stroke: BODY }}
        strokeWidth={1.5}
      />
      <path
        d={`M ${xOf(TICKS.length - 1) + 50} ${TL_Y - 4.5} L ${xOf(TICKS.length - 1) + 60} ${TL_Y} L ${xOf(TICKS.length - 1) + 50} ${TL_Y + 4.5} Z`}
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
          {/* faint construction line down through the rows */}
          <line
            x1={xOf(i)}
            y1={TL_Y + 8}
            x2={xOf(i)}
            y2={BSEQ_Y + 14}
            style={{ stroke: GRID }}
            strokeWidth={1}
            strokeDasharray="3 4"
          />
        </g>
      ))}

      {/* Sequence.every('5s') — infinite grid */}
      <text
        x={24}
        y={SEQ_Y + 4}
        fontSize={13}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        Sequence.every('5s')
      </text>
      {TICKS.map((t, i) => (
        <line
          key={t}
          x1={xOf(i)}
          y1={SEQ_Y - 13}
          x2={xOf(i)}
          y2={SEQ_Y + 13}
          style={{ stroke: TEAL }}
          strokeWidth={1.75}
        />
      ))}
      {/* the grid keeps going both ways */}
      {[
        { x: X0 - STEP, anchor: 'start' as const },
        { x: xOf(TICKS.length - 1) + STEP, anchor: 'end' as const },
      ].map((e, i) => (
        <line
          key={i}
          x1={e.anchor === 'start' ? e.x + STEP - 34 : e.x - STEP + 34}
          y1={SEQ_Y}
          x2={e.anchor === 'start' ? X0 : xOf(TICKS.length - 1)}
          y2={SEQ_Y}
          style={{ stroke: TEAL, opacity: 0.45 }}
          strokeWidth={1.5}
          strokeDasharray="2 5"
        />
      ))}
      <text
        x={X0 - 46}
        y={SEQ_Y + 4}
        textAnchor="middle"
        fontSize={14}
        fontFamily={MONO}
        style={{ fill: BODY }}
      >
        …
      </text>
      <text
        x={xOf(TICKS.length - 1) + 46}
        y={SEQ_Y + 4}
        textAnchor="middle"
        fontSize={14}
        fontFamily={MONO}
        style={{ fill: BODY }}
      >
        …
      </text>
      {TICKS.slice(0, -1).map((t, i) => (
        <text
          key={t}
          x={xOf(i) + STEP / 2}
          y={SEQ_Y - 4}
          textAnchor="middle"
          fontSize={11}
          fontFamily={MONO}
          style={{ fill: BODY }}
        >
          5s
        </text>
      ))}

      {/* BoundedSequence — finite, half-open buckets */}
      <text
        x={24}
        y={BSEQ_Y + 4}
        fontSize={13}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        BoundedSequence
      </text>
      {TICKS.slice(0, -1).map((t, i) => {
        const a = xOf(i);
        const b = xOf(i + 1);
        return (
          <g key={t} style={{ stroke: TEAL }} fill="none">
            {/* [ closed start */}
            <path
              d={`M ${a + 8} ${BSEQ_Y - 9} h -6 v 18 h 6`}
              strokeWidth={1.75}
            />
            {/* span */}
            <line
              x1={a + 6}
              y1={BSEQ_Y}
              x2={b - 8}
              y2={BSEQ_Y}
              strokeWidth={1.75}
            />
            {/* ) open end */}
            <path
              d={`M ${b - 10} ${BSEQ_Y - 9} q 7 9 0 18`}
              strokeWidth={1.75}
            />
          </g>
        );
      })}
      <text
        x={xOf(0) + STEP / 2}
        y={BSEQ_Y + 26}
        textAnchor="middle"
        fontSize={11.5}
        fontFamily={MONO}
        style={{ fill: BODY }}
      >
        [start, end)
      </text>
    </svg>
  );
}
