import { describe, expect, it } from 'vitest';
import {
  isSpanSelection,
  selectionContains,
  spanContainsPoint,
  spansForLayer,
  NO_SPANS,
} from '../src/span.js';
import type { SelectInfo, SpanSelection } from '../src/context.js';

/**
 * The span-selection membership predicates (interaction RFC A5.2/A5.3) —
 * `selectionContains` is public API and the single containment rule every
 * layer's draw shares, so its boundary behaviour is pinned here to the digit.
 * The component-level mirror (the same rule reaching the canvas through the
 * real layers) lives in `span-selection.test.tsx`.
 */

const hit = (over: Partial<SelectInfo> = {}): SelectInfo => ({
  id: 'a',
  key: 1000,
  value: 5,
  color: '#abc',
  label: 'price',
  ...over,
});

const span = (over: Partial<SpanSelection> = {}): SpanSelection => ({
  kind: 'span',
  id: 'a',
  x: [1000, 3000],
  ...over,
});

describe('selectionContains — span entries', () => {
  it('contains a hit whose key is inside the x interval', () => {
    expect(selectionContains([span()], hit({ key: 2000 }))).toBe(true);
  });

  it('x is half-open: the low edge is in, the high edge is out', () => {
    // The edge rule (RFC A7.6): contiguous interval marks share edges
    // (`end[i] === begin[i+1]`), and a sweep stores snapped-outward edges — so
    // the first mark PAST the sweep sits exactly at x[1] and must not match.
    expect(selectionContains([span()], hit({ key: 1000 }))).toBe(true);
    expect(selectionContains([span()], hit({ key: 3000 }))).toBe(false);
    expect(selectionContains([span()], hit({ key: 999 }))).toBe(false);
  });

  it('a span naming another layer matches nothing', () => {
    expect(selectionContains([span({ id: 'b' })], hit({ key: 2000 }))).toBe(
      false,
    );
  });

  it('y, when present, is a half-open interval over the hit value', () => {
    const s = span({ y: [4, 6] });
    expect(selectionContains([s], hit({ value: 4 }))).toBe(true);
    expect(selectionContains([s], hit({ value: 5.9 }))).toBe(true);
    expect(selectionContains([s], hit({ value: 6 }))).toBe(false);
    expect(selectionContains([s], hit({ value: 3 }))).toBe(false);
  });

  it('y absent means the value never gates (1-D span)', () => {
    expect(selectionContains([span()], hit({ value: -1e9 }))).toBe(true);
  });

  it('rows, when present, is label-set membership — not an interval', () => {
    // RFC A5.3: the ordinal second dimension names rows; it never numbers them.
    const s = span({ rows: ['lo', 'hi'] });
    expect(selectionContains([s], hit({ label: 'hi' }))).toBe(true);
    expect(selectionContains([s], hit({ label: 'mid' }))).toBe(false);
  });

  it('a NaN key (a series-scoped legend entry) is inside no span', () => {
    expect(selectionContains([span()], hit({ key: NaN }))).toBe(false);
  });

  it('a NaN value fails a y test', () => {
    expect(selectionContains([span({ y: [0, 10] })], hit({ value: NaN }))).toBe(
      false,
    );
  });

  it('a reversed (or empty) x interval matches nothing', () => {
    expect(selectionContains([span({ x: [3000, 1000] })], hit())).toBe(false);
    expect(
      selectionContains([span({ x: [1000, 1000] })], hit({ key: 1000 })),
    ).toBe(false);
  });
});

