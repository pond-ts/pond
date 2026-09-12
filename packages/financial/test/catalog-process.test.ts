import { describe, expect, it } from 'vitest';
import { bind, createRegistry, run } from '@pond-ts/process';
import type { OutputDef } from '@pond-ts/process';
import { STUDIES } from '../src/catalog/index.js';
import type { StudyDescriptor, StudyOutput } from '../src/catalog/index.js';
import {
  bars,
  columnValues,
  expectedColumns,
  minimalOptions,
} from './catalog-fixture.js';

/*
 * The catalog's **cross-package** guard.
 *
 * `catalog.test.ts` validates every descriptor against its own study, so
 * it is structurally blind to a disagreement with a *different* package —
 * which is exactly where the first one turned up: a consumer registering
 * the catalog into a `@pond-ts/process` registry hit a module-load throw
 * on the twelve multi-output studies that claim the bare prefix.
 *
 * The disagreement was never real. `StudyOutput.id` is a **financial
 * column suffix** and `OutputDef.id` is a **process outlet id**: separate
 * namespaces sharing a field name. Process names its own columns
 * (`specId + OutputDef.id`) and matches an op's return to its outputs
 * positionally, so a bridge's suffixes are free — and for those twelve
 * they are forced, because process rejects `''` on a multi-output op.
 *
 * This file pins the bridge in both directions: that the documented map
 * registers all of the catalog, and that skipping it still throws. If
 * either package moves, one of these fails instead of a consumer.
 */

/**
 * The documented bridge. A bare suffix becomes `'value'` — the name
 * process already uses for a bare outlet (`outletKey`) — but **only on a
 * multi-output study**, which is the only place process forbids `''`.
 *
 * The narrowness is the point: on a single-output op `''` is legal and
 * means "the column *is* the spec id", so rewriting it there would rename
 * all seventy-odd single-output columns to `specIdvalue` for no reason.
 */
function outletId(d: StudyDescriptor, output: StudyOutput): string {
  return d.outputs.length > 1 && output.id === '' ? 'value' : output.id;
}

/** One `OpDef` per descriptor, bridged. */
function toOpDef(d: StudyDescriptor) {
  return {
    name: d.name,
    family: d.family,
    summary: d.summary,
    // The bridge's subject is the OUTPUT namespace; params are left to
    // the study's own defaults so this file fails for one reason only.
    params: {},
    inputs: d.inputs.map((i) => ({ role: i.role })),
    outputs: d.outputs.map(
      (o): OutputDef => ({ id: outletId(d, o), unit: o.unit }),
    ),
    run: (ctx: {
      series: unknown;
      inputs: Readonly<Record<string, string>>;
    }) => {
      const options: Record<string, unknown> = {
        ...minimalOptions(d),
        // The plan layer binds each input column under its role, so the
        // study reads them by the names it already uses.
        ...Object.fromEntries(
          d.inputs.map((i) => [i.role, ctx.inputs[i.role]]),
        ),
      };
      const out = d.run(ctx.series as never, options) as never;
      const columns = expectedColumns(d).map((name) => columnValues(out, name));
      // `toColumns` unwraps a single-output return rather than indexing
      // it, so a one-output op hands back the column itself.
      return columns.length === 1 ? columns[0]! : columns;
    },
  };
}

const BARE_MULTI = STUDIES.filter(
  (d) => d.outputs.length > 1 && d.outputs.some((o) => o.id === ''),
);

