import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import type { Sequence, BoundedSequence } from 'pond-ts';
import { isDev } from './dev.js';
import {
  ContainerContext,
  RowContext,
  type SelectInfo,
  type SelectModifiers,
  type SelectionEntry,
  type SelectorEntry,
  type SpanSelection,
} from './context.js';
import { useSlotKey } from './use-slot-key.js';

/**
 * `<Selector>` — **selection as a mounted component** (interaction RFC §7 /
 * A4.2 / A10), a `value`/`onChange` pair for a chart's data-mark selection:
 * `selected` is the value, `onSelect` is the change notification, and both
 * live on the same tag as the gesture that drives them.
 *
 * Two rules govern it:
 *
 * 1. **Mounting is what enables the plot gesture** (§7.1). With no `<Selector>`
 *    mounted a click on the plot does nothing — selection is a subsystem
 *    (modifiers, a set, a dim slot, precedence against hover) and it should not
 *    switch itself on because a layer happened to be given an `id`.
 * 2. **It wraps what it applies to** (A10.1): scope — one row, or every row —
 *    comes from where it's mounted, and `children` makes that visible rather
 *    than implicit in a sibling's position. `enabled={false}` (A10.2) turns
 *    the gesture off while keeping `selected`/`hovered` in effect — the
 *    "highlight from outside, no plot click" configuration.
 *
 * A layer `id` is *identity*, the mount is *enablement* (Q8): an untagged layer
 * is never hit-tested, so a click on one is a `null` hit — the same value as a
 * click on empty space, which is already the deselect path. `SelectInfo.id` is
 * therefore never undefined.
 */

/** The reporting callbacks, held in a ref so a consumer's inline arrow doesn't
 *  re-register the entry on every render. The plural pair is `<MultiSelector>`'s
 *  (RFC §8 / A5.2); the singular pair is `<Selector>`'s. */
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

interface SelectorMountOptions {
  readonly cb: SelectorCallbacks;
  /** `<Selector enabled>` (A10.2, default `true`). `false` disables the
   *  GESTURE only — the entry is still the controlled-state owner below. */
  readonly gestureEnabled: boolean;
  /** A `<MultiSelector>` mount — arms the sweep drag alongside the click. */
  readonly multi?: boolean;
  /** `<MultiSelector sequence>` — the sweep's bucket snap. */
  readonly sequence?: Sequence | BoundedSequence | undefined;
  readonly hasSelected: boolean;
  readonly selected?: SelectInfo | readonly SelectionEntry[] | null | undefined;
  readonly hasHovered: boolean;
  readonly hovered?: SelectInfo | readonly SelectInfo[] | null | undefined;
}

/**
 * Register a selector with the container, scoped to the enclosing `<ChartRow>`
 * when there is one (that row's clicks only) else the container (every row).
 *
 * The registered entry is memoized on which callbacks are *present* (not their
 * identity — read through a ref at report time) and on the controlled state
 * values — a consumer writing `<Selector onSelect={(hit) => …} />` passes a
 * fresh function every render, and re-registering on each one would thrash the
 * container's registry state (and, since the registry is `useState`, loop).
 */
function useSelectorMount(opts: SelectorMountOptions): void {
  const {
    cb,
    gestureEnabled,
    multi = false,
    sequence,
    hasSelected,
    selected,
    hasHovered,
    hovered,
  } = opts;
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
  const entry = useMemo<SelectorEntry>(
    () => ({
      onHover:
        gestureEnabled && hasHover
          ? (hit) => cbRef.current.onHover?.(hit)
          : undefined,
      // Forward the modifiers with the arity we were called with. `select()`
      // omits them for a programmatic (legend) select, and passing an
      // explicit `undefined` there would change the observed arity for every
      // consumer asserting `toHaveBeenCalledWith(hit)`.
      onSelect:
        gestureEnabled && hasSelect
          ? (hit, modifiers) => {
              if (modifiers === undefined) cbRef.current.onSelect?.(hit);
              else cbRef.current.onSelect?.(hit, modifiers);
            }
          : undefined,
      multi,
      onHoverMany:
        gestureEnabled && hasHoverMany
          ? (hits) => cbRef.current.onHoverMany?.(hits)
          : undefined,
      onSelectMany:
        gestureEnabled && hasSelectMany
          ? (hits, modifiers, spans) =>
              cbRef.current.onSelectMany?.(hits, modifiers, spans)
          : undefined,
      sequence: gestureEnabled ? sequence : undefined,
      rowKey,
      gestureEnabled,
      hasSelected,
      selected,
      hasHovered,
      hovered,
    }),
    [
      gestureEnabled,
      hasHover,
      hasSelect,
      hasHoverMany,
      hasSelectMany,
      multi,
      sequence,
      rowKey,
      hasSelected,
      selected,
      hasHovered,
      hovered,
    ],
  );
  const { registerSelector, unregisterSelector } = container;
  useEffect(() => {
    registerSelector(key, entry);
  }, [registerSelector, key, entry]);
  useEffect(() => () => unregisterSelector(key), [unregisterSelector, key]);
}

