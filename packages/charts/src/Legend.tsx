import { useContext, type CSSProperties, type ReactNode } from 'react';
import { ContainerContext, type SelectInfo } from './context.js';
import {
  orderLegendRows,
  type LegendItemSpec,
  type LegendRowInput,
  type SwatchSpec,
} from './swatch.js';
import { defaultTheme, type ChartTheme } from './theme.js';

/** Where the in-container legend card anchors, relative to the rows block. */
export type LegendPlacement =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

export interface LegendProps {
  /**
   * Which corner of the **rows block** the card anchors to (8px inset).
   * **Omitted ⇒ `'top-right'`.** Ignored in standalone `items` mode outside a
   * container, where the card renders in normal flow (the consumer places it).
   */
  placement?: LegendPlacement;
  /**
   * **Escape hatch — explicit rows.** Renders exactly these (in order, no
   * dedup) instead of the container's registry, and works **outside** a
   * `<ChartContainer>` (a dashboard-side key). Each row is a `label` +
   * resolved {@link SwatchSpec} (+ optional `id` for the interactions).
   */
  items?: readonly LegendRowInput[];
  /**
   * Row click. **Omitted ⇒ the id-gated default:** a row whose layer has an
   * `id` toggles the container selection (the same `select()` path a mark
   * click uses); rows without an `id` are inert. Provide to take over (e.g.
   * a consumer-side show/hide toggle — visibility stays consumer-side by
   * design, a legend mutating composition would be a second styling channel).
   */
  onRowClick?: (row: LegendRowInput) => void;
  /**
   * Row hover (`null` on leave). **Omitted ⇒ the id-gated default:** hovering
   * a row with an `id` echoes into the container's `hovered` channel — the
   * same one an in-plot hover drives — and clears on leave.
   */
  onRowHover?: (row: LegendRowInput | null) => void;
  /** Theme for the **standalone** (`items`, outside-a-container) mode, where
   *  there is no frame to read one from. **Omitted ⇒ the container's theme,
   *  else {@link defaultTheme}.** */
  theme?: ChartTheme;
}

/** The swatch's primary colour — what a series-scoped `SelectInfo` reports. */
function swatchColor(s: SwatchSpec): string {
  switch (s.kind) {
    case 'line':
      return s.color;
    case 'area':
      return s.line;
    case 'band':
      return s.fill;
    case 'scatter':
      return s.color;
    case 'box':
      return s.whisker;
    case 'bar':
      return s.fill;
    case 'candle':
      return s.up;
  }
}

/** One 20×12 swatch glyph, drawn from the layer's resolved style. */
function SwatchGlyph({ spec }: { spec: SwatchSpec }): ReactNode {
  const w = 20;
  const h = 12;
  const mid = h / 2;
  switch (spec.kind) {
    case 'line':
      return (
        <line
          x1={0}
          y1={mid}
          x2={w}
          y2={mid}
          stroke={spec.color}
          strokeWidth={Math.min(spec.width, 4)}
          strokeDasharray={
            spec.dash && spec.dash.length > 0 ? spec.dash.join(' ') : undefined
          }
        />
      );
    case 'area':
      return (
        <g>
          <rect
            x={0}
            y={3}
            width={w}
            height={h - 3}
            fill={spec.fill}
            fillOpacity={spec.fillOpacity}
          />
          <line
            x1={0}
            y1={3}
            x2={w}
            y2={3}
            stroke={spec.line}
            strokeWidth={1.5}
          />
        </g>
      );
    case 'band':
      return (
        <rect
          x={0}
          y={2}
          width={w}
          height={h - 4}
          fill={spec.fill}
          fillOpacity={spec.opacity}
        />
      );
    case 'scatter': {
      const r = Math.min(spec.radius, 5);
      return (
        <circle
          cx={w / 2}
          cy={mid}
          r={r}
          fill={spec.color}
          stroke={spec.outline}
          strokeWidth={spec.outline !== undefined ? 1 : 0}
        />
      );
    }
    case 'box': {
      const sw = Math.min(spec.whiskerWidth, 3);
      return (
        <g stroke={spec.whisker} strokeWidth={sw}>
          <line x1={w / 2} y1={1} x2={w / 2} y2={h - 1} />
          <line x1={w / 2 - 4} y1={1} x2={w / 2 + 4} y2={1} />
          <line x1={w / 2 - 4} y1={h - 1} x2={w / 2 + 4} y2={h - 1} />
        </g>
      );
    }
    case 'bar':
      return <rect x={2} y={2} width={w - 4} height={h - 4} fill={spec.fill} />;
    case 'candle':
      return (
        <g>
          <line
            x1={5.5}
            y1={0}
            x2={5.5}
            y2={h}
            stroke={spec.up}
            strokeWidth={1}
          />
          <rect x={3} y={2} width={5} height={h - 5} fill={spec.up} />
          <line
            x1={14.5}
            y1={0}
            x2={14.5}
            y2={h}
            stroke={spec.down}
            strokeWidth={1}
          />
          <rect x={12} y={3} width={5} height={h - 5} fill={spec.down} />
        </g>
      );
  }
}

