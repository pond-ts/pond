import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  bind,
  createRegistry,
  int,
  columnView,
  packColumn,
  prepareRange,
  run,
  sealRange,
  type Input,
  type OpDef,
  type Registry,
  type Spec,
} from '../src/index.js';
import type { Column } from 'pond-ts';

/**
 * [PND-PROCRANGE] — recompute only the rows a change reached.
 *
 * The acceptance bar is not the speedup. It is that a patched result is
 * **bit-identical** to a from-scratch one: an incremental answer that
 * merely agrees to rounding is an answer that depends on the sequence of
 * edits that produced it, and two callers holding the same data would
 * disagree. That is why `runRange` is opt-in per op rather than derived.
 */
describe('[PND-PROCRANGE] ranged recompute', () => {
  function bars(n: number): TimeSeries<never> {
    const time = new Float64Array(n);
    const px = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      time[i] = i * 60_000;
      px[i] = 100 + Math.sin(i / 5) * 10 + (i % 13) * 0.25;
    }
    return TimeSeries.fromColumns({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'px', kind: 'number' },
      ],
      columns: { time, px },
    }) as never;
  }

  /** Reads a column as a plain array, gaps as undefined. */
  const read = (ctx: Parameters<OpDef['run']>[0], role: string) => {
    const col = ctx.series.column(ctx.inputs[role]!) as unknown as {
      length: number;
      at(i: number): number | undefined;
    };
    const out = new Array<number | undefined>(col.length);
    for (let i = 0; i < col.length; i += 1) out[i] = col.at(i);
    return out;
  };

  /** Rolling mean over one window, or undefined inside the warm-up. */
  function meanAt(
    v: readonly (number | undefined)[],
    i: number,
    period: number,
  ): number | undefined {
    if (i < period - 1) return undefined;
    let sum = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      const x = v[k];
      if (x === undefined) return undefined;
      sum += x;
    }
    return sum / period;
  }

  /**
   * An SMA that computes each output cell from the input window alone.
   *
   * That independence is what makes a patched result bit-identical: no
   * accumulator carries a rounding history across the boundary, so
   * recomputing `[from, to)` gives the same doubles as recomputing all
   * of it. An op with a running accumulator would need
   * [PND-PROCKERN]'s range-exact kernel to make the same claim, and one
   * with neither must not declare `runRange` at all.
   */
  function smaDef(counter: { runs: number; ranges: number }): OpDef {
    return {
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      lookback: (p) => (p['period'] as number) - 1,
      run: (ctx) => {
        counter.runs += 1;
        const v = read(ctx, 'source');
        const period = ctx.params['period'] as number;
        return v.map((_, i) => meanAt(v, i, period));
      },
      runRange: (ctx) => {
        counter.ranges += 1;
        const v = read(ctx, 'source');
        const period = ctx.params['period'] as number;
        const prior = ctx.previous[0] as unknown as {
          length: number;
          at(i: number): number | undefined;
        };
        const out = new Array<number | undefined>(v.length);
        // Everything before `from` is carried over untouched — the whole
        // point — and only `[from, to)` is recomputed.
        for (let i = 0; i < ctx.from && i < prior.length; i += 1) {
          out[i] = prior.at(i);
        }
        for (let i = ctx.from; i < ctx.to; i += 1)
          out[i] = meanAt(v, i, period);
        return out;
      },
    };
  }

  const spec = (period: number, input: Input = 'px'): Spec => ({
    op: 'sma',
    params: { period },
    inputs: [input],
  });

  function cells(out: ReturnType<typeof run>): (number | undefined)[] {
    const col = Object.values(out.columns ?? {})[0] as unknown as {
      length: number;
      at(i: number): number | undefined;
    };
    return Array.from({ length: col.length }, (_, i) => col.at(i));
  }

  function registry(counter: { runs: number; ranges: number }): Registry {
    return createRegistry().define(smaDef(counter));
  }

  it('is bit-identical to a from-scratch pass across many appends', () => {
    const counter = { runs: 0, ranges: 0 };
    const reg = registry(counter);
    const START = 300;
    const APPENDS = 25;
    const s = spec(20);

    const graph = bind(bars(START), { registry: reg });
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });

    for (let step = 1; step <= APPENDS; step += 1) {
      const grown = bars(START + step);
      const previousLength = START + step - 1;
      graph.setSourceFrom(grown, previousLength);
      const incremental = run(graph, {
        plan: [s],
        select: [{ on: s }],
        assemble: false,
      });

      const scratch = run(
        bind(grown, { registry: registry({ runs: 0, ranges: 0 }) }),
        {
          plan: [s],
          select: [{ on: s }],
          assemble: false,
        },
      );
      // `toEqual` on the full cell arrays: Object.is semantics per cell,
      // so this is bit-identity and not a tolerance.
      expect(cells(incremental), `append ${step}`).toEqual(cells(scratch));
    }
    expect(
      counter.ranges,
      'every append after the first must have ranged',
    ).toBe(APPENDS);
  });

  it('is bit-identical through a two-deep chain', () => {
    // The case the plan singled out: sma-of-sma, where the inner node's
    // ranged output becomes the outer node's input. If the inner one
    // patched imperfectly the outer would compound it.
    const counter = { runs: 0, ranges: 0 };
    const reg = registry(counter);
    const outer = spec(5, spec(30));
    const START = 400;

    const graph = bind(bars(START), { registry: reg });
    run(graph, { plan: [outer], select: [{ on: outer }], assemble: false });

    for (let step = 1; step <= 25; step += 1) {
      const grown = bars(START + step);
      graph.setSourceFrom(grown, START + step - 1);
      const incremental = run(graph, {
        plan: [outer],
        select: [{ on: outer }],
        assemble: false,
      });
      const scratch = run(
        bind(grown, { registry: registry({ runs: 0, ranges: 0 }) }),
        { plan: [outer], select: [{ on: outer }], assemble: false },
      );
      expect(cells(incremental), `chain append ${step}`).toEqual(
        cells(scratch),
      );
    }
  });

  it('widens backwards by the lookback, for an op that reads forward', () => {
    // Worth stating precisely, because the plan's formula reads the other
    // way round and the first version of this test was vacuous.
    //
    // For a TRAILING window, a change at row r dirties output cells
    // [r, r + period) — FORWARD. Since the graph always recomputes to the
    // end of the series, `[changedFrom, length)` already covers that, and
    // subtracting the lookback only recomputes unaffected cells. Removing
    // the subtraction does not fail any trailing-window test, which is how
    // this was found.
    //
    // What the subtraction actually buys is correctness for a NON-CAUSAL
    // op — one whose output at i reads rows after i. There a change at r
    // dirties cells before r, which nothing else would reach. The graph
    // cannot tell the two apart, so it pays the margin.
    const H = 4;
    const N = 200;
    const centered = createRegistry().define({
      name: 'sma',
      family: 'trend',
      summary: 'Centered mean — reads H rows either side.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      lookback: () => H,
      run: (ctx) => centeredMean(read(ctx, 'source')),
      runRange: (ctx) => {
        const v = read(ctx, 'source');
        const prior = ctx.previous[0] as unknown as {
          at(i: number): number | undefined;
          length: number;
        };
        const fresh = centeredMean(v);
        const out = new Array<number | undefined>(v.length);
        for (let i = 0; i < ctx.from && i < prior.length; i += 1)
          out[i] = prior.at(i);
        for (let i = ctx.from; i < ctx.to; i += 1) out[i] = fresh[i];
        return out;
      },
    });
    function centeredMean(v: readonly (number | undefined)[]) {
      return v.map((_, i) => {
        if (i < H || i + H >= v.length) return undefined;
        let sum = 0;
        for (let k = i - H; k <= i + H; k += 1) sum += v[k]!;
        return sum / (2 * H + 1);
      });
    }

    const s0 = spec(9);
    const graph = bind(bars(N), { registry: centered });
    run(graph, { plan: [s0], select: [{ on: s0 }], assemble: false });

    const edited = bars(N);
    const px = (
      edited as unknown as { column(n: string): { _values: Float64Array } }
    ).column('px')._values;
    px[N - 20] = 999;
    expect(
      (edited as unknown as { column(n: string): { at(i: number): number } })
        .column('px')
        .at(N - 20),
      'the edit must be visible, or this test proves nothing',
    ).toBe(999);

    graph.setSourceFrom(edited as never, N - 20);
    const incremental = run(graph, {
      plan: [s0],
      select: [{ on: s0 }],
      assemble: false,
    });
    const scratch = run(bind(edited as never, { registry: centered }), {
      plan: [s0],
      select: [{ on: s0 }],
      assemble: false,
    });
    // Cells [N-24, N-20) are dirty and sit BEFORE the changed row. Only
    // the lookback widening reaches them.
    expect(cells(incremental)).toEqual(cells(scratch));
  });

  it('widens by the ACCUMULATED chain lookback, not its own', () => {
    // Found by a Codex pass on PR #571. With `win(5)` over `win(30)`, a
    // change at source row 70 reaches the outer node's row 37 — its input
    // changed from row 70-29=41, and the outer reads 4 rows further back
    // still. Using only the node's OWN lookback started it at 70-4=66, so
    // row 37 kept its stale value: incremental 70, from-scratch 999.
    //
    // Every trailing-window test passed throughout, because a trailing
    // change propagates FORWARD and `to = length` already covers it. Only
    // a non-causal chain exposes it. `requiredHistory` over the one spec
    // is exactly the accumulated sum, so the fix is the other ticket.
    const N = 200;
    const AHEAD = 'period';
    const forward = createRegistry().define({
      name: 'win',
      family: 'trend',
      summary: 'Mean of the NEXT period-1 rows — deliberately non-causal.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      lookback: (p) => (p[AHEAD] as number) - 1,
      run: (ctx) =>
        forwardMean(read(ctx, 'source'), ctx.params[AHEAD] as number),
      runRange: (ctx) => {
        const v = read(ctx, 'source');
        const fresh = forwardMean(v, ctx.params[AHEAD] as number);
        const prior = ctx.previous[0] as unknown as {
          at(i: number): number | undefined;
          length: number;
        };
        const out = new Array<number | undefined>(v.length);
        for (let i = 0; i < ctx.from && i < prior.length; i += 1)
          out[i] = prior.at(i);
        for (let i = ctx.from; i < ctx.to; i += 1) out[i] = fresh[i];
        return out;
      },
    });
    function forwardMean(v: readonly (number | undefined)[], period: number) {
      return v.map((_, i) => {
        if (i + period > v.length) return undefined;
        let sum = 0;
        for (let k = i; k < i + period; k += 1) {
          const x = v[k];
          if (x === undefined) return undefined;
          sum += x;
        }
        return sum / period;
      });
    }

    const chain = {
      op: 'win',
      params: { period: 5 },
      inputs: [{ op: 'win', params: { period: 30 }, inputs: ['px'] }],
    };
    const graph = bind(bars(N), { registry: forward });
    run(graph, { plan: [chain], select: [{ on: chain }], assemble: false });

    const edited = bars(N);
    const px = (
      edited as unknown as { column(n: string): { _values: Float64Array } }
    ).column('px')._values;
    px[70] = 999;
    expect(
      (edited as unknown as { column(n: string): { at(i: number): number } })
        .column('px')
        .at(70),
      'the edit must be visible, or this test proves nothing',
    ).toBe(999);

    graph.setSourceFrom(edited as never, 70);
    const incremental = run(graph, {
      plan: [chain],
      select: [{ on: chain }],
      assemble: false,
    });
    const scratch = run(bind(edited as never, { registry: forward }), {
      plan: [chain],
      select: [{ on: chain }],
      assemble: false,
    });
    expect(cells(incremental)).toEqual(cells(scratch));
  });

  it('does not skip a generation it was not pulled for', () => {
    // Found by a Codex pass on PR #571, and it produced silently wrong
    // answers. The dirty marker used to be graph-wide. Nodes compute
    // LAZILY, so a node computed at V0, not pulled at V1, and pulled at
    // V2 patched its V0 output using V2's boundary — skipping everything
    // V1 changed. Repro then: rows 20-22 kept [57,60,63] where a
    // from-scratch pass gave [1036,1039,1042]. The marker is now per node
    // and accumulates as a running minimum until that node recomputes.
    const counter = { runs: 0, ranges: 0 };
    const reg = registry(counter);
    const s0 = spec(3);
    const N = 200;

    const graph = bind(bars(N), { registry: reg });
    run(graph, { plan: [s0], select: [{ on: s0 }], assemble: false });

    const edit = (at: number, value: number) => {
      const next = bars(N);
      (
        next as unknown as { column(n: string): { _values: Float64Array } }
      ).column('px')._values[at] = value;
      return next;
    };

    // V1 changes row 20 — and is deliberately NOT pulled.
    graph.setSourceFrom(edit(20, 1000) as never, 20);

    // V2 changes row 80 as well, and now we pull. Both edits must land.
    const both = bars(N);
    const px = (
      both as unknown as { column(n: string): { _values: Float64Array } }
    ).column('px')._values;
    px[20] = 1000;
    px[80] = 2000;
    graph.setSourceFrom(both as never, 80);

    const incremental = run(graph, {
      plan: [s0],
      select: [{ on: s0 }],
      assemble: false,
    });
    const scratch = run(
      bind(both as never, { registry: registry({ runs: 0, ranges: 0 }) }),
      {
        plan: [s0],
        select: [{ on: s0 }],
        assemble: false,
      },
    );
    expect(cells(incremental)).toEqual(cells(scratch));
  });

  it('a missed full replacement is not downgraded by a later partial claim', () => {
    // The same lazy-pull hazard from the other side. If a node misses a
    // `setSource` and is then handed a `setSourceFrom`, it must still
    // recompute wholly — the rows before that boundary changed too, and
    // nothing remembers by how much.
    const counter = { runs: 0, ranges: 0 };
    const reg = registry(counter);
    const s0 = spec(3);
    const N = 120;

    const graph = bind(bars(N), { registry: reg });
    run(graph, { plan: [s0], select: [{ on: s0 }], assemble: false });

    const replaced = bars(N);
    const px = (
      replaced as unknown as { column(n: string): { _values: Float64Array } }
    ).column('px')._values;
    for (let i = 0; i < N; i += 1) px[i] = i * 3;
    graph.setSource(replaced as never); // not pulled
    graph.setSourceFrom(replaced as never, N - 2); // a narrow claim

    const incremental = run(graph, {
      plan: [s0],
      select: [{ on: s0 }],
      assemble: false,
    });
    const scratch = run(
      bind(replaced as never, { registry: registry({ runs: 0, ranges: 0 }) }),
      { plan: [s0], select: [{ on: s0 }], assemble: false },
    );
    expect(cells(incremental)).toEqual(cells(scratch));
  });

  it('falls back to a full recompute when anything is missing', () => {
    const counter = { runs: 0, ranges: 0 };
    const reg = registry(counter);
    const s = spec(20);
    const graph = bind(bars(200), { registry: reg });

    // First compute: no previous to patch.
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });
    expect(graph.recomputes).toEqual({ ranged: 0, full: 1 });

    // `setSource`, not `setSourceFrom`: the caller made no claim about
    // what changed, so nothing may be reused.
    graph.setSource(bars(201) as never);
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });
    expect(graph.recomputes).toEqual({ ranged: 0, full: 2 });

    // And now with a claim.
    graph.setSourceFrom(bars(202) as never, 201);
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });
    expect(graph.recomputes).toEqual({ ranged: 1, full: 2 });
  });

  it('never ranges an op that declared no runRange', () => {
    // The safety property. An op whose kernel is not range-exact simply
    // does not declare `runRange`, and gets full recomputes forever —
    // correct, and merely slower.
    const plain = createRegistry().define({
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean, whole-series only.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      lookback: (p) => (p['period'] as number) - 1,
      run: (ctx) => {
        const v = read(ctx, 'source');
        const period = ctx.params['period'] as number;
        return v.map((_, i) => meanAt(v, i, period));
      },
    });
    const s = spec(20);
    const graph = bind(bars(200), { registry: plain });
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });
    graph.setSourceFrom(bars(201) as never, 200);
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });
    expect(graph.recomputes).toEqual({ ranged: 0, full: 2 });
  });

  it('does not range an op that declared no lookback', () => {
    // Without a lookback the graph cannot know how far back a change
    // reaches, so it must not guess — declaring `runRange` alone is not
    // enough to be ranged.
    // Built by omitting the key, not by setting it `undefined` —
    // `exactOptionalPropertyTypes` treats those as different, and the
    // point is an op that never declared one.
    const { lookback: _dropped, ...withoutLookback } = smaDef({
      runs: 0,
      ranges: 0,
    });
    const noLookback = createRegistry().define(withoutLookback);
    const s = spec(20);
    const graph = bind(bars(200), { registry: noLookback });
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });
    graph.setSourceFrom(bars(201) as never, 200);
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });
    expect(graph.recomputes).toEqual({ ranged: 0, full: 2 });
  });

  it('accepts a Column back from runRange, not only loose values', () => {
    const reg = createRegistry().define({
      ...smaDef({ runs: 0, ranges: 0 }),
      runRange: (ctx) => {
        const prior = ctx.previous[0] as unknown as {
          length: number;
          at(i: number): number | undefined;
        };
        const out = new Array<number | undefined>(ctx.to);
        for (let i = 0; i < ctx.from && i < prior.length; i += 1)
          out[i] = prior.at(i);
        for (let i = ctx.from; i < ctx.to; i += 1) out[i] = i;
        return packColumn(out) as Column;
      },
    });
    const s = spec(20);
    const graph = bind(bars(100), { registry: reg });
    run(graph, { plan: [s], select: [{ on: s }], assemble: false });
    graph.setSourceFrom(bars(101) as never, 100);
    const out = run(graph, { plan: [s], select: [{ on: s }], assemble: false });
    expect(cells(out).at(-1)).toBe(100);
  });
});