export interface SelectorProps {
  /**
   * `false` disables the **gesture** — no hit-testing, `onHover`/`onSelect`
   * never fire, a plot click behaves as if `<Selector>` weren't mounted at
   * all. **Omitted ⇒ `true`.**
   *
   * `<Selector enabled={false} selected={sel} />` is controlled highlighting
   * with no plot gesture — a legend chip or an external filter list driving
   * the chart, deliberately inert on click (interaction RFC A10.2).
   */
  enabled?: boolean;
  /**
   * Controlled selection — the selected mark(s) (echo `onSelect`'s hit back),
   * or `null`. **Omitted ⇒ uncontrolled** (a click on a selectable layer
   * manages it internally; pass `null` to force nothing selected). A layer is
   * **selectable only when it carries an `id`** — the stable series identity.
   *
   * **Accepts a set**: an array lights several marks at once, and array
   * entries may be {@link SpanSelection}s (a swept range, demoted to one
   * entry instead of enumerating every covered mark). A single `SelectInfo`
   * still works and means exactly what it did.
   */
  selected?: SelectInfo | readonly SelectionEntry[] | null;
  /**
   * Controlled hover-highlight — the transiently lit mark(s), or `null`.
   * **Omitted ⇒ uncontrolled.** The hover analog of {@link selected}: pass it
   * to pin lit marks from outside the chart (e.g. hovering a legend / list row
   * lights the matching bar). Accepts a single mark or a set, the same union
   * `selected` takes.
   */
  hovered?: SelectInfo | readonly SelectInfo[] | null;
  /**
   * What is under the pointer — one {@link SelectInfo}, or `null` on leaving
   * every mark. Deduped by the mark's full identity, so it fires on a mark
   * transition rather than on every pointer move.
   */
  onHover?: (hit: SelectInfo | null) => void;
  /**
   * What was clicked — one {@link SelectInfo}, or `null` for a click that hit
   * no mark (the deselect path) — plus the modifiers held.
   *
   * **The library reports; you decide.** `modifiers.additive` is the
   * platform-idiomatic add chord (⌘ on macOS, Ctrl elsewhere); pond applies no
   * policy to it and holds no set. Compute the next selection yourself and
   * feed it back as this same component's `selected`:
   *
   * ```tsx
   * <Selector
   *   selected={sel}
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
  /**
   * What it applies to (interaction RFC A10.1): every `<ChartRow>` when
   * mounted as a direct child of `<ChartContainer>`, or just the row it's
   * nested inside when mounted there instead. Optional — `<Selector />` with
   * no children keeps working exactly as it always has.
   */
  children?: ReactNode;
}

/**
 * Mount it to make the plot **click-selectable** (RFC §7.1) and to hold the
 * selection state that produces — wrap every `<ChartRow>` as a direct child of
 * `<ChartContainer>`, or wrap one row's contents to scope both the gesture and
 * the state to that row (interaction RFC A10.1).
 *
 * ```tsx
 * <ChartContainer>
 *   <Selector
 *     selected={sel}
 *     hovered={hov}
 *     onSelect={(hit, mods) => …}
 *     onHover={setHov}
 *   >
 *     <ChartRow>…</ChartRow>
 *   </Selector>
 * </ChartContainer>
 * ```
 *
 * `value`/`onChange`, one component: `selected` is what's lit, `onSelect`
 * reports what changes it, and the mount itself is what makes a plot click do
 * anything. Need controlled highlighting with **no** plot click at all?
 * `enabled={false}`.
 */
export function Selector({
  enabled = true,
  selected,
  hovered,
  onHover,
  onSelect,
  children,
}: SelectorProps = {}) {
  useSelectorMount({
    cb: { onHover, onSelect },
    gestureEnabled: enabled,
    hasSelected: selected !== undefined,
    selected,
    hasHovered: hovered !== undefined,
    hovered,
  });
  return <>{children}</>;
}

