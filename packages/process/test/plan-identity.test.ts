import { describe, expect, it } from 'vitest';
import {
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
    params: { period: int({ min: 2, default: 20, label: 'Period (bars)' }) },
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

  it('projects a recursive JSON Schema, which is what allows nesting', () => {
    const schema = registry.toJsonSchema() as {
      items: {
        oneOf: { title: string; properties: Record<string, unknown> }[];
      };
    };
    const smaSchema = schema.items.oneOf.find((o) => o.title === 'sma')!;
    const inputs = smaSchema.properties['inputs'] as {
      items: { oneOf: unknown[] };
    };
    // The single most load-bearing line: an input may be a column name OR
    // another spec, so a caller composes `ema(sma(px))` from the schema
    // alone rather than being taught a nesting concept.
    expect(inputs.items.oneOf).toContainEqual({ $ref: '#/items' });
    expect(JSON.stringify(schema)).not.toContain('undefined');
  });

  it('projects param constraints the validator actually enforces', () => {
    const schema = registry.toJsonSchema() as {
      items: { oneOf: { title: string; properties: Record<string, any> }[] };
    };
    const bb = schema.items.oneOf.find((o) => o.title === 'bollinger')!;
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
});
