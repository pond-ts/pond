/**
 * @pond-ts/charts adapter for the SciChart javascript-chart-performance-test-suite.
 * Bundled (esbuild --bundle --minify) into pond_tests.js; defines the global
 * e*PerformanceTest hooks that public/after.js drives.
 *
 * Faithfulness notes:
 * - Charts are 800x600, cursor off, no legend — matching the uPlot adapter.
 * - Per-frame updates run through flushSync so each updateChart() call pays its
 *   full React render + canvas draw synchronously inside the harness's frame
 *   timing, like the imperative libraries' setData/setScale calls.
 * - Brownian scatter + unsorted-XY-line return createChart:false (SKIPPED):
 *   pond is a time-series library; its series contract is monotonic sorted x.
 *   Multi-chart with >=2 charts includes a Brownian scatter slot, so it is
 *   skipped beyond 1 chart for the same reason.
 * - Heatmap/3D hooks are left undefined (suite reports UNSUPPORTED).
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TimeSeries, LiveSeries } from 'pond-ts';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  AreaChart,
  BarChart,
  Candlestick,
  ScatterChart,
  YAxis,
  estelaTheme,
} from '@pond-ts/charts';

const g = globalThis;

g.eLibName = () => 'pond-charts';
g.eLibVersion = () => '0.50.0';
g.getSupportedTests = () => [
  'N line series M points',
  'Point series, sorted, updating y-values',
  'Column chart with data ascending in X',
  'Candlestick series test',
  'FIFO / ECG Chart Performance Test',
  'Mountain Chart Performance Test',
  'Series Compression Test',
  'Multi Chart Performance Test',
];

const ROLES = ['foam', 'hr', 'elevation'];
const AXIS_STRIP = 56; // x-axis strip inside the 600px budget

function mounter(divId, width, height) {
  const el = document.getElementById(divId);
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  const root = createRoot(el);
  return {
    render(node) {
      flushSync(() => root.render(node));
    },
    destroy() {
      root.unmount();
      el.innerHTML = '';
    },
  };
}

function Frame({ width, height, range, children }) {
  return (
    <ChartContainer
      width={width}
      theme={estelaTheme}
      cursor="none"
      range={range}
    >
      <ChartRow height={height - AXIS_STRIP}>{children}</ChartRow>
    </ChartContainer>
  );
}

const LINE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
];

/** N line series x M points; per-frame programmatic y-zoom-out (delta = maxAbs/300). */
g.eLinePerformanceTest = function (
  seriesNum,
  pointsNum,
  divId = 'chart-root',
  width = 800,
  height = 600,
) {
  let m, seriesArr, yMin, yMax, delta;

  const view = () => (
    <Frame width={width} height={height}>
      <YAxis id="y" min={yMin} max={yMax} />
      <Layers>
        {seriesArr.map((s, i) => (
          <LineChart
            key={i}
            series={s}
            column="v"
            as={ROLES[i % ROLES.length]}
          />
        ))}
      </Layers>
    </Frame>
  );

  return {
    createChart: async () => {
      m = mounter(divId, width, height);
    },
    generateData: () => {
      seriesArr = [];
      let maxAbs = 0;
      for (let i = 0; i < seriesNum; i++) {
        const x = new Float64Array(pointsNum);
        const y = new Float64Array(pointsNum);
        let prev = 0;
        for (let j = 0; j < pointsNum; j++) {
          prev += Math.random() * 10 - 5;
          x[j] = j;
          y[j] = prev;
          const a = Math.abs(prev);
          if (a > maxAbs) maxAbs = a;
        }
        seriesArr.push(
          TimeSeries.fromColumns({
            name: `s${i}`,
            schema: LINE_SCHEMA,
            columns: { time: x, v: y },
          }),
        );
      }
      yMin = -maxAbs;
      yMax = maxAbs;
      delta = maxAbs / 300;
    },
    appendData: () => m.render(view()),
    updateChart: () => {
      yMin -= delta;
      yMax += delta;
      m.render(view());
      return seriesNum * pointsNum;
    },
    deleteChart: () => m.destroy(),
  };
};

