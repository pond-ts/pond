import { useContext, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Sequence, BoundedSequence } from 'pond-ts';
import {
  ContainerContext,
  RowContext,
  type SelectInfo,
  type SelectModifiers,
  type SelectorEntry,
  type SpanSelection,
} from './context.js';
import { useSlotKey } from './use-slot-key.js';

/**
 * `<Selector>` — **click-select as a mounted component** (interaction RFC §7 /
 * A4.2), the successor to `<ChartContainer onSelect>` / `onHover`.
 *
 * Two rules govern it, and they pull in opposite directions on purpose:
 *
 * 1. **Mounting is what enables the plot gesture** (§7.1). With no `<Selector>`
 *    mounted a click on the plot does nothing — selection is a subsystem
 *    (modifiers, a set, a dim slot, precedence against hover) and it should not
 *    switch itself on because a layer happened to be given an `id`.
 * 2. **The selector reports; the container holds the state** (A1.2).
 *    `selected` / `hovered` stay on `<ChartContainer>`, so controlled
 *    highlighting — a legend chip, an external filter list — keeps working with
 *    **no** `<Selector>` mounted at all. The break narrows to precisely the
 *    thing being made intentional: the plot gesture.
 *
 * A layer `id` is *identity*, the mount is *enablement* (Q8): an untagged layer
 * is never hit-tested, so a click on one is a `null` hit — the same value as a
 * click on empty space, which is already the deselect path. `SelectInfo.id` is
 * therefore never undefined.
 */

/** The reporting callbacks, held in a ref so a consumer's inline arrow doesn't
 *  re-register the entry on every render. The plural pair is `<MultiSelector>`'s
 *  (RFC §8 / A5.2); the singular pair is `<Selector>`'s and the shim's. */
interface SelectorCallbacks {
  readonly onHover: ((hit: SelectInfo | null) => void) | undefined;
  readonly onSelect:
    | ((hit: SelectInfo | null, modifiers?: SelectModifiers) => void)
    | undefined;
  readonly onHoverMany?: ((hits: readonly SelectInfo[]) => void) | undefined;
  readonly onSelectMany?:
    | ((
        hits: readonly SelectInfo[],
        modifiers: SelectModifiers | undefined,
        spans: readonly SpanSelection[],
      ) => void)
    | undefined;
}

/**
 * Register a selector with the container, scoped to the enclosing `<ChartRow>`
 * when there is one (that row's clicks only) else the container (every row).
 *
 * The registered entry is memoized on which callbacks are *present*, not on
 * their identity — the callbacks are read through a ref at report time. A
 * consumer writing `<Selector onSelect={(hit) => setSel(hit)} />` passes a
 * fresh function every render, and re-registering on each one would thrash the
 * container's registry state (and, since the registry is `useState`, loop).
 */
function useSelectorMount(
  cb: SelectorCallbacks,
  legacy: boolean,
  /** `false` registers nothing — the shim's "neither legacy prop is set" case,
   *  which is what makes "no selector mounted" detectable at all. */
  enabled: boolean,
  /** A `<MultiSelector>` mount — arms the sweep drag alongside the click. */
  multi = false,
  /** `<MultiSelector sequence>` — the sweep's bucket snap. */
  sequence?: Sequence | BoundedSequence,
): void {
  const container = useContext(ContainerContext);
  if (container === null) {
    throw new Error(
      '<Selector> must be mounted inside a <ChartContainer> (as a direct ' +
        'child, or inside a <ChartRow> to scope it to that row)',
    );
  }
  const row = useContext(RowContext);
  const rowKey = row?.rowKey ?? null;
  const key = useSlotKey();
  const cbRef = useRef(cb);
  useLayoutEffect(() => {
    cbRef.current = cb;
  });
  const hasHover = cb.onHover !== undefined;
  const hasSelect = cb.onSelect !== undefined;
  const hasHoverMany = cb.onHoverMany !== undefined;
  const hasSelectMany = cb.onSelectMany !== undefined;
  const entry = useMemo<SelectorEntry | null>(
    () =>
      enabled
        ? {
            onHover: hasHover
              ? (hit) => cbRef.current.onHover?.(hit)
              : undefined,
            // Forward the modifiers with the arity we were called with.
            // `select()` omits them for a programmatic (legend) select, and
            // passing an explicit `undefined` there would change the observed
            // arity for every consumer asserting `toHaveBeenCalledWith(hit)`.
            onSelect: hasSelect
              ? (hit, modifiers) => {
                  if (modifiers === undefined) cbRef.current.onSelect?.(hit);
                  else cbRef.current.onSelect?.(hit, modifiers);
                }
              : undefined,
            multi,
            onHoverMany: hasHoverMany
              ? (hits) => cbRef.current.onHoverMany?.(hits)
              : undefined,
            onSelectMany: hasSelectMany
              ? (hits, modifiers, spans) =>
                  cbRef.current.onSelectMany?.(hits, modifiers, spans)
              : undefined,
            sequence,
            rowKey,
            legacy,
          }
        : null,
    [
      enabled,
      hasHover,
      hasSelect,
      hasHoverMany,
      hasSelectMany,
      multi,
      sequence,
      rowKey,
      legacy,
    ],
  );
  const { registerSelector, unregisterSelector } = container;
  useEffect(() => {
    if (entry === null) {
      unregisterSelector(key);
      return;
    }
    registerSelector(key, entry);
  }, [registerSelector, unregisterSelector, key, entry]);
  useEffect(() => () => unregisterSelector(key), [unregisterSelector, key]);
}

