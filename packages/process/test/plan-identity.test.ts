import { describe, expect, it } from 'vitest';
import {
  ArityError,
  ParamError,
  UnknownOpError,
  choice,
  columnsOf,
  createRegistry,
  explain,
  int,
  num,
  refToId,
  specId,
  unitOf,
  type OpDef,
} from '../src/index.js';

const noop: OpDef['run'] = () => [];

const registry = createRegistry()
  .define({
    name: 'sma',
    family: 'trend',
    summary: 'Simple moving average over a bar-count window.',
    params: {
      period: int({
        min: 2,
        max: 5000,
        suggest: [5, 200],
        default: 20,
        label: 'Period (bars)',
      }),
    },
    inputs: [{ role: 'source' }],
    outputs: [{ id: '', unit: 'inherit' }],
    label: (p, i) => `SMA(${p['period']}) of ${i}`,
    run: noop,
  })
  .define({
    name: 'ema',
    family: 'trend',
    summary: 'Exponential moving average.',
    params: { period: int({ min: 2, default: 20 }) },
    inputs: [{ role: 'source' }],
    outputs: [{ id: '', unit: 'inherit' }],
    label: (p, i) => `EMA(${p['period']}) of ${i}`,
    run: noop,
  })
  .define({
    name: 'bollinger',
    family: 'bands',
    summary: 'Moving average with ±stdDev bands.',
    params: {
      period: int({ min: 2, default: 20 }),
      stdDev: num({ min: 0.1, max: 5, default: 2 }),
    },
    inputs: [{ role: 'source' }],
    outputs: [
      { id: 'Upper', unit: 'inherit', dependsOn: ['period', 'stdDev'] },
      { id: 'Middle', unit: 'inherit', dependsOn: ['period'] },
      { id: 'Lower', unit: 'inherit', dependsOn: ['period', 'stdDev'] },
    ],
    label: (p, i) => `Bollinger(${p['period']}, ${p['stdDev']}σ) of ${i}`,
    run: noop,
  })
  .define({
    name: 'zScore',
    family: 'normalisation',
    summary: 'Standard deviations from the rolling mean.',
    params: { period: int({ min: 2, default: 20 }) },
    inputs: [{ role: 'source' }],
    outputs: [{ id: '', unit: 'sigma' }],
    run: noop,
  })
  .define({
    name: 'annualise',
    family: 'volatility',
    summary: 'Annualise a variance column.',
    params: { periodsPerYear: int({ min: 1, default: 252 }) },
    inputs: [{ role: 'source', unit: 'variance' }],
    outputs: [{ id: '', unit: '%' }],
    run: noop,
  })
  .define({
    name: 'smooth',
    family: 'trend',
    summary: 'Smoothing with a selectable method.',
    params: {
      method: choice({ of: ['ema', 'sg', 'butterworth'], default: 'ema' }),
      period: int({ min: 2, default: 10 }),
    },
    inputs: [{ role: 'source' }],
    outputs: [{ id: '', unit: 'inherit' }],
    run: noop,
  });

const sma = (period?: number) => ({
  op: 'sma',
  ...(period !== undefined && { params: { period } }),
  inputs: ['px'],
});

describe('specId — the two properties that must not regress', () => {
  it('is invariant under param key order', () => {
    // A caller's JSON preserves insertion order and two callers will not
    // agree on one. If this breaks, a saved view and a fresh request stop
    // sharing a cache entry.
    const a = {
      op: 'bollinger',
      params: { period: 20, stdDev: 2 },
      inputs: ['px'],
    };
    const b = {
      op: 'bollinger',
      params: { stdDev: 2, period: 20 },
      inputs: ['px'],
    };
    expect(specId(registry, a)).toBe(specId(registry, b));
  });

  it('collides an omitted param with its explicit default', () => {
    // `{op:'sma'}` and `{op:'sma',params:{period:20}}` are the same
    // computation and must be the same node.
    expect(specId(registry, sma())).toBe(specId(registry, sma(20)));
  });

  it('survives a JSON round trip', () => {
    const spec = { op: 'ema', params: { period: 10 }, inputs: [sma(20)] };
    const back = JSON.parse(JSON.stringify(spec)) as typeof spec;
    expect(specId(registry, spec)).toBe(specId(registry, back));
  });
});

