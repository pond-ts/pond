import {
  BASE,
  BODY,
  GRID,
  INK,
  KEY_TINT,
  MONO,
  SURFACE,
  SURFACE2,
  svgStyle,
} from './tokens';

const W = 860;
const H = 350;
const TX = 100; // table left
const TY = 66; // table top
const TW = 560; // table width
const HH = 50; // header height
const ROWH = 38;
const KEYW = 220;
const COLS = [
  { name: 'cpu', kind: '(num)', w: 100 },
  { name: 'requests', kind: '(num)', w: 120 },
  { name: 'host', kind: '(string)', w: 120 },
];
const ROWS = [
  ['00:00', '0.31', '120', 'dev23'],
  ['00:01', '0.44', '135', 'dev23'],
  ['00:02', '0.52', '141', 'dev18'],
  ['00:03', '0.48', '128', 'dev18'],
  ['00:04', '0.63', '166', 'dev02'],
];
const TH = HH + ROWS.length * ROWH; // table height

function Callout({ x, y, label }: { x: number; y: number; label: string[] }) {
  return (
    <g>
      <line
        x1={x + 64}
        y1={y}
        x2={x + 14}
        y2={y}
        style={{ stroke: BODY }}
        strokeWidth={1.25}
      />
      <path
        d={`M ${x + 17} ${y - 3.5} L ${x + 17} ${y + 3.5} L ${x + 10} ${y} Z`}
        style={{ fill: BODY }}
      />
      {label.map((l, i) => (
        <text
          key={l}
          x={x + 72}
          y={y + 4 + i * 15 - (label.length - 1) * 7.5}
          fontSize={12.5}
          fontFamily={BASE}
          style={{ fill: BODY }}
        >
          {l}
        </text>
      ))}
    </g>
  );
}

/** A `TimeSeries`: a named, schema-typed, ordered, immutable table of events. */
export default function TimeSeriesTable() {
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
      aria-label="TimeSeries: a named, schema-typed, ordered, immutable table of events; each row is an Event, the time column is the temporal key"
    >
      <defs>
        <clipPath id="ts-table-clip">
          <rect x={TX} y={TY} width={TW} height={TH} rx={9} />
        </clipPath>
      </defs>

      {/* name tab */}
      <rect
        x={TX}
        y={16}
        width={132}
        height={34}
        rx={7}
        style={{ fill: SURFACE2, stroke: GRID }}
        strokeWidth={1.25}
      />
      <text
        x={TX + 66}
        y={38}
        textAnchor="middle"
        fontSize={13.5}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        cpu-logs
      </text>
      <Callout x={TX + 132} y={33} label={['name']} />

      {/* table body fills + key-column tint (clipped to the rounded frame) */}
      <g clipPath="url(#ts-table-clip)">
        <rect x={TX} y={TY} width={TW} height={TH} style={{ fill: SURFACE }} />
        <rect x={TX} y={TY} width={TW} height={HH} style={{ fill: SURFACE2 }} />
        <rect
          x={TX}
          y={TY + HH}
          width={KEYW}
          height={TH - HH}
          style={{ fill: KEY_TINT }}
        />
      </g>

      {/* header */}
      <text
        x={TX + 20}
        y={TY + 22}
        fontSize={13}
        fontFamily={MONO}
        style={{ fill: INK }}
      >
        time
      </text>
      <text
        x={TX + 20}
        y={TY + 39}
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
            y={TY + 22}
            textAnchor="middle"
            fontSize={13}
            fontFamily={MONO}
            style={{ fill: INK }}
          >
            {c.name}
          </text>
          <text
            x={c.mid}
            y={TY + 39}
            textAnchor="middle"
            fontSize={11}
            fontFamily={MONO}
            style={{ fill: BODY }}
          >
            {c.kind}
          </text>
        </g>
      ))}
      <line
        x1={TX}
        y1={TY + HH}
        x2={TX + TW}
        y2={TY + HH}
        style={{ stroke: GRID }}
        strokeWidth={1.25}
      />

      {/* rows */}
      {ROWS.map((r, i) => {
        const y = TY + HH + i * ROWH + ROWH / 2 + 4.5;
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

      {/* column dividers + frame */}
      {cols.map((c) => (
        <line
          key={c.name}
          x1={c.x}
          y1={TY}
          x2={c.x}
          y2={TY + TH}
          style={{ stroke: GRID }}
          strokeWidth={1}
        />
      ))}
      <rect
        x={TX}
        y={TY}
        width={TW}
        height={TH}
        rx={9}
        fill="none"
        style={{ stroke: GRID }}
        strokeWidth={1.25}
      />

      {/* right-side callouts */}
      <Callout x={TX + TW} y={TY + 25} label={['schema']} />
      <Callout
        x={TX + TW}
        y={TY + HH + (TH - HH) / 2}
        label={['rows', '(Events)']}
      />

      {/* left bracket: ordered, immutable */}
      <path
        d={`M ${TX - 18} ${TY + HH + 6} h -7 V ${TY + TH - 6} h 7`}
        fill="none"
        style={{ stroke: BODY }}
        strokeWidth={1.25}
      />
      <text
        x={TX - 36}
        y={TY + HH + (TH - HH) / 2 - 4}
        textAnchor="end"
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        ordered,
      </text>
      <text
        x={TX - 36}
        y={TY + HH + (TH - HH) / 2 + 12}
        textAnchor="end"
        fontSize={12.5}
        fontFamily={BASE}
        style={{ fill: BODY }}
      >
        immutable
      </text>
    </svg>
  );
}
