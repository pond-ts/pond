# @pond-ts/charts

**React charts for [pond-ts](https://www.npmjs.com/package/pond-ts) time series.**

A composable charting layer built directly on pond-ts series: a canvas data
plane for the heavy line/area/bar drawing, with SVG overlays for axes, cursors,
and interaction. Line, area, bar, scatter, and box charts; **time and value
x-axes** inferred from the data; an interactive cursor; and theming.

```sh
npm install @pond-ts/charts pond-ts @pond-ts/react
```

`pond-ts`, `@pond-ts/react`, and `react` (18 or 19) are peer dependencies.

## Quick start

```tsx
import { TimeSeries } from 'pond-ts';
import { ChartContainer, ChartRow, Layers, LineChart } from '@pond-ts/charts';

const series = new TimeSeries({
  name: 'cpu',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'cpu', kind: 'number' },
  ] as const,
  rows: [
    [1717200000000, 50],
    [1717200060000, 62],
    [1717200120000, 48],
  ],
});

export function CpuChart() {
  return (
    <ChartContainer width={640}>
      <ChartRow height={240}>
        <Layers>
          <LineChart series={series} column="cpu" as="cpu" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
```

The container **infers the x-axis from the series** — hand it a `ValueSeries`
(`series.byValue('distance')`) and the same `<LineChart>` plots against distance
instead of time, with no axis-type prop.

## What's in the box

- **Charts** — `LineChart`, `AreaChart`, `BarChart`, `ScatterChart`, `BoxPlot`,
  `BandChart`.
- **Layout** — `ChartContainer` / `ChartRow` / `Layers` composition, with
  `YAxis`, `XAxis`, and `TimeAxis`.
- **Interaction** — a cursor system (staffed flag, per-row cursor modes, value
  readouts).
- **Theming** — `defaultTheme` and `estelaTheme`.

## Documentation

Guides, the component reference, and live examples live at
**<https://pjm17971.github.io/pond-ts/>**. Source and issues:
[github.com/pjm17971/pond-ts](https://github.com/pjm17971/pond-ts).

## License

MIT
