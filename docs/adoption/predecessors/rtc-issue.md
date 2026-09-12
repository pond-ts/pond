Hi — I wrote react-timeseries-charts while I was at ESnet, and I'm opening
this so anyone who lands here has a pointer to where the work went.

**react-timeseries-charts hasn't had a release since 0.16.1 (May 2019)**, it
depends on Pond.js 0.8/0.9 which is likewise unmaintained, and it renders
through SVG/DOM, which is the ceiling most of the open performance issues here
run into. It still gets ~6k npm downloads a month and 126 issues are open.

**The successor is [`@pond-ts/charts`](https://github.com/pond-ts/pond/tree/main/packages/charts)**
— the same declarative composition (`ChartContainer` → `ChartRow` → layers →
`YAxis`), rebuilt on a canvas data plane so point count is a rendering cost
rather than a DOM-node count, reading a [pond-ts](https://github.com/pond-ts/pond)
`TimeSeries` or streaming `LiveSeries` directly. Line, area, band, bar,
scatter, box plot, candlestick and heat-map layers; time, value and category
axes; cursors, selection, pan/zoom, annotations; trading-time axes.

- npm: `@pond-ts/charts` (peers on `pond-ts`, `@pond-ts/react`, React 18/19) · docs: https://pond-ts.org/docs/charts/
- Nine-chapter walkthrough: https://pond-ts.org/docs/learn-charts
- Large-series rendering guide: https://pond-ts.org/docs/how-to-guides/rendering-large-series

It is pre-1.0, MIT, and actively maintained. It is **not** an ESnet project and
I'm not speaking for ESnet — this is the original author pointing at the
continuation.

**Ask for the maintainers:** a one-paragraph note at the top of the README
(I've opened a PR with exactly that), and/or archiving this repository with
the pointer in the description. Migration questions are welcome as issues on
the pond-ts repo.
