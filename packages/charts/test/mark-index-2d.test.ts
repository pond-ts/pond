/**
 * The large-set mark index on the **2-D layers** ([PND-INTERACT2D]'s perf
 * gate) — `<ScatterChart>` and `<HeatMap>`, the two whose live preview is a
 * *rect*.
 *
 * `bars.ts` grew a per-draw set index at 16 entries because a sweep preview
 * puts the whole covered run in `hovered` and the linear scan measured 6.2 s
 * per frame at 100k. A rect fills that set faster than a band can, and
 * neither of these layers had the fix: `scripts/perf-interact2d.mjs` measured
 * **4.0 s per frame** on a scatter with 50k points covered.
 *
 * The index must encode EXACTLY the rule the scan does, so every case here
 * draws the same series twice — once with the meaningful entries alone (the
 * scan path) and once padded past the threshold (the index path) — and pins
 * that the two emit the same thing. A padded case that merely "looks right"
 * proves nothing; the equivalence is the assertion.
 */
import { describe, expect, it } from 'vitest';
import { drawScatter } from '../src/scatter.js';
import { drawHeat } from '../src/heat.js';
import { defaultTheme } from '../src/theme.js';
import { recordingContext } from './canvas-mock.js';
import type { CtxCall } from './canvas-mock.js';
import type { ChartSeries, StackedBarSeries } from '../src/data.js';
import type { SelectInfo } from '../src/context.js';

const identity = Object.assign((v: number) => v, {
  domain: () => [0, 100],
  range: () => [0, 100],
  invert: (v: number) => v,
}) as never;

/**
 * Seventeen entries of a FOREIGN series id — enough to cross the threshold.
 * They must keep matching nothing, which is the id filter under test, so
 * their keys **deliberately collide** with real marks: a pad off in unused
 * key space would let an index that dropped the id filter still pass.
 */
const padForeign = <T extends { id: string; key: number }>(
  entries: readonly T[],
  collideWith: readonly number[],
): T[] => [
  ...entries,
  ...Array.from({ length: 17 }, (_, i) => ({
    ...(entries[0] as T),
    id: 'other',
    key: collideWith[i % collideWith.length]!,
  })),
];

// ── <ScatterChart> ─────────────────────────────────────────────────────────

describe('the scatter key index matches exactly like the scan', () => {
  const N = 20;
  const cs: ChartSeries = {
    x: Float64Array.from(Array.from({ length: N }, (_, i) => i)),
    y: Float64Array.from(Array.from({ length: N }, () => 50)),
    length: N,
  };
  const encoding = {
    uniform: true,
    radiusAt: () => 4,
    colorAt: () => '#rest',
    length: N,
  } as never;
  const style = { ...defaultTheme.scatter.default, color: '#rest' };

  /** The fill in effect at each `fill()` — one entry per drawn point, in
   *  draw order, naming the state it came out in. */
  const fillSeq = (calls: readonly CtxCall[]): string[] => {
    const out: string[] = [];
    let last = '';
    for (const c of calls) {
      if (c.type === 'set' && c.name === 'fillStyle') last = String(c.args[0]);
      else if (c.type === 'call' && c.name === 'fill') out.push(last);
    }
    return out;
  };

  const draw = (selected: SelectInfo[], hovered: SelectInfo[]) => {
    const { ctx, calls } = recordingContext();
    drawScatter(
      ctx,
      cs,
      identity,
      identity,
      style,
      encoding,
      (i) => cs.x[i]!,
      undefined,
      { family: 'sans', size: 10 },
      selected,
      hovered,
      'pts',
      0,
      false,
    );
    return fillSeq(calls);
  };
  /** Every real point key, so the foreign pad collides with all of them. */
  const PTS_KEYS = Array.from({ length: N }, (_, i) => i);
  const mark = (key: number): SelectInfo => ({
    id: 'pts',
    key,
    value: 50,
    color: '#abc',
    label: 'v',
  });

  it('a padded `selected` set lights the same points as the scan', () => {
    const meaningful = [mark(3), mark(7)];
    const scan = draw(meaningful, []);
    expect(draw(padForeign(meaningful, PTS_KEYS), [])).toEqual(scan);
    // …and not vacuously: exactly two points came out in the selected fill,
    // and the rest receded.
    const sel = defaultTheme.scatter.default.states!.selected;
    expect(scan.filter((f) => f === sel)).toHaveLength(2);
    expect(scan.filter((f) => f === '#rest')).toHaveLength(N - 2);
  });

  it('a padded `hovered` set lights the same points as the scan', () => {
    const meaningful = [mark(1), mark(2), mark(11)];
    const scan = draw([], meaningful);
    expect(draw([], padForeign(meaningful, PTS_KEYS))).toEqual(scan);
    const hov = defaultTheme.scatter.default.states!.hover;
    expect(scan.filter((f) => f === hov)).toHaveLength(3);
  });

  it('selection still outranks hover once BOTH sets are indexed', () => {
    // The precedence lives in the loop, not the lookup — but an index that
    // answered the two in the wrong order would only show up here.
    const sel = [mark(4), mark(5)];
    const hov = [mark(5), mark(6)];
    const scan = draw(sel, hov);
    expect(draw(padForeign(sel, PTS_KEYS), padForeign(hov, PTS_KEYS))).toEqual(
      scan,
    );
    const S = defaultTheme.scatter.default.states!;
    expect(scan.filter((f) => f === S.selected)).toHaveLength(2);
    expect(scan.filter((f) => f === S.hover)).toHaveLength(1); // 5 went selected
  });

  it('padding with SAME-id, non-matching keys still lights only the real ones', () => {
    // The foreign-id pad above exercises the id filter; this exercises the
    // key set itself, which is the half an over-eager index would break.
    const meaningful = [mark(3)];
    const scan = draw(meaningful, []);
    const padded = [
      ...meaningful,
      ...Array.from({ length: 17 }, (_, i) => mark(100 + i)),
    ];
    expect(draw(padded, [])).toEqual(scan);
  });
});