describe('specId — shape', () => {
  it('is versioned, and reads as a citation', () => {
    expect(specId(registry, sma(20))).toBe('p1:sma(px;period=20)');
  });

  it('nests, so a chain names its whole lineage', () => {
    const emaOfSma = { op: 'ema', params: { period: 10 }, inputs: [sma(20)] };
    expect(specId(registry, emaOfSma)).toBe(
      'p1:ema(p1:sma(px;period=20);period=10)',
    );
  });

  it('distinguishes params, which is why they must be in the id', () => {
    // The plan-format constraint that decided [PND-PROCIDENT]: a plan may
    // hold both at once, and their output columns cannot collide.
    expect(specId(registry, sma(20))).not.toBe(specId(registry, sma(50)));
  });

  it('escapes separators so a string param cannot forge an id', () => {
    const nasty = {
      op: 'smooth',
      params: { method: 'ema', period: 10 },
      inputs: ['a;b)c'],
    };
    const id = specId(registry, nasty);
    expect(id).toContain('a\\;b\\)c');
    // One closing paren from the id's own structure, not from the param.
    expect(id.endsWith(')')).toBe(true);
  });
});

describe('specId — total under `validate: false` [PND-PROCTOTAL]', () => {
  // The consumer case: a persisted plan holds a spec that no longer
  // compiles, and the UI still has to name it — to label the chip it is
  // skipping and to key the "this one is broken" state.
  const lenient = { validate: false } as const;

  it('names a spec whose param is out of range', () => {
    // `p1?:` — the unvalidated namespace. Params are type-tagged there,
    // so the encoding is injective where `String(v)` was not.
    expect(specId(registry, sma(0), lenient)).toBe(
      'p1?:sma(px;period=number:0)',
    );
  });

  it('names a spec whose op the registry does not have', () => {
    expect(specId(registry, { op: 'nope', inputs: ['px'] }, lenient)).toBe(
      'p1?:nope(px;)',
    );
  });

  it('names a spec carrying a param the op does not declare', () => {
    // Carried rather than dropped: two differently-broken specs are two
    // ids, so a UI keyed on them does not collapse them into one.
    const typo = { op: 'sma', params: { perid: 20 }, inputs: ['px'] };
    const id = specId(registry, typo, lenient);
    expect(id).toBe('p1?:sma(px;perid=number:20,period=number:20)');
    expect(id).not.toBe(specId(registry, sma(20), lenient));
  });

  it('is total through nesting — an invalid inner spec still names the outer', () => {
    // The mark rides up: an outer spec over an invalid inner cannot
    // compile either, so it is unvalidated too.
    const outer = { op: 'ema', params: { period: 10 }, inputs: [sma(0)] };
    expect(specId(registry, outer, lenient)).toBe(
      'p1?:ema(p1?:sma(px;period=number:0);period=number:10)',
    );
  });

  it('does not throw for any of the cases the strict mode rejects', () => {
    for (const spec of [
      sma(0),
      sma(Number.NaN),
      { op: 'nope', inputs: ['px'] },
      { op: 'sma', params: { period: '20' as never }, inputs: ['px'] },
      { op: 'sma', params: { perid: 20 }, inputs: ['px'] },
      { op: 'ema', params: { period: 10 }, inputs: [sma(0)] },
      // A field dropped entirely by a persistence round trip.
      { op: 'sma', params: { period: 0 } } as never,
    ]) {
      expect(() => specId(registry, spec)).toThrow();
      expect(() => specId(registry, spec, lenient)).not.toThrow();
    }
  });

  it('gives a VALID spec the same id either way — no second cache key', () => {
    // The property the whole option rests on: a consumer may key on the
    // lenient id and still hit the node `compile` mints.
    for (const spec of [
      sma(),
      sma(20),
      { op: 'bollinger', params: { stdDev: 2, period: 20 }, inputs: ['px'] },
      { op: 'ema', params: { period: 10 }, inputs: [sma(20)] },
      {
        op: 'ema',
        params: { period: 10 },
        inputs: [
          {
            from: { op: 'bollinger', params: { period: 20 }, inputs: ['px'] },
            output: 'Lower',
          },
        ],
      },
    ]) {
      expect(specId(registry, spec, lenient)).toBe(specId(registry, spec));
    }
  });

  it('still applies defaults and sorts keys, so it is a real id', () => {
    // Leniency relaxes validity, not canonicalization — an omitted param
    // must still collide with its explicit default.
    expect(specId(registry, sma(), lenient)).toBe(
      specId(registry, sma(20), lenient),
    );
    const a = { op: 'bollinger', params: { period: 20, stdDev: 9 } };
    const b = { op: 'bollinger', params: { stdDev: 9, period: 20 } };
    expect(specId(registry, { ...a, inputs: ['px'] }, lenient)).toBe(
      specId(registry, { ...b, inputs: ['px'] }, lenient),
    );
  });

  it('never collides an unvalidated id with a legal one', () => {
    // The defect both PR #667 reviews found: `esc` is `String(v)`, so a
    // type-invalid param encoded exactly like its legal counterpart and
    // the broken spec NAMED THE WORKING NODE. The id is the column name,
    // the cache key and the provenance citation, so that is a
    // correctness bug — a JSON or form round trip turning 20 into "20"
    // is the very case this mode exists for.
    const cases: { valid: object; broken: object }[] = [
      {
        valid: { op: 'sma', params: { period: 20 }, inputs: ['px'] },
        broken: { op: 'sma', params: { period: '20' }, inputs: ['px'] },
      },
      {
        valid: { op: 'smooth', params: { method: 'ema' }, inputs: ['px'] },
        broken: { op: 'smooth', params: { method: 0 }, inputs: ['px'] },
      },
      {
        // A legal string param vs. the same text arriving as a number.
        valid: { op: 'smooth', params: { period: 10 }, inputs: ['px'] },
        broken: { op: 'smooth', params: { period: '10' }, inputs: ['px'] },
      },
    ];
    for (const { valid, broken } of cases) {
      const legal = specId(registry, valid as never);
      expect(specId(registry, broken as never, lenient)).not.toBe(legal);
      // And the legal one is untouched by the mode, as ever.
      expect(specId(registry, valid as never, lenient)).toBe(legal);
    }
  });

  it('keeps two broken specs apart when only their types differ', () => {
    // Both are invalid, so neither can collide with a legal id — but a
    // UI keyed on them must still see two chips, not one.
    const a = { op: 'sma', params: { period: 0 }, inputs: ['px'] };
    const b = { op: 'sma', params: { period: '0' }, inputs: ['px'] };
    expect(specId(registry, a as never, lenient)).not.toBe(
      specId(registry, b as never, lenient),
    );
  });

  it('escapes an undeclared param key, which leniency lets through', () => {
    // Strict mode rejects an undeclared key outright; carrying it means
    // a key spelled with the id's own separators could otherwise forge
    // the encoding of two params.
    const forged = {
      op: 'sma',
      params: { 'period=20,x': 1 },
      inputs: ['px'],
    };
    const id = specId(registry, forged as never, lenient);
    expect(id).toContain('period\\=20\\,x=');
    expect(id).not.toBe(
      specId(
        registry,
        { op: 'sma', params: { period: 20, x: 1 }, inputs: ['px'] } as never,
        lenient,
      ),
    );
  });

  it('marks the whole chain, so no unvalidated id starts like a valid one', () => {
    const specs = [
      sma(0),
      { op: 'nope', inputs: ['px'] },
      { op: 'ema', params: { period: 10 }, inputs: [sma(0)] },
      { op: 'sma', params: { perid: 20 }, inputs: ['px'] },
    ];
    for (const spec of specs) {
      expect(specId(registry, spec, lenient).startsWith('p1?:')).toBe(true);
    }
    expect(specId(registry, sma(20), lenient).startsWith('p1:')).toBe(true);
  });

  it('treats arity as part of validity, in both modes', () => {
    // A spec with no `inputs` was named `p1:sma(;period=20)` — a VALID id
    // for something that cannot compile — and then died at `compile` as a
    // bare TypeError reading `.length` of undefined (Tidal, on 0.62.0).
    // Arity is decidable from the registry alone, so identity can judge
    // it, and the `p1?:` mark is only honest if it does.
    const noInputs = { op: 'sma', params: { period: 20 } } as never;
    expect(() => specId(registry, noInputs)).toThrow(ArityError);
    expect(specId(registry, noInputs, lenient)).toBe(
      'p1?:sma(;period=number:20)',
    );

    const tooMany = { op: 'sma', inputs: ['px', 'iv'] } as never;
    expect(() => specId(registry, tooMany)).toThrow(
      /takes 1 input\(s\), got 2/,
    );
    expect(specId(registry, tooMany, lenient).startsWith('p1?:')).toBe(true);
  });

  it('names the pathological shapes instead of throwing a TypeError', () => {
    // Totality is over arbitrary JSON, not over well-typed specs — the
    // whole reason to reach for leniency is an object that no longer
    // fits. Each of these used to be a raw TypeError, which is the same
    // failure as a ParamError one layer down.
    const shapes: unknown[] = [
      { op: 'sma', params: null, inputs: ['px'] },
      { op: 'sma', params: 42, inputs: ['px'] },
      { op: 'sma', inputs: [null] },
      { op: 'sma', inputs: 'px' },
      { op: 'sma', inputs: [['px']] },
      { op: 'nope', params: null, inputs: null },
    ];
    const ids = new Set<string>();
    for (const shape of shapes) {
      const id = specId(registry, shape as never, lenient);
      expect(id.startsWith('p1?:')).toBe(true);
      ids.add(id);
    }
    // Distinct shapes stay distinct ids — a UI keyed on them sees one
    // broken chip per broken entry.
    expect(ids.size).toBe(shapes.length);
    // And strict mode reports what is wrong rather than crashing.
    expect(() =>
      specId(registry, { op: 'sma', params: null, inputs: ['px'] } as never),
    ).toThrow(ParamError);
    expect(() =>
      specId(registry, { op: 'sma', inputs: [null] } as never),
    ).toThrow(/must be a column name or a spec/);
  });

  it('never names a malformed spec into the valid namespace', () => {
    // The collision that matters: `{params: null}` must not resolve to
    // the defaulted spec's legitimate id.
    const defaulted = specId(registry, { op: 'sma', inputs: ['px'] });
    for (const shape of [
      { op: 'sma', params: null, inputs: ['px'] },
      { op: 'sma', params: undefined, inputs: ['px'] },
    ]) {
      const id = specId(registry, shape as never, lenient);
      if (shape.params === undefined) {
        // Legitimately the defaulted spec — omitted params ARE valid.
        expect(id).toBe(defaulted);
      } else {
        expect(id).not.toBe(defaulted);
      }
    }
  });

  it('validates by default, which is the behaviour that shipped', () => {
    expect(() => specId(registry, sma(0))).toThrow(ParamError);
    expect(() => specId(registry, sma(0), { validate: true })).toThrow(
      ParamError,
    );
  });
});