export interface SelectorProps {
  /**
   * What is under the pointer — one {@link SelectInfo}, or `null` on leaving
   * every mark. Deduped by the mark's full identity, so it fires on a mark
   * transition rather than on every pointer move.
   *
   * Echo it back as `<ChartContainer hovered>` to light the mark (A1.2 — the
   * state stays on the container).
   */
  onHover?: (hit: SelectInfo | null) => void;
  /**
   * What was clicked — one {@link SelectInfo}, or `null` for a click that hit
   * no mark (the deselect path) — plus the modifiers held.
   *
   * **The library reports; you decide.** `modifiers.additive` is the
   * platform-idiomatic add chord (⌘ on macOS, Ctrl elsewhere); pond applies no
   * policy to it and holds no set. Compute the next selection yourself and feed
   * it back as `<ChartContainer selected>`:
   *
   * ```tsx
   * <Selector
   *   onSelect={(hit, mods) =>
   *     setSel(
   *       hit === null ? [] : mods?.additive ? toggle(sel, hit) : [hit],
   *     )
   *   }
   * />
   * ```
   *
   * `modifiers` is absent for a **programmatic** select (a `<Legend>` chip),
   * which carries no keyboard state.
   */
  onSelect?: (hit: SelectInfo | null, modifiers?: SelectModifiers) => void;
}

/**
 * Mount it to make the plot **click-selectable** (RFC §7.1) — as a child of
 * `<ChartContainer>` for every row, or inside a `<ChartRow>` to scope the
 * gesture to that row.
 *
 * ```tsx
 * <ChartContainer selected={sel} hovered={hov}>
 *   <Selector onSelect={(hit, mods) => …} onHover={setHov} />
 *   <ChartRow>…</ChartRow>
 * </ChartContainer>
 * ```
 *
 * It renders nothing and holds nothing: `selected` / `hovered` live on the
 * container (A1.2), so highlighting driven from *outside* the chart works with
 * no `<Selector>` mounted.
 */
export function Selector({ onHover, onSelect }: SelectorProps = {}) {
  // Always registers, callbacks or not: the *mount* is the enablement (§7.1),
  // so a bare `<Selector />` is the honest way to say "clicks select" while the
  // container drives its own uncontrolled highlight.
  useSelectorMount({ onHover, onSelect }, false, true);
  return null;
}