describe('[PND-PROCRANGE] the prepared output contract', () => {
  it('carries a gapped prefix as gaps, not as defined zeros', () => {
    // The bug this contract exists to make unwritable. Packed storage
    // holds `0` at a missing cell, not `NaN`, so an op copying only
    // `values` forward turns every warm-up gap into a defined zero —
    // 1,875 wrong cells on a 5-study pass, and nothing in the type
    // system objects. `prepareRange` moves validity with the values.
    const prior = packColumn([undefined, undefined, 3, 4, undefined, 6]);
    const view = columnView(prior)!;
    const out = prepareRange(8, 5, view);
    // Rows the op will not touch keep their exact prior state.
    expect(out.values[2]).toBe(3);
    expect((out.bits[0]! & (1 << 0)) !== 0, 'row 0 was a gap').toBe(false);
    expect((out.bits[0]! & (1 << 1)) !== 0, 'row 1 was a gap').toBe(false);
    expect((out.bits[0]! & (1 << 2)) !== 0, 'row 2 was defined').toBe(true);
    expect((out.bits[0]! & (1 << 4)) !== 0, 'row 4 was a gap').toBe(false);
  });

  it('masks the byte straddling the boundary', () => {
    // `keep` rarely lands on a byte edge. The bits past it in that byte
    // describe rows the op is about to rewrite, and carrying them over
    // would leave a cell marked defined before anything wrote to it.
    // Gapped on purpose: a gapless prior carries no bitmap at all and
    // takes the other branch, so this test passed with the mask deleted
    // until the prior was given a gap.
    const prior = packColumn([1, 2, 3, 4, 5, undefined, 7, 8, 9, 10]);
    const out = prepareRange(10, 3, columnView(prior)!);
    expect((out.bits[0]! & (1 << 2)) !== 0, 'row 2 is kept').toBe(true);
    expect(
      (out.bits[0]! & (1 << 3)) !== 0,
      'row 3 is past the boundary and must not be marked',
    ).toBe(false);
    expect(out.bits[0]! & 0b11111000).toBe(0);
  });

  it('treats a bitmap-free prior as wholly defined', () => {
    const out = prepareRange(6, 4, columnView(packColumn([1, 2, 3, 4]))!);
    for (let i = 0; i < 4; i += 1) {
      expect((out.bits[0]! & (1 << i)) !== 0, `row ${i}`).toBe(true);
    }
    expect((out.bits[0]! & (1 << 4)) !== 0, 'row 4 unwritten').toBe(false);
  });

  it('seals to a column that round-trips values and gaps', () => {
    const out = prepareRange(5, 0, undefined);
    out.set(0, 10);
    out.clear(1);
    out.set(2, 30);
    out.set(3, 40);
    out.clear(4);
    const sealed = sealRange(out, 5) as unknown as {
      length: number;
      at(i: number): number | undefined;
    };
    expect(sealed.length).toBe(5);
    expect([0, 1, 2, 3, 4].map((i) => sealed.at(i))).toEqual([
      10,
      undefined,
      30,
      40,
      undefined,
    ]);
  });

  it('omits the bitmap when nothing is missing', () => {
    // The gapless convention the rest of the package relies on — a
    // column with no gaps carries no bitmap, which is also what lets
    // `appendColumn` round-trip it without boxing.
    const out = prepareRange(4, 0, undefined);
    for (let i = 0; i < 4; i += 1) out.set(i, i + 1);
    const sealed = sealRange(out, 4) as unknown as { validity?: unknown };
    expect(sealed.validity).toBeUndefined();
  });

  it('carries no prefix when there is no previous output', () => {
    const out = prepareRange(4, 3, undefined);
    expect(out.bits.every((b) => b === 0)).toBe(true);
  });

  it('stops at the prior length when the series grew', () => {
    // `keep` is derived from the CURRENT length; the previous output is
    // shorter after an append, and reading past it would copy garbage.
    const out = prepareRange(10, 8, columnView(packColumn([1, 2, 3]))!);
    expect((out.bits[0]! & (1 << 2)) !== 0).toBe(true);
    expect((out.bits[0]! & (1 << 3)) !== 0, 'past the prior end').toBe(false);
  });
});

