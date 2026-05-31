import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTimeSeries } from '../src/index.js';
import { schema } from './helpers.js';

describe('useTimeSeries', () => {
  const input = {
    name: 'cpu',
    schema,
    rows: [
      ['2025-01-01T00:00:00Z', 0.42, 'api-1'],
      ['2025-01-01T00:01:00Z', 0.51, 'api-2'],
    ] as const,
  };

  it('returns a TimeSeries from JSON input', () => {
    const { result } = renderHook(() => useTimeSeries(input));
    expect(result.current.length).toBe(2);
    expect(result.current.at(0)!.get('cpu')).toBe(0.42);
  });

  it('infers S from an as-const schema so column-narrowed accessors resolve (not never)', () => {
    const { result } = renderHook(() => useTimeSeries(input));
    // The STRICT, schema-narrowed path. Under the prior two-generic
    // `<S, I extends Parameters<...>[0]>` signature `S` collapsed to
    // `never` through the input-wrapper generic, so `.column('cpu')` was
    // `never` and `.mean()` failed to compile (the loose `.get('cpu')`
    // above masked it). This line is the compile-time regression pin.
    const cpu = result.current.column('cpu'); // narrows to Float64Column
    expect(cpu.mean()).toBeCloseTo((0.42 + 0.51) / 2);
  });

  it('returns the same reference on re-render with same input', () => {
    const { result, rerender } = renderHook(() => useTimeSeries(input));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('recomputes when input changes', () => {
    const { result, rerender } = renderHook(({ data }) => useTimeSeries(data), {
      initialProps: { data: input },
    });

    const first = result.current;
    expect(first.length).toBe(2);

    const newInput = {
      name: 'cpu',
      schema,
      rows: [['2025-01-01T00:00:00Z', 0.99, 'api-3']] as const,
    };

    rerender({ data: newInput });
    expect(result.current).not.toBe(first);
    expect(result.current.length).toBe(1);
    expect(result.current.at(0)!.get('cpu')).toBe(0.99);
  });

  it('accepts an explicit cache key', () => {
    const { result, rerender } = renderHook(
      ({ data, key }) => useTimeSeries(data, key),
      { initialProps: { data: input, key: 'v1' } },
    );

    const first = result.current;

    // Same key, same result
    rerender({ data: input, key: 'v1' });
    expect(result.current).toBe(first);

    // New key, recomputes
    rerender({ data: input, key: 'v2' });
    expect(result.current).not.toBe(first);
  });
});
