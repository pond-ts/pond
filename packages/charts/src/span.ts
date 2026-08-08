import type { SelectInfo, SelectionEntry, SpanSelection } from './context.js';

/**
 * Span-selection membership — the one place the containment rule lives
 * (interaction RFC A5.2/A5.3, edge rule A7.6).
 *
 * `selectionContains` is the **public** predicate, and it is deliberately the
 * same code every layer's draw runs per mark ({@link spanContainsPoint} for
 * span entries): a consumer asking "is this hit already selected?" must get
 * exactly the answer the canvas paints, or the boundary marks disagree with
 * the span that swept them — the inverse-band-scale friction the marks
 * currency was built to kill (`selection.md` A4.2) re-imported through the
 * back door.
 *
 * Pure, DOM-free, theme-free — unit-tests like `select.ts` does.
 */

/** Stable identity for "no spans" — the resting case, shared by the container
 *  normalization and every layer's narrowing, so a spanless render never hands
 *  a draw (or a memo dep) a fresh empty array. */
export const NO_SPANS: readonly SpanSelection[] = [];

/**
 * Is this `selected` entry a span descriptor rather than a single mark? The
 * discriminant is the `kind` field, which {@link SelectInfo} does not have —
 * useful to a consumer editing a mixed selection (RFC A5.2's demote-on-edit:
 * filter the span out, splice in the marks it stashed at commit time).
 */
export function isSpanSelection(entry: SelectionEntry): entry is SpanSelection {
  return (entry as SpanSelection).kind === 'span';
}

/**
 * Does `span` contain the mark with these channels? The containment rule of
 * {@link SpanSelection}, minus the layer-`id` gate (the caller has already
 * matched it — a layer narrows the set to its own `id` once per render, not
 * once per mark):
 *
 * - `key` in the **half-open** `x` interval — `x[0] <= key < x[1]`;
 * - `value` in the half-open `y` interval, when the span has one;
 * - `label` a member of `rows`, when the span has one.
 *
 * Each channel is the mark's own {@link SelectInfo} field, so the test is
 * answerable from a hit alone *and* from a draw loop's per-mark scalars — the
 * property RFC A5.3 requires (nothing here reads a slot index or a pixel).
 * `NaN` in any tested channel fails its comparison, so a series-scoped entry
 * (`key: NaN`) or a gap value is never inside any span. A span carrying `rows`
 * tested against a caller with no label channel (`label === undefined`)
 * matches nothing — a row-set has to be checked, not skipped.
 *
 * O(1) per mark (plus O(|rows|) for the label set, which is a handful of row
 * names) — the whole point of the descriptor: a span covering ten thousand
 * marks costs each of them one interval test, not a ten-thousand-entry scan.
 */
export function spanContainsPoint(
  span: SpanSelection,
  key: number,
  value: number,
  label: string | undefined,
): boolean {
  const x = span.x;
  if (!(key >= x[0] && key < x[1])) return false;
  const y = span.y;
  if (y !== undefined && !(value >= y[0] && value < y[1])) return false;
  const rows = span.rows;
  if (rows !== undefined) {
    if (label === undefined) return false;
    let found = false;
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i] === label) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Does **any** of `spans` contain the mark with these channels? The set form of
 * {@link spanContainsPoint}, for the draw loops — `spans` is the layer's
 * already-`id`-narrowed list (see {@link spansForLayer}), so this is pure
 * channel tests. Linear over the spans for the reason `barMatchesAny` records
 * about mark sets: a selection is a handful of entries, and the common cases
 * (0 or 1) short-circuit.
 */
export function spanMatchesAny(
  spans: readonly SpanSelection[],
  key: number,
  value: number,
  label?: string,
): boolean {
  for (let i = 0; i < spans.length; i += 1) {
    if (spanContainsPoint(spans[i]!, key, value, label)) return true;
  }
  return false;
}

