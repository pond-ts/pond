import { useContext, type CSSProperties, type ReactNode } from 'react';
import { ContainerContext, RowContext } from './context.js';
import type { LegendItemInput, SwatchSpec } from './swatch.js';
import { buildChartLegend } from './useChartLegend.js';
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
  items?: readonly LegendItemInput[];
  /**
   * Row click. **Omitted ⇒ the id-gated default:** a row whose layer has an
   * `id` toggles the container selection (the same `select()` path a mark
   * click uses); rows without an `id` are inert. Provide to take over (e.g.
   * a consumer-side show/hide toggle — visibility stays consumer-side by
   * design, a legend mutating composition would be a second styling channel).
   */
  onRowClick?: (row: LegendItemInput) => void;
  /**
   * Row hover (`null` on leave). **Omitted ⇒ the id-gated default:** hovering
   * a row with an `id` echoes into the container's `hovered` channel — the
   * same one an in-plot hover drives — and clears on leave.
   */
  onRowHover?: (row: LegendItemInput | null) => void;
  /** Theme for the **standalone** (`items`, outside-a-container) mode, where
   *  there is no frame to read one from. **Omitted ⇒ the container's theme,
   *  else {@link defaultTheme}.** */
  theme?: ChartTheme;
}

/** One 20×12 swatch glyph, drawn from the layer's resolved style. */
function SwatchGlyph({ spec }: { spec: SwatchSpec }): ReactNode {
  const w = 20;
  const h = 12;
  const mid = h / 2;
  switch (spec.kind) {
    case 'line': {
      const sw = Math.min(spec.width, 4);
      // A dashed series hand-renders as exactly THREE dashes — a canonical
      // "dashed" glyph at swatch scale — rather than scaling the layer's own
      // dash cadence into 20px (which can alias to 1 or 7 dashes and stop
      // reading as dashed at all). Colour/width stay the resolved style.
      if (spec.dash && spec.dash.length > 0) {
        return (
          <g stroke={spec.color} strokeWidth={sw} strokeLinecap="butt">
            <line x1={0} y1={mid} x2={4.6} y2={mid} />
            <line x1={7.7} y1={mid} x2={12.3} y2={mid} />
            <line x1={15.4} y1={mid} x2={w} y2={mid} />
          </g>
        );
      }
      return (
        <line
          x1={0}
          y1={mid}
          x2={w}
          y2={mid}
          stroke={spec.color}
          strokeWidth={sw}
        />
      );
    }
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
      // A centred rounded square — reads as "a fill" without pretending to be
      // a bar of any particular width (#512 follow-up feedback, second pass:
      // centred in the swatch box like the other glyphs).
      return (
        <rect
          x={(w - 10) / 2}
          y={1}
          width={10}
          height={10}
          rx={2}
          fill={spec.fill}
        />
      );
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

/** The card's corner offsets — anchored to the **plot area**, not the rows
 *  block: the horizontal inset adds the container's axis gutter on that side,
 *  so a left placement never sits over the y-axis labels (#512 follow-up
 *  feedback). Vertically the rows block already IS the plot (the x-axis strip
 *  renders outside it). */
function placementStyle(
  placement: LegendPlacement,
  leftGutter: number,
  rightGutter: number,
): CSSProperties {
  switch (placement) {
    case 'top-left':
      return { top: 8, left: leftGutter + 8 };
    case 'top-right':
      return { top: 8, right: rightGutter + 8 };
    case 'bottom-left':
      return { bottom: 8, left: leftGutter + 8 };
    case 'bottom-right':
      return { bottom: 8, right: rightGutter + 8 };
  }
}

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
 * - **Scope follows placement:** at the container level it lists **all** rows;
 *   placed inside a `<Layers>` it **scopes to that `<ChartRow>`** and anchors
 *   to that row's plot (like an annotation) — a per-row legend needs no prop.
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
  // A RowContext in scope (the card is inside a <Layers>) narrows the registry
  // to that row's layers AND means we're already inside the row's plot cell —
  // so the corner inset drops the axis gutter (see placementStyle below).
  const row = useContext(RowContext);
  const theme = themeProp ?? container?.theme ?? defaultTheme;
  const slot = theme.legend ?? {
    background: theme.chip?.background ?? '#ffffff',
    border: theme.axis.grid,
    text: theme.axis.label,
  };

  // The shared headless core (also `useChartLegend`'s) — rows + the id-gated
  // hover/select verbs — so the built-in card and a custom-rendered legend
  // can never disagree. `null` in standalone `items` mode (no chart to sync).
  const legend =
    container !== null ? buildChartLegend(container, row?.rowKey) : null;
  // The card renders a flat item list — `rows` is grouped by chart row, so
  // flatten it (a scoped legend has one group anyway).
  const entries: readonly LegendItemInput[] =
    items ?? legend!.rows.flatMap((r) => r.items);
  if (entries.length === 0) return null;
  // Selection reads by CONTRAST: the selected item goes bold and every other
  // dulls (the ticker-compare treatment) — quieter and clearer than
  // decorating the selected item itself. Only when the selection points at an
  // item of THIS legend, so selecting an off-legend mark dulls nothing.
  const selectedId = container?.selected?.id;
  const anySelected =
    selectedId !== undefined && entries.some((it) => it.id === selectedId);

  const enter = (item: LegendItemInput) => {
    if (onRowHover) return onRowHover(item);
    legend?.hover(item);
  };
  const leave = (item: LegendItemInput) => {
    if (onRowHover) return onRowHover(null);
    if (item.id !== undefined) legend?.hover(null);
  };
  const click = (item: LegendItemInput) => {
    if (onRowClick) return onRowClick(item);
    legend?.select(item);
  };

  // Standalone (no container): a normal-flow card the consumer places.
  const positioned = container !== null;
  return (
    <div
      data-legend=""
      style={{
        ...(positioned
          ? {
              position: 'absolute',
              // Row-scoped (inside the plot cell): no gutter inset — the cell
              // already starts at the plot edge. Container-level: inset by the
              // axis gutter so the card clears the y-axis labels.
              ...placementStyle(
                placement,
                row !== null ? 0 : container!.leftGutter,
                row !== null ? 0 : container!.rightGutter,
              ),
              zIndex: 5,
            }
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
      {entries.map((item) => {
        const interactive =
          onRowClick !== undefined ||
          onRowHover !== undefined ||
          (item.id !== undefined && container !== null);
        const selected =
          item.id !== undefined && container?.selected?.id === item.id;
        const hovered =
          item.id !== undefined && container?.hovered?.id === item.id;
        return (
          <div
            // Composite key: a multi-group layer (a stack) gives every segment
            // the SAME `id`, so keying on `id` alone would collide — the group
            // `label` disambiguates within the shared id (labels are unique
            // per stack position; a lone id-less layer keys on its label).
            key={item.id !== undefined ? `${item.id} ${item.label}` : item.label}
            onPointerEnter={() => enter(item)}
            onPointerLeave={() => leave(item)}
            onClick={() => click(item)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              cursor: interactive ? 'pointer' : 'default',
              fontWeight: selected ? 600 : 400,
              opacity: anySelected && !selected ? 0.45 : 1,
              background: hovered ? slot.border : 'transparent',
              borderRadius: 2,
              padding: '0 2px',
            }}
          >
            <svg width={20} height={12} style={{ flex: 'none' }}>
              <SwatchGlyph spec={item.swatch} />
            </svg>
            <span>{item.label}</span>
          </div>
        );
      })}
    </div>
  );
}