export interface MultiSelectorProps {
  /**
   * `false` disables the gesture — no hit-testing, no armed sweep, callbacks
   * never fire. **Omitted ⇒ `true`.** See {@link SelectorProps.enabled};
   * applies identically here.
   */
  enabled?: boolean;
  /**
   * Controlled selection — the state half of what `onSelect` reports. See
   * {@link SelectorProps.selected}; `<MultiSelector>` additionally accepts
   * {@link SpanSelection} entries directly, which is exactly the shape a
   * sweep's `onSelect` hands back.
   */
  selected?: SelectInfo | readonly SelectionEntry[] | null;
  /** Controlled hover-highlight — see {@link SelectorProps.hovered}. Accepts
   *  a set, since a sweep's live preview lights several marks at once. */
  hovered?: SelectInfo | readonly SelectInfo[] | null;
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
   * Echo it back as this component's `hovered` only when you control hover —
   * uncontrolled, the covered marks already light through the container's
   * own hover state (RFC A3.4: the library owns the state, each layer draws
   * its own hover treatment).
   */
  onHover?: (hits: readonly SelectInfo[]) => void;
  /**
   * The committed selection, on release (RFC A5.2's signature):
   *
   * - **A sweep** reports every covered mark, the modifiers held, and the
   *   {@link SpanSelection}s the coverage demotes to — `hits` are the
   *   materialised live preview (no fresh range query), `spans` are the
   *   snapped-outward extents whose `selectionContains` test reproduces
   *   exactly `hits`. Feed `[...others, ...spans]` back as this component's
   *   `selected` and stash `hits` for A5.2's demote-on-edit: to edit *inside*
   *   a span later, swap that span entry for the stashed hits and filter —
   *   plain array arithmetic, no interval math.
   * - **A click** (no movement past the drag slop) is `<Selector>`'s gesture
   *   in this currency: one hit (or none — the deselect path), the modifiers,
   *   and an **empty** `spans`. Clicks produce marks; only sweeps produce
   *   spans.
   *
   * **`spans` is plural because one sweep can commit several.** A trace sweep
   * produces one span per trace ([PND-TRACESEL]): every trace shares the swept
   * x window, so singling one out by z-order would be arbitrary to the reader.
   * Mark layers keep topmost-wins, so there it holds exactly one. **Topmost
   * layer first**, and compare spans by `id` rather than identity — each
   * span-only layer clamps the window to *its own* key range, so two traces of
   * different extents report different `x` for one drag.
   *
   * `modifiers` is absent for a **programmatic** select (a `<Legend>` chip),
   * as on `<Selector onSelect>`. **The library reports; you decide** — pond
   * applies no policy to the modifiers and holds no set.
   */
  onSelect?: (
    hits: readonly SelectInfo[],
    modifiers: SelectModifiers | undefined,
    spans: readonly SpanSelection[],
  ) => void;
  /** What it applies to — see {@link SelectorProps.children} (interaction RFC
   *  A10.1); identical scoping rule. */
  children?: ReactNode;
}

/**
 * `<MultiSelector>` — **sweep-select as a mounted component** (interaction RFC
 * §8 / A4.2 / A10), a superset of `<Selector>`: a click still selects one mark,
 * and a drag past the slop **sweeps** — the band extends (bucket by bucket
 * with a {@link MultiSelectorProps.sequence}, freeform without), every
 * covered mark lights through the plural `hovered` as the drag moves, and
 * release commits `(hits, modifiers, spans)` once. The gesture rides the
 * shared brush recognizer (`brush.tsx`) and draws the same band `<RangeCursor>`
 * does — identical pixels, different currency (§8.1): the range cursor
 * releases an extent, this releases **marks** (which is what folds the
 * category axis in — ordinal and continuous are the same gesture when nobody
 * sees a numeric range).
 *
 * ```tsx
 * <ChartContainer>
 *   <MultiSelector
 *     selected={sel}
 *     sequence={daily}
 *     onSelect={(hits, mods, spans) => …}
 *   >
 *     <ChartRow>…</ChartRow>
 *   </MultiSelector>
 * </ChartContainer>
 * ```
 *
 * Wraps what it applies to, same as `<Selector>`; `selected` / `hovered` live
 * here too. The sweep captures marks from the row's **topmost** sweep-capable
 * layer (the z-order rule a click already follows); a layer without an `id`
 * is never swept (Q8).
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
  enabled = true,
  selected,
  hovered,
  sequence,
  onHover,
  onSelect,
  children,
}: MultiSelectorProps = {}) {
  useSelectorMount({
    cb: {
      onHover: undefined,
      onSelect: undefined,
      onHoverMany: onHover,
      onSelectMany: onSelect,
    },
    gestureEnabled: enabled,
    multi: true,
    sequence,
    hasSelected: selected !== undefined,
    selected,
    hasHovered: hovered !== undefined,
    hovered,
  });
  return <>{children}</>;
}

/**
 * The selectors in effect for a row's GESTURE: the row's own mounts when it has
 * any (the per-row scope — nearest mount wins, mirroring
 * `effectiveCursorEntries`), else the container-scoped mounts. A
 * `gestureEnabled: false` entry (`<Selector enabled={false}>`) is filtered out
 * entirely — it behaves as unmounted for click/hover/sweep purposes, exactly
 * as `enabled` promises.
 *
 * `rowKey` of `null` asks for the **container** scope only — the programmatic
 * (legend) path, which belongs to no row.
 *
 * Controlled-state resolution does **not** use this function — state is
 * chart-wide, not row-scoped, and a disabled selector may still own it. See
 * {@link resolveControlledSelected} / {@link resolveControlledHovered}.
 */