/**
 * Narrow the container's span set to one layer — the span analog of the
 * per-layer mark narrowing every chart component already does (`keysOf`,
 * `marksOf`): drop the spans naming other layers, and — when the layer's marks
 * all share **one** label (`label` given: a single-series bar, scatter or box,
 * whose `SelectInfo.label` is the series label) — resolve the `rows` channel
 * here, once, instead of per mark: a row set that excludes the constant label
 * can never match and is dropped; one that includes it always matches and is
 * stripped. Layers whose label varies per mark (a stack's groups, a heat map's
 * rows) pass no `label` and keep `rows` for the draw to test per mark.
 *
 * Returns {@link NO_SPANS} when nothing survives, so the resting case keeps a
 * stable identity (no re-registered layer, no repaint, when some *other*
 * layer's spans change).
 */
export function spansForLayer(
  spans: readonly SpanSelection[],
  id: string | undefined,
  label?: string,
): readonly SpanSelection[] {
  if (id === undefined || spans.length === 0) return NO_SPANS;
  let out: SpanSelection[] | null = null;
  for (let i = 0; i < spans.length; i += 1) {
    const s = spans[i]!;
    if (s.id !== id) continue;
    let keep = s;
    if (label !== undefined && s.rows !== undefined) {
      let found = false;
      for (let r = 0; r < s.rows.length; r += 1) {
        if (s.rows[r] === label) {
          found = true;
          break;
        }
      }
      if (!found) continue; // can never match this layer's constant label
      // Always satisfied — strip it so the draw never re-tests a constant.
      keep =
        s.y !== undefined
          ? { kind: 'span', id: s.id, x: s.x, y: s.y }
          : { kind: 'span', id: s.id, x: s.x };
    }
    (out ??= []).push(keep);
  }
  return out ?? NO_SPANS;
}

/**
 * Does a mark **entry** of the selection identify `hit`? The full mark
 * identity, matching the container's own hover dedup: same layer `id`, same
 * per-mark handle — the stable `mark` when **both** sides carry one, else the
 * sample `key` (the `barMatches` fallback rule) — and same `label`, which on a
 * grouped layer (stack segment, heat cell) is the half of the identity that
 * separates two marks sharing a bin. `NaN` keys never match (`NaN !== NaN`),
 * so a series-scoped legend entry names no mark, deliberately.
 */
function markContains(entry: SelectInfo, hit: SelectInfo): boolean {
  if (entry.id !== hit.id) return false;
  if (entry.mark !== undefined && hit.mark !== undefined) {
    if (entry.mark !== hit.mark) return false;
  } else if (entry.key !== hit.key) {
    return false;
  }
  return entry.label === hit.label;
}

/**
 * Is `hit` inside the selection — named by a mark entry, or covered by a span
 * (interaction RFC A5.2)? **The same predicate the layers run**, exported so a
 * consumer implementing click-policy over a mixed selection (toggle a mark out,
 * ⌘-click-add next to a swept span) never re-implements the interval test in
 * axis units — the exact friction `selection.md` A4.2's marks currency exists
 * to eliminate.
 *
 * ```tsx
 * onSelect={(hit, mods) =>
 *   setSelected((cur) =>
 *     hit === null ? []
 *     : mods?.additive
 *       ? selectionContains(cur, hit) ? remove(cur, hit) : [...cur, hit]
 *       : [hit],
 *   )
 * }
 * ```
 *
 * Span entries use {@link SpanSelection}'s containment rule (half-open `x`/`y`
 * intervals on the hit's `key`/`value`, `rows` membership on its `label`);
 * mark entries use the full mark identity (`id`, `mark`-or-`key`, `label`).
 * Entries naming another layer's `id` never match. O(|sel|) with O(1) per
 * entry, spans included.
 */
export function selectionContains(
  sel: readonly SelectionEntry[],
  hit: SelectInfo,
): boolean {
  for (let i = 0; i < sel.length; i += 1) {
    const entry = sel[i]!;
    if (isSpanSelection(entry)) {
      if (
        entry.id === hit.id &&
        spanContainsPoint(entry, hit.key, hit.value, hit.label)
      )
        return true;
    } else if (markContains(entry, hit)) {
      return true;
    }
  }
  return false;
}