export interface MultiSelectorProps {
  /**
   * Snap the sweep to buckets — a pond `Sequence` (realized over the view) or
   * `BoundedSequence` (used as-is; a trading calendar's sessions). A drag
   * extends **bucket by bucket** over these, capturing every mark the snapped
   * window covers. **Omit ⇒ freeform**: the sweep covers the raw drag span (a
   * bar/histogram layer's bins still snap it when present — the same shared
   * snap-bucket channel `<RangeCursor sequence>` feeds). Pass a stable
   * reference (the realized buckets memoize on it).
   */
  sequence?: Sequence | BoundedSequence;
  /**
   * The marks the gesture currently covers — or **would** cover:
   *
   * - **At rest**, the marks of the **snap block under the pointer** (the
   *   `sequence` bucket, else the layer's own bin/slot), reported once per
   *   block transition. This is the resting preview: hovering ANY mark of a
   *   block reports the whole block, because that is exactly the set a drag
   *   begun and released there would select.
   * - **During a sweep**, every covered mark, updated as the drag crosses
   *   marks (coalesced to animation frames past the first cut).
   *
   * Echo it back as `<ChartContainer hovered>` only when you control hover —
   * uncontrolled, the covered marks already light through the container's
   * own hover state (RFC A3.4: the library owns the state, each layer draws
   * its own hover treatment).
   */
  onHover?: (hits: readonly SelectInfo[]) => void;
  /**
   * The committed selection, on release (RFC A5.2's signature):
   *
   * - **A sweep** reports every covered mark, the modifiers held, and the
   *   {@link SpanSelection} the coverage demotes to — `hits` are the
   *   materialised live preview (no fresh range query), `span` is the
   *   snapped-outward extent whose `selectionContains` test reproduces
   *   exactly `hits`. Feed `[...others, span]` back as `selected` and stash
   *   `hits` for A5.2's demote-on-edit: to edit *inside* the span later, swap
   *   the span entry for the stashed hits and filter — plain array
   *   arithmetic, no interval math.
   * - **A click** (no movement past the drag slop) is `<Selector>`'s gesture
   *   in this currency: one hit (or none — the deselect path), the modifiers,
   *   and `span: null`. Clicks produce marks; only sweeps produce a span.
   *
   * `modifiers` is absent for a **programmatic** select (a `<Legend>` chip),
   * as on `<Selector onSelect>`. **The library reports; you decide** — pond
   * applies no policy to the modifiers and holds no set.
   */
  /**
   * The committed selection, on release (RFC A5.2's signature).
   *
   * **`spans` is plural because one sweep can commit several.** A trace sweep
   * produces one span per trace ([PND-TRACESEL]): every trace shares the swept
   * x window, so singling one out by z-order would be arbitrary to the reader.
   * Mark layers keep topmost-wins, so there it holds exactly one. **Topmost
   * layer first.**
   *
   * **Empty means no span**, and that is the two cases that used to be `null`:
   * a click (a click produces marks, only a sweep produces a span) and a sweep
   * that covered nothing.
   *
   * Compare spans by `id`, not by identity — each span-only layer clamps the
   * window to **its own** key range, so two traces of different extents report
   * different `x` for one drag.
   */
  onSelect?: (
    hits: readonly SelectInfo[],
    modifiers: SelectModifiers | undefined,
    spans: readonly SpanSelection[],
  ) => void;
}

/**
 * `<MultiSelector>` — **sweep-select as a mounted component** (interaction RFC
 * §8 / A4.2), a superset of `<Selector>`: a click still selects one mark, and
 * a drag past the slop **sweeps** — the band extends (bucket by bucket with a
 * {@link MultiSelectorProps.sequence}, freeform without), every covered mark
 * lights through the plural `hovered` as the drag moves, and release commits
 * `(hits, modifiers, span)` once. The gesture rides the shared brush
 * recognizer (`brush.tsx`) and draws the same band `<RangeCursor>` does —
 * identical pixels, different currency (§8.1): the range cursor releases an
 * extent, this releases **marks** (which is what folds the category axis in —
 * ordinal and continuous are the same gesture when nobody sees a numeric
 * range).
 *
 * ```tsx
 * <ChartContainer selected={sel}>
 *   <MultiSelector
 *     sequence={daily}
 *     onSelect={(hits, mods, span) => …}
 *   />
 *   <ChartRow>…</ChartRow>
 * </ChartContainer>
 * ```
 *
 * Mount it as a child of `<ChartContainer>` (every row) or inside a
 * `<ChartRow>` (that row only). Like `<Selector>` it renders nothing and holds
 * nothing — `selected` / `hovered` stay on the container (A1.2). The sweep
 * captures marks from the row's **topmost** sweep-capable layer (the z-order
 * rule a click already follows); a layer without an `id` is never swept (Q8).
 *
 * **Mounting also changes the row's RESTING state** — the grey band and the
 * hover are a live preview of the block a drag would select:
 *
 * - The shared brush band becomes the **resting cursor**, spanning the snap
 *   block under the pointer (the `sequence` bucket, else the layer's own
 *   bin/slot), replacing the container's implicit `'line'` default. An
 *   explicitly chosen cursor — a mounted component, or a legacy `cursor`
 *   string the consumer actually set — still wins the surface.
 * - Hover is **block-scoped**: pointing at any one mark of a block lights
 *   (and reports) every mark in it. Rest and drag share one code path — the
 *   same snap buckets, the same layer session — so what the rest previews and
 *   what a drag commits cannot disagree; the drag just grows the same band.
 */