describe('selectionContains — mark entries and mixed arrays', () => {
  it('a mark entry matches on the full identity (id, key, label)', () => {
    expect(selectionContains([hit()], hit())).toBe(true);
    expect(selectionContains([hit()], hit({ key: 2000 }))).toBe(false);
    expect(selectionContains([hit()], hit({ id: 'b' }))).toBe(false);
    expect(selectionContains([hit()], hit({ label: 'other' }))).toBe(false);
  });

  it('when both sides carry a stable `mark`, it decides instead of the key', () => {
    const pinned = hit({ mark: 'alpha', key: 0 });
    expect(selectionContains([pinned], hit({ mark: 'alpha', key: 99 }))).toBe(
      true,
    );
    expect(selectionContains([pinned], hit({ mark: 'beta', key: 0 }))).toBe(
      false,
    );
    // Either side missing the mark falls back to the key — the `barMatches`
    // rule, so pre-mark controlled selections keep matching.
    expect(
      selectionContains([hit({ key: 0 })], hit({ mark: 'alpha', key: 0 })),
    ).toBe(true);
  });

  it('NaN keys never match a mark entry (series-scoped entries name no mark)', () => {
    expect(selectionContains([hit({ key: NaN })], hit({ key: NaN }))).toBe(
      false,
    );
  });

  it('a mixed [SelectInfo, SpanSelection] array is the union of both tests', () => {
    const sel = [hit({ key: 9000 }), span()];
    expect(selectionContains(sel, hit({ key: 9000 }))).toBe(true); // the mark
    expect(selectionContains(sel, hit({ key: 1500 }))).toBe(true); // the span
    expect(selectionContains(sel, hit({ key: 8000 }))).toBe(false); // neither
  });

  it('an empty selection contains nothing', () => {
    expect(selectionContains([], hit())).toBe(false);
  });
});

describe('spanContainsPoint — the channel form the draw loops run', () => {
  it('is the same rule selectionContains applies (minus the id gate)', () => {
    const s = span({ y: [4, 6], rows: ['price'] });
    expect(spanContainsPoint(s, 2000, 5, 'price')).toBe(true);
    expect(spanContainsPoint(s, 3000, 5, 'price')).toBe(false); // x open edge
    expect(spanContainsPoint(s, 2000, 6, 'price')).toBe(false); // y open edge
    expect(spanContainsPoint(s, 2000, 5, 'size')).toBe(false); // rows
  });

  it('a rows-bearing span never matches a caller with no label channel', () => {
    // A row set must be *checked*, not skipped — matching would claim marks
    // the span's second dimension explicitly excludes.
    expect(spanContainsPoint(span({ rows: ['lo'] }), 2000, 5, undefined)).toBe(
      false,
    );
  });
});

describe('spansForLayer — the per-layer narrowing', () => {
  it('keeps only the spans naming the layer', () => {
    const mine = span();
    const theirs = span({ id: 'b' });
    expect(spansForLayer([mine, theirs], 'a')).toEqual([mine]);
  });

  it('returns the stable NO_SPANS identity when nothing survives', () => {
    expect(spansForLayer([span({ id: 'b' })], 'a')).toBe(NO_SPANS);
    expect(spansForLayer([], 'a')).toBe(NO_SPANS);
    expect(spansForLayer([span()], undefined)).toBe(NO_SPANS);
  });

  it('with a constant label, resolves rows once: excluded spans drop…', () => {
    expect(spansForLayer([span({ rows: ['other'] })], 'a', 'price')).toBe(
      NO_SPANS,
    );
  });

  it('…and included spans survive with rows stripped (always satisfied)', () => {
    const out = spansForLayer(
      [span({ rows: ['price'], y: [0, 1] })],
      'a',
      'price',
    );
    expect(out).toEqual([
      { kind: 'span', id: 'a', x: [1000, 3000], y: [0, 1] },
    ]);
    expect(out[0]!.rows).toBeUndefined();
  });

  it('without a label, rows ride through untouched (per-mark labels)', () => {
    const s = span({ rows: ['lo'] });
    expect(spansForLayer([s], 'a')).toEqual([s]);
  });
});

describe('isSpanSelection', () => {
  it('discriminates the two entry currencies', () => {
    expect(isSpanSelection(span())).toBe(true);
    expect(isSpanSelection(hit())).toBe(false);
  });
});