describe('refToId', () => {
  it('accepts an inline spec or an id string alike', () => {
    const id = specId(registry, sma(20));
    expect(refToId(registry, sma(20))).toBe(id);
    expect(refToId(registry, id)).toBe(id);
  });
});

describe('params', () => {
  it('reports what it actually received, including the type', () => {
    // The audience is a caller composing JSON, which cannot debug
    // "must be an integer, got 20" when it sent the string "20".
    const op = registry.get('sma');
    expect(() => registry.resolveParams(op, { period: '20' as never })).toThrow(
      /must be an integer, got "20" \(string\)/,
    );
  });

  it('enforces min, max and enum membership', () => {
    expect(() => specId(registry, sma(1))).toThrow(/below minimum 2/);
    expect(() =>
      specId(registry, {
        op: 'bollinger',
        params: { period: 20, stdDev: 9 },
        inputs: ['px'],
      }),
    ).toThrow(/above maximum 5/);
    expect(() =>
      specId(registry, {
        op: 'smooth',
        params: { method: 'nope' },
        inputs: ['px'],
      }),
    ).toThrow(/must be one of 'ema', 'sg', 'butterworth'/);
  });

  it('rejects an unknown param rather than ignoring it', () => {
    // Silently dropping it would give two ids for one request.
    expect(() =>
      specId(registry, { op: 'sma', params: { perid: 20 }, inputs: ['px'] }),
    ).toThrow(/has no param 'perid'/);
  });

  it('names what is available when an op is unknown', () => {
    expect(() => specId(registry, { op: 'nope', inputs: ['px'] })).toThrow(
      UnknownOpError,
    );
    expect(() => specId(registry, { op: 'nope', inputs: ['px'] })).toThrow(
      /'sma'/,
    );
  });

  it('rejects a NaN param, which is neither a valid number nor missing', () => {
    expect(() => specId(registry, sma(Number.NaN))).toThrow(ParamError);
  });
});

