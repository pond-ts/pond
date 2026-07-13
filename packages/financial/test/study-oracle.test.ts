/**
 * Cross-validation: every shipped study is checked against a **pandas** oracle.
 *
 * `scripts/oracle/generate.py` computes reference values with pandas (an
 * independent implementation, conventions pinned to match ours — see that file)
 * and commits them to `fixtures/study-oracle.json`. Here we run our TypeScript
 * studies over the *same* input and assert bar-for-bar agreement. CI needs no
 * Python — the JSON is the committed oracle; regenerate it only when a study's
 * definition changes (and expect the diff to be reviewed).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { TimeSeries } from 'pond-ts';
import { sma, ema, bollinger } from '../src/index.js';

interface OracleCase {
  study: 'sma' | 'ema' | 'bollinger';
  params: { period: number; stdDev?: number };
  expected: Record<string, Array<number | null>>;
}
interface Oracle {
  meta: { oracle: string };
  input: { closes: number[] };
  cases: OracleCase[];
}

const oracle = JSON.parse(
  readFileSync(
    new URL('./fixtures/study-oracle.json', import.meta.url),
    'utf8',
  ),
) as Oracle;

/** Build the close series the oracle computed over (index as the time key). */
function series(): TimeSeries<never> {
  return new TimeSeries({
    name: 'oracle',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
    ],
    rows: oracle.input.closes.map((c, i) => [i, c]),
  }) as unknown as TimeSeries<never>;
}

function run(c: OracleCase): unknown {
  switch (c.study) {
    case 'sma':
      return sma(series(), c.params);
    case 'ema':
      return ema(series(), c.params);
    case 'bollinger':
      return bollinger(series(), c.params);
    default:
      // A fixture case whose study has no dispatch here must fail loudly, not
      // silently skip — the guard for future fan-out studies.
      throw new Error(`no dispatch for oracle study '${String(c.study)}'`);
  }
}

/** Read an appended column as (number | null)[] — null for a missing cell, so
 *  it lines up with the oracle's JSON `null`. */
function colValues(result: unknown, name: string): Array<number | null> {
  const events = (
    result as { events: ReadonlyArray<{ data(): Record<string, unknown> }> }
  ).events;
  return events.map((e) => {
    const v = e.data()[name];
    return typeof v === 'number' ? v : null;
  });
}

describe(`studies match the ${oracle.meta.oracle} oracle`, () => {
  for (const c of oracle.cases) {
    const label = `${c.study}(${JSON.stringify(c.params)})`;
    it(`${label} agrees bar-for-bar`, () => {
      const result = run(c);
      for (const [column, expected] of Object.entries(c.expected)) {
        const actual = colValues(result, column);
        expect(actual).toHaveLength(expected.length);
        for (let i = 0; i < expected.length; i += 1) {
          const exp = expected[i]!;
          if (exp === null) {
            expect(actual[i], `${column}[${i}] should be missing`).toBeNull();
          } else {
            // pandas + our incremental reducer are both IEEE754 doubles but sum
            // in a different order; 1e-9 absolute is comfortably inside that.
            expect(actual[i], `${column}[${i}]`).toBeCloseTo(exp, 9);
          }
        }
      }
    });
  }
});
