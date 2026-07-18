import {
  BASE,
  BODY,
  GRID,
  INK,
  KEY_TINT,
  MARK,
  MONO,
  SURFACE,
  SURFACE2,
  svgStyle,
} from './tokens';

const W = 960;
const H = 520;
const TX = 190; // main column left
const TW = 560; // table width
const KEYW = 220;
const ROWH = 38;
const COLS = [
  { name: 'cpu', kind: '(num)', w: 100 },
  { name: 'requests', kind: '(num)', w: 120 },
  { name: 'host', kind: '(string)', w: 120 },
];
const ROWS = [
  ['00:45', '0.31', '120', 'dev23'],
  ['01:00', '0.44', '135', 'dev23'],
  ['01:15', '0.52', '141', 'dev18'],
  ['01:30', '0.48', '128', 'dev18'],
  ['01:45', '0.63', '166', 'dev02'],
];
const HDR_Y = 66; // schema header top
const HDR_H = 50;
const GHOSTS = [
  { time: '00:00', x: 30, y: 138, opacity: 0.4 },
  { time: '00:30', x: 62, y: 176, opacity: 0.65 },
];
const BUF_Y = 232; // buffer top
const BUF_H = ROWS.length * ROWH;
const IN_Y = 452; // incoming row top
// The vertical flow lane: inside both the loose rows (x 62–332) and the
// buffer (x 190–750), so the evict and push arrows read as one conveyor.
const FLOW_X = 260;

function GhostRow({
  x,
  y,
  time,
  opacity,
}: {
  x: number;
  y: number;
  time: string;
  opacity: number;
}) {
  return (
    <g opacity={opacity}>
      <rect
        x={x}
        y={y}
        width={270}
        height={30}
        rx={7}
        style={{ fill: SURFACE, stroke: GRID }}
        strokeWidth={1.25}
      />
      <rect
        x={x + 1}
        y={y + 1}
        width={78}
        height={28}
        rx={6}
        style={{ fill: KEY_TINT }}
      />
      <text
        x={x + 40}
        y={y + 20}
        textAnchor="middle"
        fontSize={12.5}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        {time}
      </text>
    </g>
  );
}

/**
 * A `LiveSeries`: a mutable, append-optimized buffer — events push in at the
 * tail while the retention policy discards the oldest.
 */