describe('explain', () => {
  it('folds nested lineage rather than reconstructing it', () => {
    const emaOfSma = { op: 'ema', params: { period: 10 }, inputs: [sma(20)] };
    expect(explain(registry, emaOfSma)).toBe('EMA(10) of SMA(20) of px');
  });

  it('derives a generic label when an op declares none', () => {
    expect(
      explain(registry, {
        op: 'zScore',
        params: { period: 60 },
        inputs: ['px'],
      }),
    ).toBe('zScore(period=60) of px');
  });
});

describe('units', () => {
  const units = { px: '%', ccVar: 'variance' };

  it('inherits through a chain', () => {
    const emaOfSma = { op: 'ema', params: { period: 10 }, inputs: [sma(20)] };
    expect(unitOf(registry, emaOfSma, units)).toBe('%');
  });

  it('honours a declared unit over the input', () => {
    expect(
      unitOf(
        registry,
        { op: 'zScore', params: { period: 60 }, inputs: ['px'] },
        units,
      ),
    ).toBe('sigma');
    expect(
      unitOf(registry, { op: 'annualise', inputs: ['ccVar'] }, units),
    ).toBe('%');
  });

  it('reports unitless rather than guessing', () => {
    expect(
      unitOf(registry, { op: 'sma', inputs: ['unknown'] }, units),
    ).toBeNull();
  });

  it('gives a band per-output units', () => {
    const bb = {
      op: 'bollinger',
      params: { period: 20, stdDev: 2 },
      inputs: ['px'],
    };
    expect([0, 1, 2].map((i) => unitOf(registry, bb, units, i))).toEqual([
      '%',
      '%',
      '%',
    ]);
  });
});

