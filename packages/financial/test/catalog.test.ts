import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  STUDIES,
  STUDY_FAMILIES,
  studyDescriptor,
} from '../src/catalog/index.js';
import {
  bars,
  columnNames,
  columnValues,
  expectedColumns,
  explicitOptions,
  minimalOptions,
} from './catalog-fixture.js';

/*
 * The runtime half of the catalog's drift guard (the compile-time half is
 * `defineStudy`). Every descriptor is run against its study:
 *
 * - the columns it appends are exactly the ones the descriptor names;
 * - passing every default explicitly changes nothing, so the defaults the
 *   descriptor states are the ones the study uses;
 * - every menu value runs; a value below a declared `min` throws;
 * - and the catalog is exactly the set of fluent methods, so a study
 *   added to the package without a descriptor fails here.
 */

describe('study catalog', () => {
  it('names are unique and every family is a known one', () => {
    const names = STUDIES.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    for (const d of STUDIES) expect(STUDY_FAMILIES).toContain(d.family);
  });

  it('is exactly the set of fluent methods', () => {
    const fluent = readFileSync(
      fileURLToPath(new URL('../src/fluent.ts', import.meta.url)),
      'utf8',
    );
    const methods = [...fluent.matchAll(/^proto\.(\w+) = /gm)].map(
      (m) => m[1]!,
    );
    expect(methods.length).toBeGreaterThan(0);
    const catalog = STUDIES.map((d) => d.name).sort();
    expect(catalog).toEqual([...methods].sort());
  });

  it('studyDescriptor looks a study up by name', () => {
    expect(studyDescriptor('atr')?.family).toBe('volatility');
    expect(studyDescriptor('nope')).toBeUndefined();
  });

  describe.each(STUDIES.map((d) => [d.name, d] as const))('%s', (_, d) => {
    it('has a well-formed shape', () => {
      expect(d.summary.length).toBeGreaterThan(0);
      expect(d.naming.default.length).toBeGreaterThan(0);
      expect(d.outputs.length).toBeGreaterThan(0);
      if (d.naming.kind === 'output') {
        expect(d.outputs.map((o) => o.id)).toEqual(['']);
      } else {
        // Suffixes are unique; at most one output is the bare prefix ('').
        const ids = d.outputs.map((o) => o.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.filter((id) => id === '').length).toBeLessThanOrEqual(1);
      }
      for (const p of Object.values(d.params)) {
        // Optional ⇒ default; required (or `optional`) ⇒ example. Never
        // both, never neither.
        expect((p.default === undefined) !== (p.example === undefined)).toBe(
          true,
        );
        if (p.optional) expect(p.default).toBeUndefined();
        if (p.requires !== undefined) {
          expect(Object.keys(d.params)).toContain(p.requires);
        }
        if (p.kind === 'enum') {
          expect(p.of.length).toBeGreaterThan(0);
          if (p.default !== undefined) expect(p.of).toContain(p.default);
        } else if (p.suggest !== undefined) {
          const [lo, hi] = p.suggest;
          expect(lo).toBeLessThanOrEqual(hi);
          if (p.min !== undefined) expect(lo).toBeGreaterThanOrEqual(p.min);
          if (p.max !== undefined) expect(hi).toBeLessThanOrEqual(p.max);
          // The default (or example) sits inside the useful range.
          const at = p.default ?? p.example!;
          expect(at).toBeGreaterThanOrEqual(lo);
          expect(at).toBeLessThanOrEqual(hi);
        }
      }
    });

    it('appends exactly the columns it declares', () => {
      const before = columnNames(bars);
      const after = columnNames(d.run(bars, minimalOptions(d)));
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.slice(before.length)).toEqual(expectedColumns(d));
    });

    it('states the defaults the study actually uses', () => {
      const implicit = d.run(bars, minimalOptions(d));
      const explicit = d.run(bars, explicitOptions(d));
      for (const name of expectedColumns(d)) {
        expect(columnValues(explicit, name)).toEqual(
          columnValues(implicit, name),
        );
      }
    });

    it('has a finite value in every output on the fixture (nothing passes vacuously)', () => {
      // A study whose warm-up exceeds the 120-bar fixture would let the
      // column and default checks pass on all-`undefined` columns; the ones
      // that do are named here so a new one cannot slip in.
      const allUndefinedAt120 = ['specialK'];
      const out = d.run(bars, minimalOptions(d));
      for (const name of expectedColumns(d)) {
        const finite = columnValues(out, name).some((v) => v !== undefined);
        expect(finite, name).toBe(!allUndefinedAt120.includes(d.name));
      }
    });

    it('runs on every menu value and every optional example; accepts a declared min/max and rejects one past it', () => {
      // The options a param is exercised on: the minimal set, plus the
      // example of the param it `requires` (a menu that is only legal
      // alongside a switched-on option).
      const base = (p: { requires?: string }): Record<string, unknown> => {
        const o = minimalOptions(d);
        if (p.requires !== undefined) {
          const dep = d.params[p.requires]!;
          o[p.requires] = dep.default ?? dep.example;
        }
        return o;
      };
      for (const [name, p] of Object.entries(d.params)) {
        if (p.kind === 'enum') {
          for (const value of p.of) {
            expect(() =>
              d.run(bars, { ...base(p), [name]: value }),
            ).not.toThrow();
          }
        } else {
          if (p.optional) {
            expect(() =>
              d.run(bars, { ...base(p), [name]: p.example }),
            ).not.toThrow();
          }
          // The useful range is legal throughout at the other options'
          // defaults — a control drawn on it never lands on a throw.
          if (p.suggest !== undefined) {
            for (const v of p.suggest) {
              expect(
                () => d.run(bars, { ...base(p), [name]: v }),
                `${name} at suggest ${v}`,
              ).not.toThrow();
            }
          }
          // A bound is inclusive and constant: the study accepts it and
          // rejects one past it. (A floor that depends on another option,
          // or a strictly-positive real, declares none — see the type doc.)
          if (p.min !== undefined) {
            expect(
              () => d.run(bars, { ...base(p), [name]: p.min }),
              `${name} at min`,
            ).not.toThrow();
            expect(() =>
              d.run(bars, { ...base(p), [name]: p.min! - 1 }),
            ).toThrow();
          }
          if (p.max !== undefined) {
            expect(
              () => d.run(bars, { ...base(p), [name]: p.max }),
              `${name} at max`,
            ).not.toThrow();
            expect(() =>
              d.run(bars, { ...base(p), [name]: p.max! + 1 }),
            ).toThrow();
          }
        }
      }
    });
  });
});