export default function LiveSeriesBuffer() {
  let cx = TX + KEYW;
  const cols = COLS.map((c) => {
    const col = { ...c, x: cx, mid: cx + c.w / 2 };
    cx += c.w;
    return col;
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={svgStyle(820)}
      role="img"
      aria-label="LiveSeries: a mutable, append-optimized buffer; events arrive over time, the retention policy discards the oldest events, and each push appends at the tail"
    >
      <defs>
        <clipPath id="live-buf-clip">
          <rect x={TX} y={BUF_Y} width={TW} height={BUF_H} rx={9} />
        </clipPath>
      </defs>

      {/* name tab */}
      <rect
        x={TX}
        y={16}
        width={148}
        height={34}
        rx={7}
        style={{ fill: SURFACE2, stroke: GRID }}
        strokeWidth={1.25}
      />
      <text
        x={TX + 74}
        y={38}
        textAnchor="middle"
        fontSize={13.5}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        host_stream
      </text>

      {/* schema header */}
      <rect
        x={TX}
        y={HDR_Y}
        width={TW}
        height={HDR_H}
        rx={9}
        style={{ fill: SURFACE2, stroke: GRID }}
        strokeWidth={1.25}
      />
      <text
        x={TX + 20}
        y={HDR_Y + 22}
        fontSize={13}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        time
      </text>
      <text
        x={TX + 20}
        y={HDR_Y + 39}
        fontSize={11}
        fontFamily={MONO}
        style={{ fill: BODY }}
      >
        (temporal key)
      </text>
      {cols.map((c) => (
        <g key={c.name}>
          <text
            x={c.mid}
            y={HDR_Y + 22}
            textAnchor="middle"
            fontSize={13}
            fontFamily={MONO}
            style={{ fill: INK }}
          >
            {c.name}
          </text>
          <text
            x={c.mid}
            y={HDR_Y + 39}
            textAnchor="middle"
            fontSize={11}
            fontFamily={MONO}
            style={{ fill: BODY }}
          >
            {c.kind}
          </text>
        </g>
      ))}
      <text
        x={TX + TW + 24}
        y={HDR_Y + 21}
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        schema — same
      </text>
      <text
        x={TX + TW + 24}
        y={HDR_Y + 37}
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        shape as TimeSeries
      </text>

      {/* evicted ghosts drifting out */}
      {GHOSTS.map((g) => (
        <GhostRow key={g.time} {...g} />
      ))}
      {/* evict: straight up out of the buffer to the 00:30 ghost */}
      <line
        x1={FLOW_X}
        y1={BUF_Y - 6}
        x2={FLOW_X}
        y2={GHOSTS[1].y + 30 + 12}
        style={{ stroke: MARK }}
        strokeWidth={1.75}
      />
      <path
        d={`M ${FLOW_X - 4.5} ${GHOSTS[1].y + 30 + 13} L ${FLOW_X + 4.5} ${GHOSTS[1].y + 30 + 13} L ${FLOW_X} ${GHOSTS[1].y + 30 + 4} Z`}
        style={{ fill: MARK }}
      />
      <text
        x={GHOSTS[1].x + 320}
        y={GHOSTS[0].y + 28}
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        retention policy discards the oldest
      </text>

      {/* the buffer */}
      <g clipPath="url(#live-buf-clip)">
        <rect
          x={TX}
          y={BUF_Y}
          width={TW}
          height={BUF_H}
          style={{ fill: SURFACE }}
        />
        <rect
          x={TX}
          y={BUF_Y}
          width={KEYW}
          height={BUF_H}
          style={{ fill: KEY_TINT }}
        />
      </g>
      {ROWS.map((r, i) => {
        const y = BUF_Y + i * ROWH + ROWH / 2 + 4.5;
        return (
          <g key={r[0]}>
            <text
              x={TX + 20}
              y={y}
              fontSize={13}
              fontFamily={MONO}
              style={{ fill: INK }}
            >
              {r[0]}
            </text>
            {cols.map((c, j) => (
              <text
                key={c.name}
                x={c.mid}
                y={y}
                textAnchor="middle"
                fontSize={13}
                fontFamily={MONO}
                style={{ fill: INK }}
              >
                {r[j + 1]}
              </text>
            ))}
          </g>
        );
      })}
      {cols.map((c) => (
        <line
          key={c.name}
          x1={c.x}
          y1={BUF_Y}
          x2={c.x}
          y2={BUF_Y + BUF_H}
          style={{ stroke: GRID }}
          strokeWidth={1}
        />
      ))}
      <rect
        x={TX}
        y={BUF_Y}
        width={TW}
        height={BUF_H}
        rx={9}
        fill="none"
        style={{ stroke: GRID }}
        strokeWidth={1.25}
      />
      <text
        x={TX + TW + 24}
        y={BUF_Y + BUF_H / 2 - 4}
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        rows
      </text>
      <text
        x={TX + TW + 24}
        y={BUF_Y + BUF_H / 2 + 12}
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        (Events)
      </text>

      {/* left bracket */}
      <path
        d={`M ${TX - 18} ${BUF_Y + 6} h -7 V ${BUF_Y + BUF_H - 6} h 7`}
        fill="none"
        style={{ stroke: BODY }}
        strokeWidth={1.25}
      />
      {['ordered,', 'append-optimized,', 'bounded retention'].map((l, i) => (
        <text
          key={l}
          x={TX - 36}
          y={BUF_Y + BUF_H / 2 - 12 + i * 16}
          textAnchor="end"
          fontSize={12.5}
          fontFamily={BASE}
          style={{ fill: BODY }}
        >
          {l}
        </text>
      ))}

      {/* incoming push — same lane as the 00:30 ghost, straight up into the tail */}
      <GhostRow x={GHOSTS[1].x} y={IN_Y} time="02:00" opacity={1} />
      <line
        x1={FLOW_X}
        y1={IN_Y - 6}
        x2={FLOW_X}
        y2={BUF_Y + BUF_H + 12}
        style={{ stroke: MARK }}
        strokeWidth={1.75}
      />
      <path
        d={`M ${FLOW_X - 4.5} ${BUF_Y + BUF_H + 13} L ${FLOW_X + 4.5} ${BUF_Y + BUF_H + 13} L ${FLOW_X} ${BUF_Y + BUF_H + 4} Z`}
        style={{ fill: MARK }}
      />
      <text
        x={GHOSTS[1].x + 290}
        y={IN_Y + 20}
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        push appends at the tail
      </text>
    </svg>
  );
}