describe('columnsOf', () => {
  it('names a single output by the id itself', () => {
    const id = specId(registry, sma(20));
    expect(columnsOf(registry, sma(20), id)).toEqual([id]);
  });

  it('names a band by the corpus prefix convention', () => {
    const bb = {
      op: 'bollinger',
      params: { period: 20, stdDev: 2 },
      inputs: ['px'],
    };
    const id = specId(registry, bb);
    expect(columnsOf(registry, bb, id)).toEqual([
      `${id}Upper`,
      `${id}Middle`,
      `${id}Lower`,
    ]);
  });
});

describe('registry as schema', () => {
  it('groups by family for a picker', () => {
    const fam = registry.byFamily();
    expect([...fam.keys()].sort()).toEqual([
      'bands',
      'normalisation',
      // The standard folds, registered by `createRegistry` and grouped
      // like anything else — a picker sees one vocabulary.
      'read',
      'trend',
      'volatility',
    ]);
    expect(
      fam
        .get('trend')
        ?.map((o) => o.name)
        .sort(),
    ).toEqual(['ema', 'sma', 'smooth']);
  });

  it('describes an op by its declared inputs, not a count of them', () => {
    // A count checks arity and says nothing else. A consumer labelling a
    // two-input op needs the roles, and one explaining a rejection needs
    // the unit an input demands — both were dropped by reporting a number.
    const ann = registry.describe().find((o) => o.name === 'annualise')!;
    expect(ann.inputs).toEqual([{ role: 'source', unit: 'variance' }]);
    const bb = registry.describe().find((o) => o.name === 'bollinger')!;
    expect(bb.inputs.map((i) => i.role)).toEqual(['source']);
    // Optional where undeclared, rather than absent from the shape.
    expect(bb.inputs[0]!.unit).toBeUndefined();
  });

  it('separates the range that rejects from the range worth offering', () => {
    // `min`/`max` answer 'would this be rejected?'. A control needs the
    // other question — 'what would anyone pick?' — and drawing one on the
    // legal range put 96% of a slider's travel where nobody goes.
    const period = registry.describe().find((o) => o.name === 'sma')!.params[
      'period'
    ]!;
    expect(period).toMatchObject({ min: 2, max: 5000, suggest: [5, 200] });

    // Advisory, so a value outside it still resolves.
    expect(
      registry.resolveParams(registry.get('sma'), { period: 1000 }),
    ).toEqual({ period: 1000 });
  });

  it('tells a composing model the useful range, in prose it can read', () => {
    // Not an `x-suggest` keyword: this projection already cost three
    // rounds against a live validator, and `description` is the one
    // channel every one of them accepts.
    const schema = registry.toJsonSchema() as {
      $defs: {
        spec: { anyOf: { title: string; properties: Record<string, any> }[] };
      };
    };
    const sma = schema.$defs.spec.anyOf.find((o) => o.title === 'sma')!;
    const period = sma.properties['params'].properties['period'];
    expect(period).toMatchObject({ minimum: 2, maximum: 5000 });
    expect(period.description).toMatch(/Typically 5.200/);
    // The bounds that reject are still projected as bounds.
    const ema = schema.$defs.spec.anyOf.find((o) => o.title === 'ema')!;
    expect(ema.properties['params'].properties['period']).not.toHaveProperty(
      'description',
    );
  });

  it('rejects a nonsense suggestion where its author will see it', () => {
    const base = {
      name: 'bad',
      family: 'trend',
      summary: 'x',
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      label: () => 'bad',
      run: noop,
    } as const;
    expect(() =>
      createRegistry().define({
        ...base,
        params: { period: int({ min: 2, suggest: [50, 5], default: 20 }) },
      }),
    ).toThrow(/suggest \[50, 5\] is inverted/);
    expect(() =>
      createRegistry().define({
        ...base,
        params: {
          period: int({ min: 2, max: 100, suggest: [5, 900], default: 20 }),
        },
      }),
    ).toThrow(/escapes the legal range \[2, 100\]/);
  });

  it('projects a recursive JSON Schema, which is what allows nesting', () => {
    const schema = registry.toJsonSchema() as {
      items: { $ref: string };
      $defs: {
        spec: { anyOf: { title: string; properties: Record<string, any> }[] };
      };
    };
    // The recursion lives in `$defs`, and `items` points at it.
    expect(schema.items).toEqual({ $ref: '#/$defs/spec' });
    const smaSchema = schema.$defs.spec.anyOf.find((o) => o.title === 'sma')!;
    const inputs = smaSchema.properties['inputs'] as {
      items: { anyOf: unknown[] };
    };
    // The single most load-bearing line: an input may be a column name OR
    // another spec, so a caller composes `ema(sma(px))` from the schema
    // alone rather than being taught a nesting concept.
    expect(inputs.items.anyOf).toContainEqual({ $ref: '#/$defs/spec' });
    expect(JSON.stringify(schema)).not.toContain('undefined');
  });

  it('can express a picked output, so bands are reachable remotely', () => {
    // The resolver accepted `{from, output}` from the start, but the
    // projection could not say so — a caller composing against the
    // schema alone had no way to reach a multi-output op's Lower band.
    const schema = registry.toJsonSchema() as {
      $defs: {
        spec: { anyOf: { title: string; properties: Record<string, any> }[] };
      };
    };
    const sma = schema.$defs.spec.anyOf.find((o) => o.title === 'sma')!;
    const branches = sma.properties['inputs'].items.anyOf as Record<
      string,
      any
    >[];
    const picked = branches.find((b) => b['title'] === 'picked output');
    expect(picked).toMatchObject({
      type: 'object',
      required: ['from', 'output'],
      additionalProperties: false,
    });
    expect(picked!['properties']).toEqual({
      from: { $ref: '#/$defs/spec' },
      output: { type: 'string' },
    });
  });

  it('is embeddable, because the ref points at a top-level definition', () => {
    // Three attempts to get this right, each failing differently:
    //   `#/items`                     — dangles once nested (M2)
    //   `#/properties/process/items`  — passes local validators, and the
    //                                   API refuses it: "reference can
    //                                   only point to definitions defined
    //                                   at the top level" (M5)
    //   `#/$defs/spec` + hoisted defs — travels.
    const { $defs, ...body } = registry.toJsonSchema({
      defs: 'spec',
      root: false,
    }) as { $defs: Record<string, unknown> } & Record<string, unknown>;
    const nested = {
      type: 'object',
      $defs,
      properties: { process: body },
    };
    const at = (doc: unknown, ptr: string): unknown =>
      ptr
        .replace(/^#\//, '')
        .split('/')
        .reduce<any>((node, key) => node?.[key], doc);

    const refs = [...JSON.stringify(nested).matchAll(/"\$ref":"([^"]+)"/g)];
    expect(refs.length).toBeGreaterThan(0);
    for (const [, ptr] of refs) {
      // Resolvable, and pointing into `$defs` rather than the body.
      expect(ptr!.startsWith('#/$defs/')).toBe(true);
      expect(at(nested, ptr!)).toBeDefined();
    }
    // A subschema does not get to declare its own dialect.
    expect(body['$schema']).toBeUndefined();
  });

  it('projects param constraints the validator actually enforces', () => {
    const schema = registry.toJsonSchema() as {
      $defs: {
        spec: { anyOf: { title: string; properties: Record<string, any> }[] };
      };
    };
    const bb = schema.$defs.spec.anyOf.find((o) => o.title === 'bollinger')!;
    expect(bb.properties['params'].properties.stdDev).toEqual({
      type: 'number',
      default: 2,
      minimum: 0.1,
      maximum: 5,
    });
  });
});

describe('registry guards', () => {
  it('rejects a multi-output op with an empty suffix', () => {
    // It would collide with the spec id itself.
    expect(() =>
      createRegistry().define({
        name: 'bad',
        family: 'x',
        summary: '',
        params: {},
        inputs: [{ role: 'source' }],
        outputs: [
          { id: '', unit: 'inherit' },
          { id: 'Other', unit: 'inherit' },
        ],
        run: noop,
      }),
    ).toThrow(/multi-output/);
  });

  it('rejects an op with no outputs', () => {
    expect(() =>
      createRegistry().define({
        name: 'bad',
        family: 'x',
        summary: '',
        params: {},
        inputs: [],
        outputs: [],
        run: noop,
      }),
    ).toThrow(/declares no outputs/);
  });

  it('rejects a duplicate input role, which collapses at run time', () => {
    // Inputs resolve by role, so a repeated role makes every reader see
    // the LAST input — both bind to one column, silently.
    expect(() =>
      createRegistry().define({
        name: 'bad',
        family: 'x',
        summary: '',
        params: {},
        inputs: [{ role: 'a' }, { role: 'a' }],
        outputs: [{ id: '', unit: 'inherit' }],
        run: noop,
      }),
    ).toThrow(/declares input role 'a' twice/);
  });

  it('rejects a duplicate output id, which discards a column', () => {
    // Node outlets key by output id, so the second 'Upper' silently
    // replaced the first's column.
    expect(() =>
      createRegistry().define({
        name: 'bad',
        family: 'x',
        summary: '',
        params: {},
        inputs: [{ role: 'source' }],
        outputs: [
          { id: 'Upper', unit: 'inherit' },
          { id: 'Upper', unit: 'inherit' },
        ],
        run: noop,
      }),
    ).toThrow(/declares output 'Upper' twice/);
  });

  it('rejects a default its own param declaration refuses', () => {
    // A bad default fails every spec that omits the param; checked at
    // definition time so it fails the author who wrote it instead.
    expect(() =>
      createRegistry().define({
        name: 'bad',
        family: 'x',
        summary: '',
        params: { period: int({ min: 5, default: 2 }) },
        inputs: [{ role: 'source' }],
        outputs: [{ id: '', unit: 'inherit' }],
        run: noop,
      }),
    ).toThrow(/invalid default for 'period'/);
  });

  it('rejects a dependsOn naming a param the op does not take', () => {
    // dependsOn drives selective invalidation — a name that matches no
    // param would never fire and never be noticed.
    expect(() =>
      createRegistry().define({
        name: 'bad',
        family: 'x',
        summary: '',
        params: { width: int({ default: 2 }) },
        inputs: [{ role: 'source' }],
        outputs: [{ id: '', unit: 'inherit', dependsOn: ['widht'] }],
        run: noop,
      }),
    ).toThrow(/dependsOn unknown param 'widht'/);
  });
});