/** Brownian scatter: unsorted x is outside pond's sorted-time series contract. */
g.eScatterPerformanceTest = function () {
  return {
    createChart: async () => false,
    generateData: () => {},
    appendData: () => {},
    updateChart: () => 0,
    deleteChart: () => {},
  };
};

/** Unsorted-x line: same contract exclusion as scatter. */
g.eScatterLinePerformanceTest = g.eScatterPerformanceTest;

/** Sorted x, all y values jittered + fully re-set each frame (line + point markers). */
g.ePointLinePerformanceTest = function (
  seriesNum,
  pointsNum,
  divId = 'chart-root',
  width = 800,
  height = 600,
) {
  let m,
    xBuf,
    yBuf,
    ts,
    gen = 0;
  const Y_MAX = 50;
  const EXTRA = 10;

  const rebuild = () => {
    // fromColumns adopts Float64Arrays zero-copy; fresh object identity per
    // frame tells the chart the data changed.
    ts = TimeSeries.fromColumns({
      name: `pl${gen++}`,
      schema: LINE_SCHEMA,
      columns: { time: xBuf, v: yBuf },
    });
  };

  const view = () => (
    <Frame width={width} height={height}>
      <YAxis id="y" min={-EXTRA} max={Y_MAX + EXTRA} />
      <Layers>
        <LineChart series={ts} column="v" as="foam" />
        <ScatterChart series={ts} column="v" as="hr" />
      </Layers>
    </Frame>
  );

  return {
    createChart: async () => {
      m = mounter(divId, width, height);
    },
    generateData: () => {
      xBuf = new Float64Array(pointsNum);
      yBuf = new Float64Array(pointsNum);
      for (let i = 0; i < pointsNum; i++) {
        xBuf[i] = i;
        yBuf[i] = Math.round(Math.random() * Y_MAX);
      }
      rebuild();
    },
    appendData: () => m.render(view()),
    updateChart: () => {
      for (let i = 0; i < pointsNum; i++) yBuf[i] += Math.random() - 0.5;
      rebuild();
      m.render(view());
      return pointsNum;
    },
    deleteChart: () => m.destroy(),
  };
};

/** Static ascending-x columns; per-frame y-zoom-out. */
g.eColumnPerformanceTest = function (
  seriesNum,
  pointsNum,
  divId = 'chart-root',
  width = 800,
  height = 600,
) {
  let m, ts, yMin, yMax, delta;

  const view = () => (
    <Frame width={width} height={height}>
      <YAxis id="y" min={yMin} max={yMax} />
      <Layers>
        <BarChart series={ts} column="v" as="foam" />
      </Layers>
    </Frame>
  );

  return {
    createChart: async () => {
      m = mounter(divId, width, height);
    },
    generateData: () => {
      const x = new Float64Array(pointsNum);
      const y = new Float64Array(pointsNum);
      let prev = 0;
      let maxAbs = 0;
      for (let i = 0; i < pointsNum; i++) {
        prev += Math.random() * 10 - 5;
        x[i] = i;
        y[i] = prev;
        const a = Math.abs(prev);
        if (a > maxAbs) maxAbs = a;
      }
      ts = TimeSeries.fromColumns({
        name: 'col',
        schema: LINE_SCHEMA,
        columns: { time: x, v: y },
      });
      yMin = -maxAbs;
      yMax = maxAbs;
      delta = maxAbs / 300;
    },
    appendData: () => m.render(view()),
    updateChart: () => {
      yMin -= delta;
      yMax += delta;
      m.render(view());
      return seriesNum * pointsNum;
    },
    deleteChart: () => m.destroy(),
  };
};

const OHLC_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
];