describe('the catalog registers into a @pond-ts/process registry', () => {
  it('every descriptor defines as an op under the documented bridge', () => {
    // One registry, every study — `define` validates at call time, so a
    // descriptor process cannot express throws here rather than at a
    // consumer's module load.
    let reg = createRegistry();
    for (const d of STUDIES) reg = reg.define(toOpDef(d) as never);

    // Asserted rather than left to the loop not throwing: every study is
    // retrievable, under its own name, declaring one outlet per column.
    const registry = reg as unknown as {
      get(n: string): { outputs: readonly OutputDef[] };
    };
    for (const d of STUDIES) {
      expect(registry.get(d.name).outputs.length).toBe(d.outputs.length);
    }
  });

  it('the bridge is load-bearing: a bare suffix on a multi-output study is rejected', () => {
    // The guard this file exists for. If process ever relaxes it, this
    // fails and the doc on `StudyOutput.id` needs revisiting — it is not
    // a fact we want to assert only in prose.
    // Exact, not a lower bound: the count is quoted in the doc on
    // `StudyOutput.id`, so a thirteenth bare-primary study should fail
    // here and send its author to update the prose too.
    expect(BARE_MULTI.length).toBe(12);
    for (const d of BARE_MULTI) {
      const unbridged = {
        ...toOpDef(d),
        outputs: d.outputs.map((o): OutputDef => ({ id: o.id, unit: o.unit })),
      };
      expect(() => createRegistry().define(unbridged as never)).toThrow(
        /multi-output/,
      );
    }
  });

  it('a single-output study keeps its bare suffix — the map touches only the twelve', () => {
    // `''` is legal on a single-output op (the column *is* the spec id),
    // so the bridge must not rewrite it there: doing so would rename
    // every single-output column for no reason.
    const single = STUDIES.filter((d) => d.outputs.length === 1);
    expect(single.length).toBeGreaterThan(70);
    for (const d of single) {
      const bridged = toOpDef(d).outputs;
      expect(bridged.map((o) => o.id)).toEqual(d.outputs.map((o) => o.id));
    }
  });

  it('units survive the bridge unchanged, so axis membership is preserved', () => {
    // `UnitSpec` is `'inherit' | string`, so a catalog unit passes
    // through verbatim — the property a consumer actually assigns axes
    // on. Asserted because a lossy bridge here would be silent.
    for (const d of STUDIES) {
      expect(toOpDef(d).outputs.map((o) => o.unit)).toEqual(
        d.outputs.map((o) => o.unit),
      );
    }
  });
});

describe('a bridged op runs through the plan layer', () => {
  // Not just `define`: `toColumns` matches an op's return to its declared
  // outputs POSITIONALLY, and names each column `specId + OutputDef.id`.
  // A bridge that miscounts, reorders or misnames them is only visible
  // once a plan actually runs — which is the failure a consumer would
  // have hit, so it is the one worth pinning.
  const cases = ['trix', 'superTrend', 'klinger', 'macd', 'rsi'] as const;

  for (const name of cases) {
    it(`${name} produces its declared columns with the study's values`, () => {
      const d = STUDIES.find((s) => s.name === name)!;
      const reg = createRegistry().define(toOpDef(d) as never);
      const spec = {
        op: name,
        inputs: d.inputs.map((i) => i.default ?? 'open'),
      };

      const result = run(bind(bars as never, { registry: reg as never }), {
        plan: [spec],
        select: [{ on: spec }],
      });

      // Process named one column per declared output, as `id + suffix`.
      const id = Object.keys(result.explain).find((k) =>
        k.includes(`:${name}(`),
      )!;
      const expected = d.outputs.map((o) => `${id}${outletId(d, o)}`);
      expect(Object.keys(result.columns ?? {}).sort()).toEqual(
        [...expected].sort(),
      );

      // And each carries the value the study itself computes for the
      // financial column at the same position.
      const direct = d.run(bars as never, minimalOptions(d)) as never;
      const financialColumns = expectedColumns(d);
      // Read through the assembled series rather than the packed
      // `Column`, so this compares values the same way `catalog.test.ts`
      // does — same helper, same notion of "missing".
      const assembled = result.series!;
      expected.forEach((processColumn, i) => {
        expect(columnValues(assembled, processColumn)).toEqual(
          columnValues(direct, financialColumns[i]!),
        );
      });
    });
  }
});
