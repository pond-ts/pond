import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { CategoryAxis } from '../src/CategoryAxis.js';

afterEach(cleanup);

const cats = [
  { label: 'AAPL', value: 10 },
  { label: 'MSFT', value: 20 },
];

describe('category axis — format + range edge cases (Layer-2 findings)', () => {
  it('a string `format` on a category axis does not crash, and labels by name', () => {
    let root: ReturnType<typeof render> | undefined;
    // A d3 number specifier reaches the axis; the category branch ignores it and
    // labels by category name (rather than calling the band scale as a number
    // scale, which used to throw).
    expect(() => {
      root = render(
        <ChartContainer width={400} showAxis={false}>
          <ChartRow height={120}>
            <YAxis id="v" min={0} />
            <Layers>
              <BarChart categories={cats} />
            </Layers>
            <CategoryAxis format=".0%" />
          </ChartRow>
        </ChartContainer>,
      );
    }).not.toThrow();
    expect(root!.container.textContent).toContain('AAPL');
    expect(root!.container.textContent).toContain('MSFT');
  });

  it('an explicit `range` does not offset the category labels from the bars', () => {
    // The category domain is forced to [0, n], so an out-of-[0,n] range can't
    // shift the labels off the bars — the first slot still labels 'AAPL'.
    const { container } = render(
      <ChartContainer width={400} range={[100, 200]} showAxis={false}>
        <ChartRow height={120}>
          <YAxis id="v" min={0} />
          <Layers>
            <BarChart categories={cats} />
          </Layers>
          <CategoryAxis />
        </ChartRow>
      </ChartContainer>,
    );
    expect(container.textContent).toContain('AAPL');
    expect(container.textContent).toContain('MSFT');
  });
});
