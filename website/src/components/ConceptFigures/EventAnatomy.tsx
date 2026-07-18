import {
  BASE,
  BODY,
  GRID,
  INK,
  KEY_TINT,
  MONO,
  SURFACE,
  svgStyle,
} from './tokens';

const W = 720;
const H = 180;
const X = 30; // row left
const Y = 46; // row top
const RW = 660; // row width
const RH = 46; // row height
const KEYW = 252; // temporal-key cell width
const COLS = [
  { label: 'cpu', value: '0.44', w: 130 },
  { label: 'requests', value: '135', w: 140 },
  { label: 'host', value: 'dev23', w: 138 },
];

/** Anatomy of an `Event`: a temporal key plus a schema-typed payload. */
export default function EventAnatomy() {
  let cx = X + KEYW;
  const cols = COLS.map((c) => {
    const col = { ...c, x: cx, mid: cx + c.w / 2 };
    cx += c.w;
    return col;
  });
  const keyMid = X + KEYW / 2;
  const payloadMid = cols[1].mid;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={svgStyle(680)}
      role="img"
      aria-label="Event: a temporal key plus a typed payload — the key (Time, TimeRange, or Interval) on the left, schema-typed data columns on the right"
    >
      <defs>
        <clipPath id="event-row-clip">
          <rect x={X} y={Y} width={RW} height={RH} rx={9} />
        </clipPath>
      </defs>

      <text
        x={X}
        y={24}
        fontSize={13.5}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        Event
      </text>

      {/* column headers over the payload cells */}
      {cols.map((c) => (
        <text
          key={c.label}
          x={c.mid}
          y={38}
          textAnchor="middle"
          fontSize={11.5}
          fontFamily={MONO}
          style={{ fill: BODY }}
        >
          {c.label}
        </text>
      ))}

      {/* the row: tinted key cell + payload cells inside one rounded frame */}
      <g clipPath="url(#event-row-clip)">
        <rect x={X} y={Y} width={RW} height={RH} style={{ fill: SURFACE }} />
        <rect x={X} y={Y} width={KEYW} height={RH} style={{ fill: KEY_TINT }} />
      </g>
      <rect
        x={X}
        y={Y}
        width={RW}
        height={RH}
        rx={9}
        fill="none"
        style={{ stroke: GRID }}
        strokeWidth={1.25}
      />
      {cols.map((c) => (
        <line
          key={c.label}
          x1={c.x}
          y1={Y}
          x2={c.x}
          y2={Y + RH}
          style={{ stroke: GRID }}
          strokeWidth={1}
        />
      ))}

      <text
        x={keyMid}
        y={Y + 29}
        textAnchor="middle"
        fontSize={14}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        1 Jan 2025 14:00:00
      </text>
      {cols.map((c) => (
        <text
          key={c.label}
          x={c.mid}
          y={Y + 29}
          textAnchor="middle"
          fontSize={14}
          fontFamily={MONO}
          style={{ fill: INK }}
        >
          {c.value}
        </text>
      ))}

      {/* callouts */}
      {[
        { x: keyMid, label: 'temporal key' },
        { x: payloadMid, label: 'payload' },
      ].map((c) => (
        <g key={c.label}>
          <line
            x1={c.x}
            y1={Y + RH + 26}
            x2={c.x}
            y2={Y + RH + 9}
            style={{ stroke: BODY }}
            strokeWidth={1.25}
          />
          <path
            d={`M ${c.x - 3.5} ${Y + RH + 12} L ${c.x + 3.5} ${Y + RH + 12} L ${c.x} ${Y + RH + 5} Z`}
            style={{ fill: BODY }}
          />
          <text
            x={c.x}
            y={Y + RH + 44}
            textAnchor="middle"
            fontSize={12.5}
            fontFamily={BASE}
            style={{ fill: BODY }}
          >
            {c.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