describe('[PND-PROCRANGE] the void path, through the graph', () => {
  // The gap a Layer 2 review found on PR #573: three separate ablations
  // in `graph.ts` — deleting the seal branch, passing `keep: 0`, passing
  // `prior: undefined` — each left 222/222 green, because every
  // graph-level op in this file returned a whole result. The feature's
  // headline path was exercised only by an uncommitted perf script.
  const N = 300;
  const P = 8;

  function bars(n: number, bump = 0): TimeSeries<never> {
    const time = new Float64Array(n);
    const px = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      time[i] = i * 60_000;
      px[i] = 100 + Math.sin(i / 5) * 10 + bump;
    }
    return TimeSeries.fromColumns({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'px', kind: 'number' },
      ],
      columns: { time, px },
    }) as never;
  }

  /** Writes into `ctx.out` and returns nothing — the path under test. */
  function voidRegistry(): Registry {
    return createRegistry().define({
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean, written into the prepared buffer.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      lookback: (p) => (p['period'] as number) - 1,
      run: (ctx) => {
        const v = readCol(ctx);
        return v.map((_, i) => mean(v, i, ctx.params['period'] as number));
      },
      runRange: (ctx) => {
        const v = readCol(ctx);
        const period = ctx.params['period'] as number;
        const out = ctx.out[0]!;
        for (let i = ctx.from; i < ctx.to; i += 1) {
          const m = mean(v, i, period);
          if (m === undefined) out.clear(i);
          else out.set(i, m);
        }
      },
    });
  }
  function readCol(ctx: Parameters<OpDef['run']>[0]) {
    const col = ctx.series.column(ctx.inputs['source']!) as unknown as {
      length: number;
      at(i: number): number | undefined;
    };
    return Array.from({ length: col.length }, (_, i) => col.at(i));
  }
  function mean(
    v: readonly (number | undefined)[],
    i: number,
    period: number,
  ): number | undefined {
    if (i < period - 1) return undefined;
    let sum = 0;
    for (let k = i - period + 1; k <= i; k += 1) {
      const x = v[k];
      if (x === undefined) return undefined;
      sum += x;
    }
    return sum / period;
  }

  const s0 = { op: 'sma', params: { period: P }, inputs: ['px'] };
  const cellsOf = (out: ReturnType<typeof run>) => {
    const col = Object.values(out.columns ?? {})[0] as unknown as {
      length: number;
      at(i: number): number | undefined;
    };
    return Array.from({ length: col.length }, (_, i) => col.at(i));
  };

  it('an op that writes into ctx.out matches a from-scratch pass', () => {
    // Fails if the seal branch is deleted, if `keep` is forced to 0 (the
    // prefix comes back all-missing), or if the prior view is dropped.
    const reg = voidRegistry();
    const graph = bind(bars(N), { registry: reg });
    run(graph, { plan: [s0], select: [{ on: s0 }], assemble: false });

    for (let step = 1; step <= 12; step += 1) {
      const grown = bars(N + step);
      graph.setSourceFrom(grown, N + step - 1);
      const incremental = run(graph, {
        plan: [s0],
        select: [{ on: s0 }],
        assemble: false,
      });
      const scratch = run(bind(grown, { registry: voidRegistry() }), {
        plan: [s0],
        select: [{ on: s0 }],
        assemble: false,
      });
      expect(cellsOf(incremental), `append ${step}`).toEqual(cellsOf(scratch));
    }
    expect(graph.recomputes.ranged).toBe(12);
  });

  it('keeps the warm-up head as GAPS, not as defined zeros', () => {
    // The specific failure the contract exists to prevent, asserted
    // through the graph rather than on `prepareRange` directly. Packed
    // storage holds 0 at a missing cell, so a prefix carried without its
    // validity reads as a run of zeros here.
    const reg = voidRegistry();
    const graph = bind(bars(N), { registry: reg });
    run(graph, { plan: [s0], select: [{ on: s0 }], assemble: false });
    graph.setSourceFrom(bars(N + 1) as never, N);
    const out = run(graph, {
      plan: [s0],
      select: [{ on: s0 }],
      assemble: false,
    });
    const cells = cellsOf(out);
    for (let i = 0; i < P - 1; i += 1) {
      expect(cells[i], `warm-up row ${i} must be a gap, not 0`).toBeUndefined();
    }
    expect(typeof cells[P - 1]).toBe('number');
  });

  it('clear() undoes a set() made in the same pass', () => {
    // `clear` was vacuously tested — replacing its body with `{}` left
    // the suite green. Working out why is the finding: cells in
    // `[from, to)` start unset and unwritten cells seal as MISSING, so
    // clearing one that was never set is a no-op by construction.
    //
    // `clear` is load-bearing in exactly one situation: undoing a `set`
    // within the same pass, which is what an op does when it computes a
    // provisional value and then discovers the window was incomplete.
    // That is the case worth pinning, and it is documented on
    // `RangeOutput` rather than left for the next author to rediscover.
    const reg = createRegistry().define({
      name: 'sma',
      family: 'trend',
      summary: 'Sets every cell, then retracts the odd ones.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      lookback: () => 0,
      run: (ctx) => readCol(ctx).map((_, i) => i),
      runRange: (ctx) => {
        const out = ctx.out[0]!;
        for (let i = ctx.from; i < ctx.to; i += 1) out.set(i, i * 100);
        for (let i = ctx.from; i < ctx.to; i += 1) {
          if (i % 2 === 1) out.clear(i);
        }
      },
    });
    const graph = bind(bars(20), { registry: reg });
    run(graph, { plan: [s0], select: [{ on: s0 }], assemble: false });
    graph.setSourceFrom(bars(20, 1) as never, 15);
    const cells = cellsOf(
      run(graph, { plan: [s0], select: [{ on: s0 }], assemble: false }),
    );
    expect(cells[14], 'before the boundary — carried from the prefix').toBe(14);
    expect(cells[16], 'set, and kept').toBe(1600);
    expect(cells[15], 'set, then cleared').toBeUndefined();
    expect(cells[19], 'set, then cleared').toBeUndefined();
  });

  it('falls back to a full run when the prefix cannot be viewed', () => {
    // `columnView` declines anything not packed numeric. Preparing from
    // `undefined` would seal the prefix as all-missing and hand it back
    // as an answer — 16 of 21 cells wrong, silently (Layer 2, PR #573).
    //
    // Reached by returning a Column-shaped value that is NOT packed:
    // `toColumns` passes anything carrying a `kind` straight through, so
    // this is the shape core's chunked columns arrive in. An op result
    // built from loose values always packs, which is why the first
    // version of this test could not reach the branch at all.
    const unpacked = (values: readonly (number | undefined)[]) => ({
      kind: 'number' as const,
      storage: 'chunked' as const,
      length: values.length,
      at: (i: number) => values[i],
    });
    const reg = createRegistry().define({
      name: 'sma',
      family: 'trend',
      summary: 'Returns an unpacked column.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      lookback: () => 0,
      run: (ctx) =>
        unpacked(readCol(ctx).map((_, i) => i)) as unknown as ReturnType<
          OpDef['run']
        >,
      runRange: (ctx) => {
        const out = ctx.out[0]!;
        for (let i = ctx.from; i < ctx.to; i += 1) out.set(i, i);
      },
    });

    const graph = bind(bars(40), { registry: reg });
    run(graph, { plan: [s0], select: [{ on: s0 }], assemble: false });
    graph.setSourceFrom(bars(41) as never, 40);
    const out = run(graph, {
      plan: [s0],
      select: [{ on: s0 }],
      assemble: false,
    });

    // It must decline to range rather than seal an all-missing prefix.
    expect(
      graph.recomputes.ranged,
      'an unviewable prior must not be ranged',
    ).toBe(0);
    const cells = cellsOf(out);
    expect(cells[0], 'the prefix must not come back missing').toBe(0);
    expect(cells[39]).toBe(39);
  });

  it('survives a series that shrank', () => {
    // `keep` is derived from the current length, so a shrinking series
    // gives `from > to`; `values.set` then threw `RangeError: offset is
    // out of bounds` before the op ever ran (Layer 2, PR #573).
    const reg = voidRegistry();
    const graph = bind(bars(N), { registry: reg });
    run(graph, { plan: [s0], select: [{ on: s0 }], assemble: false });
    graph.setSourceFrom(bars(20) as never, N - 2);
    const out = run(graph, {
      plan: [s0],
      select: [{ on: s0 }],
      assemble: false,
    });
    const scratch = run(bind(bars(20) as never, { registry: voidRegistry() }), {
      plan: [s0],
      select: [{ on: s0 }],
      assemble: false,
    });
    expect(cellsOf(out)).toEqual(cellsOf(scratch));
  });
});
