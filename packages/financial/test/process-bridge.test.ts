import { describe, expect, it } from 'vitest';
import {
  BASIC_OPS,
  SUMMARY_FOLDS,
  createHost,
  createRegistry,
} from '@pond-ts/process';
import type { Registry } from '@pond-ts/process';
import type { Session } from '../src/index.js';
import { STUDIES } from '../src/catalog/index.js';
import type { StudyDescriptor } from '../src/catalog/index.js';
import { UNBRIDGED_STUDIES, studyOp, studyOps } from '../src/process/index.js';
import { bars, columnValues, expectedColumns } from './catalog-fixture.js';

/*
 * `@pond-ts/financial/process` — every bridged study, run through a real
 * host request, must give exactly what calling the study directly gives.
 */

// Six 20-minute sessions over the fixture's 120 one-minute bars.
const sessions: Session[] = Array.from({ length: 6 }, (_, k) => ({
  date: `2026-01-0${k + 1}`,
  open: k * 20 * 60_000,
  close: (k + 1) * 20 * 60_000,
}));

// A column the four benchmark studies can read that differs from close.
const BENCH = 'open';

function inputColumn(d: StudyDescriptor, role: string): string {
  const input = d.inputs.find((i) => i.role === role)!;
  return input.default ?? BENCH;
}

function registry(): Registry {
  let r: Registry = createRegistry();
  for (const def of studyOps({ sessions })) r = r.define(def);
  return r;
}

describe('studyOps', () => {
  it('bridges every study except anchoredVwap, and drops the session pair without sessions', () => {
    const all = studyOps({ sessions }).map((d) => d.name);
    expect(all).toHaveLength(STUDIES.length - 1);
    expect(all).not.toContain('anchoredVwap');
    expect(Object.keys(UNBRIDGED_STUDIES)).toEqual(['anchoredVwap']);

    const plain = studyOps().map((d) => d.name);
    expect(plain).toHaveLength(STUDIES.length - 3);
    expect(plain).not.toContain('sessionVwap');
    expect(plain).not.toContain('pivotPoints');
  });

  it('study names are unique and do not collide with the basic steps or folds', () => {
    const names = studyOps({ sessions }).map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    const kit = [...BASIC_OPS, ...SUMMARY_FOLDS].map((d) => d.name);
    expect(names.filter((n) => kit.includes(n))).toEqual([]);
    // And the four standard folds createRegistry() pre-registers.
    for (const n of ['last', 'extremes', 'percentileRank', 'shape']) {
      expect(names).not.toContain(n);
    }
  });

  it('carries the catalog params, with an example standing in for a missing default', () => {
    const sma = studyOps().find((d) => d.name === 'sma')!;
    expect(sma.params['period']).toMatchObject({
      kind: 'integer',
      default: 20,
    });
    const rsi = studyOps().find((d) => d.name === 'rsi')!;
    expect(Object.keys(rsi.params).length).toBeGreaterThan(0);
    // balanceOfPower's optional period, and the maType that requires it, are left out.
    const bop = studyOps().find((d) => d.name === 'balanceOfPower')!;
    expect(bop.params).toEqual({});
  });

  it('refuses a session study without sessions, and anchoredVwap always', () => {
    const svwap = STUDIES.find((d) => d.name === 'sessionVwap')!;
    expect(() => studyOp(svwap)).toThrow(/needs sessions/);
    const avwap = STUDIES.find((d) => d.name === 'anchoredVwap')!;
    expect(() => studyOp(avwap, { sessions })).toThrow(/instant/);
  });

  it('every bridged study, through a host request, matches the study called directly', () => {
    const reg = registry();
    const host = createHost({ registry: reg }).add('bars', bars);
    let compared = 0;
    for (const d of STUDIES) {
      if (d.anchor === 'time') continue;
      const op = reg.get(d.name) as ReturnType<typeof studyOp>;
      const inputs = d.inputs.map((i) => inputColumn(d, i.role));
      const result = host.run({
        from: 'bars',
        process: [{ op: d.name, inputs }],
        select: [{ on: { op: d.name, inputs } }],
        assemble: false,
        onError: 'throw',
      });

      // The direct call, with the same resolved params.
      const call: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(op.params)) call[k] = p.default;
      for (const i of d.inputs) call[i.role] = inputColumn(d, i.role);
      if (d.anchor === 'session') call['sessions'] = sessions;
      const direct = d.run(bars, call);

      const got = Object.values(result.outputs).flat();
      const want = expectedColumns(d);
      expect(got.length, d.name).toBe(want.length);
      for (let k = 0; k < want.length; k += 1) {
        const column = result.columns![got[k]!.column]! as unknown as {
          length: number;
          read(i: number): unknown;
        };
        const cells = Array.from({ length: column.length }, (_, i) => {
          const v = column.read(i);
          return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
        });
        expect(cells, `${d.name} ${want[k]}`).toEqual(
          columnValues(direct, want[k]!).map((v) =>
            v !== undefined && Number.isFinite(v) ? v : undefined,
          ),
        );
        expect(got[k]!.unit, `${d.name} unit`).toBe(
          d.outputs[k]!.unit === 'inherit' ? null : d.outputs[k]!.unit,
        );
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(150);
  });

  it('a whole agent question: is close above its 50-bar average, and by how many percent?', () => {
    let reg: Registry = createRegistry();
    for (const def of [...studyOps(), ...BASIC_OPS, ...SUMMARY_FOLDS])
      reg = reg.define(def);
    const host = createHost({ registry: reg, units: { close: 'USD' } }).add(
      'bars',
      bars,
    );
    const result = host.run({
      from: 'bars',
      nodes: {
        avg: { op: 'sma', params: { period: 50 }, in: ['close'] },
        ratio: { op: 'divide', in: ['close', 'avg'] },
        pct: {
          op: 'scale',
          params: { factor: 100, offset: -100 },
          in: ['ratio'],
        },
        now: { op: 'last', in: ['pct'] },
        above: { op: 'compareColumns', in: ['close', 'avg'] },
        share: { op: 'shareTrue', in: ['above'] },
      },
      outputs: { now: { on: 'now' }, share: { on: 'share' } },
    } as never);
    const now = result.facts.find((f) => f.name === 'now')!;
    const closes = columnValues(bars, 'close') as number[];
    const tail = closes.slice(-50);
    const avg = tail.reduce((a, b) => a + b, 0) / 50;
    expect(now['value'] as number).toBeCloseTo(
      (closes.at(-1)! / avg - 1) * 100,
      5,
    );
    const share = result.facts.find((f) => f.name === 'share')!;
    // 71 rows carry a 50-bar average (rows 49..119).
    expect(share).toMatchObject({ of: 71 });
  });
});
