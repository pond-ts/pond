import { BASE, BLUE, BODY, GRID, INK, MONO, WASH, svgStyle } from './tokens';

const W = 960;
const H = 384;
const X2 = 330; // 02:00
const PXH = 140; // px per hour
const xOf = (h: number) => X2 + (h - 2) * PXH;
const QY = 78;
const ROWS_TOP = 64;
const ROWS_BOT = 278;
const RESULT_Y = 320;

const EVENTS = [
  {
    id: 'a',
    label: 'Time @ 01:59',
    y: 122,
    kind: 'point' as const,
    at: 1 + 59 / 60,
    note: '(outside — 1 min early)',
    noteSide: 'left' as const,
  },
  {
    id: 'b',
    label: 'Time @ 03:00',
    y: 156,
    kind: 'point' as const,
    at: 3,
    note: '(inside)',
    noteSide: 'right' as const,
  },
  {
    id: 'c',
    label: 'TimeRange 01:30–02:30',
    y: 190,
    kind: 'span' as const,
    from: 1.5,
    to: 2.5,
    note: '(straddles the start)',
  },
  {
    id: 'd',
    label: 'TimeRange 03:00–04:00',
    y: 224,
    kind: 'span' as const,
    from: 3,
    to: 4,
    note: '(contained)',
  },
  {
    id: 'e',
    label: 'TimeRange 04:30–05:30',
    y: 258,
    kind: 'span' as const,
    from: 4.5,
    to: 5.5,
    note: '(straddles the end)',
  },
];

/** One span segment, faded where it lies outside the query range. */
function Span({ y, from, to }: { y: number; from: number; to: number }) {
  const clips: Array<{ a: number; b: number; inside: boolean }> = [];
  const lo = Math.max(from, 2);
  const hi = Math.min(to, 5);
  if (from < 2) clips.push({ a: from, b: Math.min(to, 2), inside: false });
  if (lo < hi) clips.push({ a: lo, b: hi, inside: true });
  if (to > 5) clips.push({ a: Math.max(from, 5), b: to, inside: false });
  return (
    <g style={{ stroke: BLUE }} strokeWidth={2.25} fill="none">
      {clips.map((c, i) => (
        <line
          key={i}
          x1={xOf(c.a)}
          y1={y}
          x2={xOf(c.b)}
          y2={y}
          opacity={c.inside ? 1 : 0.35}
          strokeDasharray={c.inside ? undefined : '4 4'}
        />
      ))}
      <line
        x1={xOf(from)}
        y1={y - 7}
        x2={xOf(from)}
        y2={y + 7}
        opacity={from < 2 || from > 5 ? 0.35 : 1}
      />
      <line
        x1={xOf(to)}
        y1={y - 7}
        x2={xOf(to)}
        y2={y + 7}
        opacity={to < 2 || to > 5 ? 0.35 : 1}
      />
    </g>
  );
}

/**
 * The three temporal relations — `within`, `overlapping`, `trim` — as five
 * test events against a query range. The faded, dashed portions are the
 * parts of a span that lie outside the range (what `trim` clips away).
 */
export default function SelectionRelations() {
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={svgStyle(880)}
      role="img"
      aria-label="Five test events against a query range from 02:00 to 05:00: within keeps b and d; overlapping keeps b, c, d, and e; trim keeps b and d unchanged, clips c to 02:00–02:30 and e to 04:30–05:00. The dashed portions of c and e are the parts outside the range that trim clips away."
    >
      {/* hour ticks + construction lines */}
      {['02:00', '03:00', '04:00', '05:00'].map((t, i) => (
        <g key={t}>
          <text
            x={xOf(2 + i)}
            y={30}
            textAnchor="middle"
            fontSize={12}
            fontFamily={MONO}
            style={{ fill: BODY }}
          >
            {t}
          </text>
          <line
            x1={xOf(2 + i)}
            y1={38}
            x2={xOf(2 + i)}
            y2={ROWS_BOT}
            style={{ stroke: GRID }}
            strokeWidth={1}
            strokeDasharray="3 4"
          />
        </g>
      ))}

      {/* the "inside the range" wash */}
      <rect
        x={xOf(2)}
        y={ROWS_TOP}
        width={xOf(5) - xOf(2)}
        height={ROWS_BOT - ROWS_TOP}
        style={{ fill: WASH }}
      />

      {/* query range */}
      <text
        x={24}
        y={QY + 4}
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: INK }}
      >
        Query range
      </text>
      <g style={{ stroke: INK }} strokeWidth={2.25} fill="none">
        <path d={`M ${xOf(2) + 7} ${QY - 8} h -6 v 16 h 6`} />
        <line x1={xOf(2) + 1} y1={QY} x2={xOf(5) - 1} y2={QY} />
        <path d={`M ${xOf(5) - 7} ${QY - 8} h 6 v 16 h -6`} />
      </g>

      {/* events */}
      {EVENTS.map((e) => (
        <g key={e.id}>
          <text x={24} y={e.y + 4} fontSize={12.5} fontFamily={MONO}>
            <tspan style={{ fill: INK }}>{e.id}</tspan>
            <tspan style={{ fill: BODY }}>{'  ' + e.label}</tspan>
          </text>
          {e.kind === 'point' ? (
            <>
              <circle cx={xOf(e.at)} cy={e.y} r={5.5} style={{ fill: BLUE }} />
              <text
                x={e.noteSide === 'left' ? xOf(e.at) - 14 : xOf(e.at) + 14}
                y={e.y + 4}
                textAnchor={e.noteSide === 'left' ? 'end' : 'start'}
                fontSize={11.5}
                fontFamily={BASE}
                style={{ fill: BODY }}
              >
                {e.note}
              </text>
            </>
          ) : (
            <>
              <Span y={e.y} from={e.from!} to={e.to!} />
              <text
                x={xOf(e.to!) + 14}
                y={e.y + 4}
                fontSize={11.5}
                fontFamily={BASE}
                style={{ fill: BODY }}
              >
                {e.note}
              </text>
            </>
          )}
        </g>
      ))}

      {/* results */}
      {[
        { call: 'within(range)', result: 'b, d' },
        { call: 'overlapping(range)', result: 'b, c, d, e' },
        {
          call: 'trim(range)',
          result:
            'b, d unchanged · c clipped to 02:00–02:30 · e clipped to 04:30–05:00',
        },
      ].map((r, i) => (
        <g key={r.call} fontFamily={MONO} fontSize={12.5}>
          <text
            x={400}
            y={RESULT_Y + i * 22}
            textAnchor="end"
            style={{ fill: INK }}
          >
            {r.call}
          </text>
          <text x={412} y={RESULT_Y + i * 22} style={{ fill: BODY }}>
            →
          </text>
          <text x={434} y={RESULT_Y + i * 22} style={{ fill: BODY }}>
            {r.result}
          </text>
        </g>
      ))}
    </svg>
  );
}