/** Static candles; per-frame y-max growth (min pinned at 0), matching uPlot's variant. */
g.eCandlestickPerformanceTest = function (
  seriesNum,
  pointsNum,
  divId = 'chart-root',
  width = 800,
  height = 600,
) {
  let m, ts, yMax, delta;

  const view = () => (
    <Frame width={width} height={height}>
      <YAxis id="y" min={0} max={yMax} />
      <Layers>
        <Candlestick series={ts} />
      </Layers>
    </Frame>
  );

  return {
    createChart: async () => {
      m = mounter(divId, width, height);
    },
    generateData: () => {
      const t = new Float64Array(pointsNum);
      const open = new Float64Array(pointsNum);
      const high = new Float64Array(pointsNum);
      const low = new Float64Array(pointsNum);
      const close = new Float64Array(pointsNum);
      for (let i = 0; i < pointsNum; i++) {
        const o = Math.random();
        const c = Math.random();
        const v1 = Math.random();
        const v2 = Math.random();
        t[i] = i;
        open[i] = o;
        close[i] = c;
        high[i] = Math.max(v1, v2, o, c);
        low[i] = Math.min(v1, v2, o, c);
      }
      ts = TimeSeries.fromColumns({
        name: 'ohlc',
        schema: OHLC_SCHEMA,
        columns: { time: t, open, high, low, close },
      });
      yMax = 1;
      delta = yMax / 300;
    },
    appendData: () => m.render(view()),
    updateChart: () => {
      yMax += delta;
      m.render(view());
      return seriesNum * pointsNum;
    },
    deleteChart: () => m.destroy(),
  };
};

/** FIFO/ECG: LiveSeries ring of `pointsNum`, 5 columns; append `increment` rows per frame, sliding x window. */
g.eFifoEcgPerformanceTest = function (
  seriesNum,
  pointsNum,
  incrementPoints,
  divId = 'chart-root',
  width = 800,
  height = 600,
) {
  let m,
    live,
    snap,
    index = 0,
    initialRows;
  const schema = [
    { name: 'time', kind: 'time' },
    ...Array.from({ length: seriesNum }, (_, i) => ({
      name: `s${i}`,
      kind: 'number',
    })),
  ];

  const makeRows = (count, start) => {
    const rows = new Array(count);
    for (let j = 0; j < count; j++) {
      const row = new Array(seriesNum + 1);
      row[0] = start + j;
      for (let i = 0; i < seriesNum; i++) row[i + 1] = Math.random() + i * 2;
      rows[j] = row;
    }
    return rows;
  };

  const view = () => (
    <Frame
      width={width}
      height={height}
      range={[Math.max(0, index - pointsNum), Math.max(1, index - 1)]}
    >
      <YAxis id="y" min={0} max={seriesNum * 2 + 1} />
      <Layers>
        {Array.from({ length: seriesNum }, (_, i) => (
          <LineChart
            key={i}
            series={snap}
            column={`s${i}`}
            as={ROLES[i % ROLES.length]}
          />
        ))}
      </Layers>
    </Frame>
  );

  return {
    createChart: async () => {
      m = mounter(divId, width, height);
      live = new LiveSeries({
        name: 'ecg',
        schema,
        retention: { maxEvents: pointsNum },
      });
    },
    generateData: () => {
      initialRows = makeRows(pointsNum, 0);
    },
    appendData: () => {
      live.pushMany(initialRows);
      index = pointsNum;
      snap = live.toTimeSeries();
      m.render(view());
    },
    updateChart: () => {
      live.pushMany(makeRows(incrementPoints, index));
      index += incrementPoints;
      snap = live.toTimeSeries();
      m.render(view());
      return seriesNum * index;
    },
    deleteChart: () => m.destroy(),
  };
};