// ── <HeatMap> ──────────────────────────────────────────────────────────────

describe('the heat bin-label index matches exactly like the scan', () => {
  const BINS = 6;
  const G = 2;
  const groups = ['lo', 'hi'];
  const grid = (marks?: string[]): StackedBarSeries => ({
    begin: Float64Array.from(Array.from({ length: BINS }, (_, i) => i * 10)),
    end: Float64Array.from(Array.from({ length: BINS }, (_, i) => i * 10 + 10)),
    values: Float64Array.from(
      Array.from({ length: BINS * G }, (_, i) => (i % 4) + 1),
    ),
    groups,
    length: BINS,
    ...(marks !== undefined ? { marks } : {}),
  });
  const style = {
    opacity: 1,
    highlight: '#hl',
    outlineWidth: 1,
    gap: 0,
    minWidth: 1,
    gridColor: '#eee',
    states: defaultTheme.heat!.default,
  };
  const colorOf = () => '#rest';

  /**
   * Which cells came out live, in which state, and **where** — read off the
   * stroke ink the way `heat-plural-highlight` does, so this measures what a
   * reader sees rather than an internal flag.
   *
   * The position is not decoration. A first draft returned only the states,
   * and an index that read the wrong map still produced `['selected']` — one
   * cell lit, just the *wrong* cell. Under `identity` scales a bin's x is its
   * begin and a row's y is its slot, so `selected@20,1` names the cell.
   */
  const liveSeq = (calls: readonly CtxCall[]): string[] => {
    const st = defaultTheme.heat!.default;
    const out: string[] = [];
    let ink: unknown;
    let minX = Infinity;
    let minY = Infinity;
    let open = false;
    for (const c of calls) {
      if (c.type === 'set' && c.name === 'strokeStyle') ink = c.args[0];
      else if (c.name === 'strokeRect' && ink === st.hoverRing[0])
        out.push(
          `hover@${Math.round(c.args[0] as number)},${Math.round(c.args[1] as number)}`,
        );
      else if (c.name === 'beginPath') {
        minX = Infinity;
        minY = Infinity;
        open = true;
      } else if (open && (c.name === 'moveTo' || c.name === 'lineTo')) {
        minX = Math.min(minX, c.args[0] as number);
        minY = Math.min(minY, c.args[1] as number);
      } else if (c.name === 'stroke' && ink === st.perimeter && open) {
        out.push(`selected@${Math.round(minX)},${Math.round(minY)}`);
        open = false;
      }
    }
    return out;
  };

  const draw = (
    ss: StackedBarSeries,
    selected: SelectInfo[],
    hovered: SelectInfo[],
  ) => {
    const { ctx, calls } = recordingContext();
    drawHeat(
      ctx,
      ss,
      identity,
      identity,
      style,
      colorOf,
      'temp',
      selected,
      hovered,
      false,
    );
    return liveSeq(calls);
  };
  /** Every real bin begin, so the foreign pad collides with all of them. */
  const BIN_KEYS = Array.from({ length: BINS }, (_, i) => i * 10);
  const cell = (b: number, label: string, mark?: string): SelectInfo => ({
    id: 'temp',
    key: b * 10,
    value: 0,
    color: '#abc',
    label,
    ...(mark !== undefined ? { mark } : {}),
  });

  it('a padded `selected` set lights the same cells as the scan', () => {
    const meaningful = [cell(1, 'lo'), cell(1, 'hi'), cell(4, 'lo')];
    const scan = draw(grid(), meaningful, []);
    expect(draw(grid(), padForeign(meaningful, BIN_KEYS), [])).toEqual(scan);
    // Bin 1 (x=10) both rows, bin 4 (x=40) the lower one.
    expect(scan).toEqual(['selected@10,0', 'selected@10,1', 'selected@40,0']);
  });

  it('a padded `hovered` set lights the same cells as the scan', () => {
    const meaningful = [cell(0, 'hi'), cell(3, 'lo')];
    const scan = draw(grid(), [], meaningful);
    expect(draw(grid(), [], padForeign(meaningful, BIN_KEYS))).toEqual(scan);
    // Bin 0 upper row and bin 3 lower — the ring rects are inset, hence the
    // off-by-one pixels against the cell corner.
    expect(scan).toEqual(['hover@1,2', 'hover@31,1']);
  });

  it('the mark-vs-key pairwise rule survives the index', () => {
    // The asymmetry the two-map index exists to encode. A bin WITH a stable
    // mark matches only entries carrying that mark — a markless entry whose
    // key happens to equal the bin's begin must NOT light it.
    const marks = Array.from({ length: BINS }, (_, i) => `m${i}`);
    const meaningful = [
      // Marked entry, bogus key: the mark decides, so bin 2 lights.
      cell(999, 'lo', 'm2'),
      // Markless entry against a MARKED bin: matches nothing.
      cell(5, 'hi'),
    ];
    const scan = draw(grid(marks), meaningful, []);
    expect(draw(grid(marks), padForeign(meaningful, BIN_KEYS), [])).toEqual(
      scan,
    );
    // Bin 2 (x=20), NOT bin 5 — naming the cell is the point: an index
    // reading the wrong map lights one cell either way.
    expect(scan).toEqual(['selected@20,0']);
  });

  it('…and the key fallback still applies on an UNMARKED grid', () => {
    // The other side of the same rule: with no stable marks, a marked entry
    // falls back to its key like any other.
    const meaningful = [cell(2, 'lo', 'ignored'), cell(5, 'hi')];
    const scan = draw(grid(), meaningful, []);
    expect(draw(grid(), padForeign(meaningful, BIN_KEYS), [])).toEqual(scan);
    expect(scan).toEqual(['selected@20,0', 'selected@50,1']);
  });

  it('the perimeter is the same whether the grid came from the index or the scan', () => {
    // The neighbour grid is built through the same narrowing, so an index
    // that disagreed with the scan would draw a DIFFERENT outline — not just
    // a different set of lit cells. Compare the edges, not only the states.
    const edges = (ss: StackedBarSeries, sel: SelectInfo[]) => {
      const { ctx, calls } = recordingContext();
      drawHeat(
        ctx,
        ss,
        identity,
        identity,
        style,
        colorOf,
        'temp',
        sel,
        [],
        false,
      );
      return calls.filter((c) => c.name === 'lineTo').length;
    };
    const block = [cell(1, 'lo'), cell(1, 'hi'), cell(2, 'lo'), cell(2, 'hi')];
    // A 2-wide, 2-tall block: eight perimeter edges, not sixteen.
    expect(edges(grid(), block)).toBe(8);
    expect(edges(grid(), padForeign(block, BIN_KEYS))).toBe(8);
  });
});