export function effectiveSelectorEntries(
  all: readonly SelectorEntry[],
  rowKey: symbol | null,
): readonly SelectorEntry[] {
  const active = all.filter((e) => e.gestureEnabled);
  if (rowKey !== null) {
    const rowEntries = active.filter((e) => e.rowKey === rowKey);
    if (rowEntries.length > 0) return rowEntries;
  }
  return active.filter((e) => e.rowKey === null);
}

/** Fires once per container: more than one registered selector declared the
 *  same controlled state, which is ambiguous — the first registered wins and
 *  every other declaration is silently ignored until this is resolved. */
function warnAmbiguousControlledState(prop: 'selected' | 'hovered'): void {
  console.warn(
    `[pond-charts] more than one mounted <Selector>/<MultiSelector> declares ` +
      `\`${prop}\` in the same chart — only the first registered is used, the ` +
      `rest are ignored. One selector should own \`${prop}\` per chart.`,
  );
}

/**
 * Resolve the chart-wide controlled `selected`, from whichever registered
 * selector declared it. Not row-scoped — selection identity spans every row
 * (a `SelectInfo.id` names a layer, not a row) — and not filtered on
 * `gestureEnabled`: `<Selector enabled={false} selected={…}>` is exactly the
 * "state, no gesture" configuration `enabled` exists for.
 */
export function resolveControlledSelected(
  all: readonly SelectorEntry[],
  warned: { current: boolean },
): {
  readonly present: boolean;
  readonly value: SelectInfo | readonly SelectionEntry[] | null;
} {
  const owner = pickControlledOwner(
    all,
    (e) => e.hasSelected,
    warned,
    'selected',
  );
  return owner
    ? { present: true, value: owner.selected ?? null }
    : { present: false, value: null };
}

/** As {@link resolveControlledSelected}, for `hovered`. */
export function resolveControlledHovered(
  all: readonly SelectorEntry[],
  warned: { current: boolean },
): {
  readonly present: boolean;
  readonly value: SelectInfo | readonly SelectInfo[] | null;
} {
  const owner = pickControlledOwner(
    all,
    (e) => e.hasHovered,
    warned,
    'hovered',
  );
  return owner
    ? { present: true, value: owner.hovered ?? null }
    : { present: false, value: null };
}

function pickControlledOwner(
  all: readonly SelectorEntry[],
  has: (e: SelectorEntry) => boolean,
  warned: { current: boolean },
  prop: 'selected' | 'hovered',
): SelectorEntry | null {
  const owners = all.filter(has);
  if (owners.length === 0) return null;
  if (isDev && owners.length > 1 && !warned.current) {
    warned.current = true;
    warnAmbiguousControlledState(prop);
  }
  return owners[0]!;
}

/**
 * RFC §7.1's softening: a plot click resolved to a real mark and there was no
 * `<Selector>` to tell — the exact path that goes silently inert on upgrade.
 *
 * **Suppressed when controlled `selected` is in effect** (A2.6) — that is the
 * runtime signature of the *endorsed* controlled-highlight setup
 * (`<Selector enabled={false} selected={…}>`, plot deliberately inert), and
 * the warning should not spend its loudness on people already doing that.
 *
 * Not permanent: once mounting is the established model, an `id` without a
 * `<Selector>` is a legitimate configuration (Q8) and warning on it forever
 * would flag a supported setup. Fires once per container.
 */
export function warnInertClick(warned: { current: boolean }): void {
  if (warned.current) return;
  warned.current = true;
  console.warn(
    '[pond-charts] a click hit a mark but no <Selector> is mounted (or the ' +
      'one in scope has `enabled={false}`), so nothing happened. Mount ' +
      '`<Selector onSelect={…}>` wrapping the chart (or one <ChartRow> to ' +
      'scope it to that row) — click-select is no longer implied by giving a ' +
      'layer an `id`. See docs/rfcs/interaction.md §7.1. (Silent if ' +
      'controlled `selected` is in effect: controlled highlighting with an ' +
      'inert plot is a supported setup.)',
  );
}