/** Static mountain (area); per-frame y-zoom-out. */
g.eMountainPerformanceTest = function (
  seriesNum,
  pointsNum,
  divId = 'chart-root',
  width = 800,
  height = 600,
) {
  let m, ts, yMin, yMax, delta;

  const view = () => (
    <Frame width={width} height={height}>
      <YAxis id="y" min={yMin} max={yMax} />
      <Layers>
        <AreaChart series={ts} column="v" as="foam" />
      </Layers>
    </Frame>
  );

  return {
    createChart: async () => {
      m = mounter(divId, width, height);
    },
    generateData: () => {
      const x = new Float64Array(pointsNum);
      const y = new Float64Array(pointsNum);
      let prev = 0;
      let maxAbs = 0;
      for (let i = 0; i < pointsNum; i++) {
        prev += Math.random() * 10 - 5;
        x[i] = i;
        y[i] = prev;
        const a = Math.abs(prev);
        if (a > maxAbs) maxAbs = a;
      }
      ts = TimeSeries.fromColumns({
        name: 'mtn',
        schema: LINE_SCHEMA,
        columns: { time: x, v: y },
      });
      yMin = -maxAbs;
      yMax = maxAbs;
      delta = maxAbs / 300;
    },
    appendData: () => m.render(view()),
    updateChart: () => {
      yMin -= delta;
      yMax += delta;
      m.render(view());
      return seriesNum * pointsNum;
    },
    deleteChart: () => m.destroy(),
  };
};

/** Growing append: capacity-doubling buffers, zero-copy subarray view per frame, full-extent x. */
g.eSeriesCompressionPerformanceTest = function (
  seriesNum,
  pointsNum,
  incrementPoints,
  divId = 'chart-root',
  width = 800,
  height = 600,
) {
  let m,
    xBuf,
    yBuf,
    cap,
    points = 0,
    prev = 0,
    ts,
    gen = 0;

  const ensure = (need) => {
    if (need <= cap) return;
    while (cap < need) cap *= 2;
    const nx = new Float64Array(cap);
    const ny = new Float64Array(cap);
    nx.set(xBuf.subarray(0, points));
    ny.set(yBuf.subarray(0, points));
    xBuf = nx;
    yBuf = ny;
  };

  const growBy = (count) => {
    ensure(points + count);
    for (let i = 0; i < count; i++) {
      xBuf[points] = points;
      prev += Math.random() * 10 - 5;
      yBuf[points] = prev;
      points += 1;
    }
    ts = TimeSeries.fromColumns({
      name: `grow${gen++}`,
      schema: LINE_SCHEMA,
      columns: { time: xBuf.subarray(0, points), v: yBuf.subarray(0, points) },
    });
  };

  const view = () => (
    <Frame width={width} height={height} range={[0, Math.max(1, points - 1)]}>
      <YAxis id="y" />
      <Layers>
        <LineChart series={ts} column="v" as="foam" />
      </Layers>
    </Frame>
  );

  return {
    createChart: async () => {
      m = mounter(divId, width, height);
      cap = Math.max(1024, pointsNum * 2);
      xBuf = new Float64Array(cap);
      yBuf = new Float64Array(cap);
      points = 0;
      prev = 0;
    },
    generateData: () => growBy(pointsNum),
    appendData: () => m.render(view()),
    updateChart: () => {
      growBy(incrementPoints);
      m.render(view());
      return points;
    },
    deleteChart: () => m.destroy(),
  };
};

/**
 * Multi-chart: the suite's rotation is line/scatter/column/mountain; every
 * config beyond 1 chart includes a Brownian-scatter slot, which pond's sorted-x
 * contract excludes — so 1 chart runs (line), the rest report SKIPPED.
 */
g.eMultiChartPerformanceTest = function (
  seriesNum,
  pointsNum,
  incrementPoints,
  chartsNum,
) {
  if (chartsNum > 1) {
    return {
      createChart: async () => false,
      generateData: () => {},
      appendData: () => {},
      updateChart: () => 0,
      deleteChart: () => {},
    };
  }
  const chartRootDiv = document.getElementById('chart-root');
  chartRootDiv.innerHTML = '';
  const w = chartRootDiv.offsetWidth || 800;
  const h = chartRootDiv.offsetHeight || 600;
  return g.eSeriesCompressionPerformanceTest(
    seriesNum,
    pointsNum,
    incrementPoints,
    'chart-root',
    w,
    h,
  );
};