const PLACEMENT_STYLE: Record<LegendPlacement, CSSProperties> = {
  'top-left': { top: 8, left: 8 },
  'top-right': { top: 8, right: 8 },
  'bottom-left': { bottom: 8, left: 8 },
  'bottom-right': { bottom: 8, right: 8 },
};

/**
 * The **series key** — one row per registered draw layer: a swatch of the
 * layer's *resolved* style (so the key can never drift from the plot) and its
 * readout identity (`as ?? column`, or the layer's `legend="name"` override).
 * A child of {@link ChartContainer} (anywhere — it reads the registry, not its
 * position): renders a small card anchored to a corner of the rows block.
 *
 * - **Rows** follow chart-row order, then declaration order (the z-order
 *   convention); two layers sharing an identity (`id ?? label`) collapse to
 *   one row, exactly as the tracker readout merges keys.
 * - **A layer opts out** with `legend={false}`, or renames its row with
 *   `legend="Display name"`.
 * - **Interactivity is id-gated** (the selection contract): rows whose layer
 *   has an `id` echo hover into the container and toggle selection on click;
 *   `onRowHover` / `onRowClick` take over when provided. The selected row
 *   reads emphasized; the hovered row tints.
 * - **Standalone mode:** `<Legend items={…}>` renders explicit rows — inside
 *   a container (replacing the registry) or entirely outside one (a
 *   dashboard-side key; pass `theme` there).
 */
export function Legend({
  placement = 'top-right',
  items,
  onRowClick,
  onRowHover,
  theme: themeProp,
}: LegendProps) {
  const container = useContext(ContainerContext);
  if (container === null && items === undefined) {
    throw new Error(
      '<Legend> must be inside a <ChartContainer> (or be given explicit `items`)',
    );
  }
  const theme = themeProp ?? container?.theme ?? defaultTheme;
  const slot = theme.legend ?? {
    background: theme.chip?.background ?? '#ffffff',
    border: theme.axis.grid,
    text: theme.axis.label,
  };

  const rows: readonly (LegendRowInput | LegendItemSpec)[] =
    items ??
    orderLegendRows(container!.legendItems.values(), container!.rowOrder);
  if (rows.length === 0) return null;

  // Series-scoped SelectInfo for the default id-gated interactions: the legend
  // has no sample under it, so the provenance fields are deliberately NaN
  // (documented on SelectInfo: key/value are provenance, id is the identity).
  const infoOf = (row: LegendRowInput): SelectInfo => ({
    id: row.id!,
    key: NaN,
    value: NaN,
    color: swatchColor(row.swatch),
    label: row.label,
  });
  const enter = (row: LegendRowInput) => {
    if (onRowHover) return onRowHover(row);
    if (row.id !== undefined) container?.setHovered(infoOf(row));
  };
  const leave = (row: LegendRowInput) => {
    if (onRowHover) return onRowHover(null);
    if (row.id !== undefined) container?.setHovered(null);
  };
  const click = (row: LegendRowInput) => {
    if (onRowClick) return onRowClick(row);
    if (row.id === undefined || container === null) return;
    container.select(container.selected?.id === row.id ? null : infoOf(row));
  };

  // Standalone (no container): a normal-flow card the consumer places.
  const positioned = container !== null;
  return (
    <div
      data-legend=""
      style={{
        ...(positioned
          ? { position: 'absolute', ...PLACEMENT_STYLE[placement], zIndex: 5 }
          : { display: 'inline-block' }),
        background: slot.background,
        border: `1px solid ${slot.border}`,
        borderRadius: 4,
        padding: '4px 8px',
        font: `${theme.font.size}px ${theme.font.family}`,
        color: slot.text,
        lineHeight: 1.6,
      }}
    >
      {rows.map((row) => {
        const interactive =
          onRowClick !== undefined ||
          onRowHover !== undefined ||
          (row.id !== undefined && container !== null);
        const selected =
          row.id !== undefined && container?.selected?.id === row.id;
        const hovered =
          row.id !== undefined && container?.hovered?.id === row.id;
        return (
          <div
            key={row.id ?? row.label}
            onPointerEnter={() => enter(row)}
            onPointerLeave={() => leave(row)}
            onClick={() => click(row)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              cursor: interactive ? 'pointer' : 'default',
              fontWeight: selected ? 600 : 400,
              background: hovered ? slot.border : 'transparent',
              borderRadius: 2,
              padding: '0 2px',
            }}
          >
            <svg width={20} height={12} style={{ flex: 'none' }}>
              <SwatchGlyph spec={row.swatch} />
            </svg>
            <span>{row.label}</span>
          </div>
        );
      })}
    </div>
  );
}