export function MultiSelector({
  sequence,
  onHover,
  onSelect,
}: MultiSelectorProps = {}) {
  // As <Selector>: the mount is the enablement — of the click AND the sweep.
  useSelectorMount(
    {
      onHover: undefined,
      onSelect: undefined,
      onHoverMany: onHover,
      onSelectMany: onSelect,
    },
    false,
    true,
    true,
    sequence,
  );
  return null;
}

/**
 * The deprecation shim (internal): synthesizes a container-scoped selector from
 * the legacy `<ChartContainer onSelect / onHover>` props, so a chart written
 * against them keeps its plot gesture for one more minor. Registers as
 * `legacy`, so mounting a real `<Selector>` at the container overrides it.
 *
 * Registers nothing when neither prop is set — which is what makes "no selector
 * mounted" detectable, and so what makes §7.1's break and its dev warning work.
 */
export function LegacySelector({
  onHover,
  onSelect,
}: {
  onHover: ((hit: SelectInfo | null) => void) | undefined;
  onSelect:
    | ((hit: SelectInfo | null, modifiers?: SelectModifiers) => void)
    | undefined;
}) {
  useSelectorMount(
    { onHover, onSelect },
    true,
    onHover !== undefined || onSelect !== undefined,
  );
  return null;
}

/** Drop a scope's legacy (shim-synthesized) entry when the scope also has a
 *  mounted `<Selector>` — mounting overrides the container prop. */
function dropShadowedLegacy(
  entries: readonly SelectorEntry[],
): readonly SelectorEntry[] {
  return entries.some((e) => !e.legacy)
    ? entries.filter((e) => !e.legacy)
    : entries;
}

/**
 * The selectors in effect for a row: the row's own mounts when it has any (the
 * per-row scope — nearest mount wins, mirroring `effectiveCursorEntries`), else
 * the container-scoped mounts. Within a scope, a mounted `<Selector>` shadows
 * the legacy shim.
 *
 * `rowKey` of `null` asks for the **container** scope only — the programmatic
 * (legend) path, which belongs to no row.
 */
export function effectiveSelectorEntries(
  all: readonly SelectorEntry[],
  rowKey: symbol | null,
): readonly SelectorEntry[] {
  if (rowKey !== null) {
    const rowEntries = all.filter((e) => e.rowKey === rowKey);
    if (rowEntries.length > 0) return dropShadowedLegacy(rowEntries);
  }
  return dropShadowedLegacy(all.filter((e) => e.rowKey === null));
}

/**
 * RFC §7.1's softening: a plot click resolved to a real mark and there was no
 * `<Selector>` to tell — the exact path that goes silently inert on upgrade.
 *
 * **Suppressed when `selected` is supplied** (A2.6). After A1.2 that is also
 * the runtime signature of the *endorsed* controlled-highlight setup (a legend
 * chip or an external list lighting marks up, plot deliberately inert), and the
 * deprecation window should not spend its loudness on people already doing the
 * right thing.
 *
 * Deprecation-scoped, not permanent: once mounting is the established model, an
 * `id` without a `<Selector>` is a legitimate configuration (Q8) and warning on
 * it forever would flag a supported setup. Fires once per container.
 */
export function warnInertClick(warned: { current: boolean }): void {
  if (warned.current) return;
  warned.current = true;
  console.warn(
    '[pond-charts] a click hit a mark but no <Selector> is mounted, so ' +
      'nothing happened. Mount `<Selector onSelect={…}>` inside the ' +
      '<ChartContainer> (or inside a <ChartRow> to scope it to that row) — ' +
      'click-select is no longer implied by giving a layer an `id`. See ' +
      'docs/rfcs/interaction.md §7.1. (Silent if you pass `selected`: ' +
      'controlled highlighting with an inert plot is a supported setup.)',
  );
}

/** The legacy-props warning: the container's `onSelect`/`onHover` still work,
 *  for one more minor, and this names their replacement. Fires once. */
export function warnLegacySelectionProps(props: readonly string[]): void {
  console.warn(
    `[pond-charts] ${props.join(' and ')} on <ChartContainer> ${
      props.length > 1 ? 'are' : 'is'
    } deprecated — move ` +
      `${props.length > 1 ? 'them' : 'it'} onto a mounted <Selector> ` +
      `(\`<Selector ${props.map((p) => `${p}={…}`).join(' ')} />\`). The ` +
      'container props keep working for one more minor; a mounted <Selector> ' +
      'overrides them. See docs/rfcs/interaction.md §7.',
  );
}
