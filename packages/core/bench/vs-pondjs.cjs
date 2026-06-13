/**
 * Comprehensive benchmark: pond-ts vs original pondjs
 *
 * Compares performance across all shared core operations at multiple data sizes.
 * Run: node bench/vs-pondjs.cjs
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const pond = require('pondjs');

// ── Helpers ────────────────────────────────────────────────────────

function timeIt(label, fn, warmup = 3, iterations = 20) {
  for (let i = 0; i < warmup; i++) fn();

  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    fn();
    const end = process.hrtime.bigint();
    times.push(Number(end - start) / 1e6); // ms
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  return { median, p95, min: times[0], max: times[times.length - 1] };
}

function generatePoints(n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push([i * 1000, Math.sin(i * 0.01) * 100 + 50, `host-${i % 10}`]);
  }
  return points;
}

function generatePointsNumOnly(n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push([i * 1000, Math.sin(i * 0.01) * 100 + 50]);
  }
  return points;
}

function generatePointsWithGaps(n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    const value = i % 7 === 0 ? null : Math.sin(i * 0.01) * 100 + 50;
    points.push([i * 1000, value]);
  }
  return points;
}

function generateMultiCol(n) {
  const points = [];
  for (let i = 0; i < n; i++) {
    points.push([
      i * 1000,
      Math.sin(i * 0.01) * 100,
      Math.cos(i * 0.01) * 50,
      Math.random() * 200,
    ]);
  }
  return points;
}

// ── pondjs construction ────────────────────────────────────────────

function makePondjsSeries(points) {
  return new pond.TimeSeries({
    name: 'bench',
    columns: ['time', 'value', 'host'],
    points,
  });
}

function makePondjsNumSeries(points) {
  return new pond.TimeSeries({
    name: 'bench',
    columns: ['time', 'value'],
    points,
  });
}

function makePondjsMultiSeries(points) {
  return new pond.TimeSeries({
    name: 'bench',
    columns: ['time', 'a', 'b', 'c'],
    points,
  });
}

// ── Benchmark definitions ──────────────────────────────────────────

const SIZES = [1000, 4000, 16000];

const results = [];

function record(category, operation, size, pondjsTime, pondtsTime) {
  const speedup = pondjsTime.median / pondtsTime.median;
  results.push({ category, operation, size, pondjsTime, pondtsTime, speedup });
}

async function runBenchmarks() {
  // Load pond-ts (ESM)
  const pondts = await import('../dist/index.js');
  const { TimeSeries, Sequence, TimeRange } = pondts;

  console.log('pond-ts vs pondjs benchmark');
  console.log('='.repeat(70));
  console.log();

  for (const N of SIZES) {
    console.log(`── N = ${N} ──`);

    const rawPoints = generatePoints(N);
    const rawNumPoints = generatePointsNumOnly(N);
    const rawGapPoints = generatePointsWithGaps(N);
    const rawMultiPoints = generateMultiCol(N);

    // ── Construction ─────────────────────────────────────────────

    const pondjsConstruct = timeIt(`pondjs construct ${N}`, () => {
      makePondjsSeries(rawPoints);
    });

    const pondtsConstruct = timeIt(`pondts construct ${N}`, () => {
      new TimeSeries({
        name: 'bench',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'value', kind: 'number' },
          { name: 'host', kind: 'string' },
        ],
        rows: rawPoints,
      });
    });
    record(
      'Construction',
      'new TimeSeries()',
      N,
      pondjsConstruct,
      pondtsConstruct,
    );

    // Pre-build series for subsequent benchmarks
    const pjsSeries = makePondjsSeries(rawPoints);
    const ptsSeries = new TimeSeries({
      name: 'bench',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
        { name: 'host', kind: 'string' },
      ],
      rows: rawPoints,
    });

    const pjsNumSeries = makePondjsNumSeries(rawNumPoints);
    const ptsNumSeries = new TimeSeries({
      name: 'bench',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ],
      rows: rawNumPoints,
    });

    const pjsMultiSeries = makePondjsMultiSeries(rawMultiPoints);
    const ptsMultiSeries = new TimeSeries({
      name: 'bench',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'number' },
        { name: 'b', kind: 'number' },
        { name: 'c', kind: 'number' },
      ],
      rows: rawMultiPoints,
    });

    // ── Aggregation (fixedWindowRollup vs aggregate) ─────────────

    const pjsAgg = timeIt(`pondjs aggregate ${N}`, () => {
      pjsNumSeries.fixedWindowRollup({
        windowSize: '10s',
        aggregation: { value: { value: pond.avg() } },
      });
    });

    const ptsAgg = timeIt(`pondts aggregate ${N}`, () => {
      ptsNumSeries.aggregate(Sequence.every('10s'), { value: 'avg' });
    });
    record('Aggregation', 'aggregate(10s, avg)', N, pjsAgg, ptsAgg);

    // Larger bucket
    const pjsAgg60 = timeIt(`pondjs aggregate 60s ${N}`, () => {
      pjsNumSeries.fixedWindowRollup({
        windowSize: '1m',
        aggregation: { value: { value: pond.sum() } },
      });
    });

    const ptsAgg60 = timeIt(`pondts aggregate 60s ${N}`, () => {
      ptsNumSeries.aggregate(Sequence.every('1m'), { value: 'sum' });
    });
    record('Aggregation', 'aggregate(1m, sum)', N, pjsAgg60, ptsAgg60);

    // Multi-reducer aggregation
    const pjsAggMulti = timeIt(`pondjs agg multi ${N}`, () => {
      pjsMultiSeries.fixedWindowRollup({
        windowSize: '10s',
        aggregation: {
          a: { a: pond.avg() },
          b: { b: pond.max() },
          c: { c: pond.min() },
        },
      });
    });

    const ptsAggMulti = timeIt(`pondts agg multi ${N}`, () => {
      ptsMultiSeries.aggregate(Sequence.every('10s'), {
        a: 'avg',
        b: 'max',
        c: 'min',
      });
    });
    record(
      'Aggregation',
      'aggregate(10s, avg+max+min)',
      N,
      pjsAggMulti,
      ptsAggMulti,
    );

    // ── Rolling ──────────────────────────────────────────────────

    const ptsRolling = timeIt(`pondts rolling ${N}`, () => {
      ptsNumSeries.rolling(Sequence.every('1s'), '10s', { value: 'avg' });
    });

    // pondjs has no direct rolling equivalent — Pipeline-based only.
    // We'll time the pondjs aggregate with small buckets as the closest analog.
    // Skip rolling comparison — document that pond-ts has native rolling.

    // ── Rate ─────────────────────────────────────────────────────

    const pjsRate = timeIt(`pondjs rate ${N}`, () => {
      pjsNumSeries.rate({ fieldSpec: 'value' });
    });

    const ptsRate = timeIt(`pondts rate ${N}`, () => {
      ptsNumSeries.rate('value');
    });
    record('Rate', 'rate(value)', N, pjsRate, ptsRate);

    // ── Fill (forward fill / pad) ────────────────────────────────

    const pjsGapSeries = new pond.TimeSeries({
      name: 'bench',
      columns: ['time', 'value'],
      points: rawGapPoints,
    });
    const ptsGapSeries = new TimeSeries({
      name: 'bench',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number', required: false },
      ],
      rows: rawGapPoints.map(([t, v]) => [t, v === null ? undefined : v]),
    });

    const pjsFillPad = timeIt(`pondjs fill pad ${N}`, () => {
      pjsGapSeries.fill({ fieldSpec: 'value', method: 'pad' });
    });

    const ptsFillHold = timeIt(`pondts fill hold ${N}`, () => {
      ptsGapSeries.fill('hold');
    });
    record('Fill', 'fill(hold/pad)', N, pjsFillPad, ptsFillHold);

    // Fill zero
    const pjsFillZero = timeIt(`pondjs fill zero ${N}`, () => {
      pjsGapSeries.fill({ fieldSpec: 'value', method: 'zero' });
    });

    const ptsFillZero = timeIt(`pondts fill zero ${N}`, () => {
      ptsGapSeries.fill('zero');
    });
    record('Fill', 'fill(zero)', N, pjsFillZero, ptsFillZero);

    // Fill linear
    const pjsFillLinear = timeIt(`pondjs fill linear ${N}`, () => {
      pjsGapSeries.fill({ fieldSpec: ['value'], method: 'linear' });
    });

    const ptsFillLinear = timeIt(`pondts fill linear ${N}`, () => {
      ptsGapSeries.fill('linear');
    });
    record('Fill', 'fill(linear)', N, pjsFillLinear, ptsFillLinear);

    // ── Select ───────────────────────────────────────────────────

    const pjsSelect = timeIt(`pondjs select ${N}`, () => {
      pjsSeries.select({ fieldSpec: ['value'] });
    });

    const ptsSelect = timeIt(`pondts select ${N}`, () => {
      ptsSeries.select('value');
    });
    record('Transform', 'select(value)', N, pjsSelect, ptsSelect);

    // ── Map ──────────────────────────────────────────────────────

    const pjsMap = timeIt(`pondjs map ${N}`, () => {
      pjsNumSeries.map((e) => e.setData({ value: e.get('value') * 2 }));
    });

    const numSchema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ];
    const ptsMap = timeIt(`pondts map ${N}`, () => {
      ptsNumSeries.map(numSchema, (e) => e.set('value', e.get('value') * 2));
    });
    record('Transform', 'map(x*2)', N, pjsMap, ptsMap);

    // ── Filter ───────────────────────────────────────────────────
    // pondjs has no native filter() — would need Pipeline. Pond-ts only.

    const ptsFilter = timeIt(`pondts filter ${N}`, () => {
      ptsNumSeries.filter((e) => e.get('value') > 50);
    });
    // Record pond-ts only (no comparison)

    // ── Collapse ─────────────────────────────────────────────────

    const pjsCollapse = timeIt(`pondjs collapse ${N}`, () => {
      pjsMultiSeries.collapse({
        fieldSpecList: ['a', 'b', 'c'],
        name: 'total',
        reducer: pond.sum(),
        append: false,
      });
    });

    const ptsCollapse = timeIt(`pondts collapse ${N}`, () => {
      ptsMultiSeries.collapse(
        ['a', 'b', 'c'],
        'total',
        ({ a, b, c }) => a + b + c,
      );
    });
    record('Transform', 'collapse(a+b+c, sum)', N, pjsCollapse, ptsCollapse);

    // ── Rename ───────────────────────────────────────────────────

    const pjsRename = timeIt(`pondjs rename ${N}`, () => {
      pjsNumSeries.renameColumns({ renameMap: { value: 'measurement' } });
    });

    const ptsRename = timeIt(`pondts rename ${N}`, () => {
      ptsNumSeries.rename({ value: 'measurement' });
    });
    record('Transform', 'rename(value→measurement)', N, pjsRename, ptsRename);

    // ── Align (linear) ──────────────────────────────────────────

    // Create irregularly spaced data for alignment
    const irregPoints = [];
    for (let i = 0; i < N; i++) {
      irregPoints.push([
        i * 1000 + Math.floor(Math.random() * 500),
        Math.sin(i * 0.01) * 100,
      ]);
    }
    irregPoints.sort((a, b) => a[0] - b[0]);
    // Deduplicate timestamps
    const deduped = [irregPoints[0]];
    for (let i = 1; i < irregPoints.length; i++) {
      if (irregPoints[i][0] !== irregPoints[i - 1][0])
        deduped.push(irregPoints[i]);
    }

    const pjsIrregSeries = new pond.TimeSeries({
      name: 'bench',
      columns: ['time', 'value'],
      points: deduped,
    });
    const ptsIrregSeries = new TimeSeries({
      name: 'bench',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ],
      rows: deduped,
    });

    const alignPeriod = N >= 16000 ? '10s' : '5s';

    const pjsAlign = timeIt(`pondjs align ${N}`, () => {
      pjsIrregSeries.align({
        fieldSpec: 'value',
        period: alignPeriod,
        method: 'linear',
      });
    });

    const ptsAlign = timeIt(`pondts align ${N}`, () => {
      ptsIrregSeries.align(Sequence.every(alignPeriod), { method: 'linear' });
    });
    record('Alignment', `align(${alignPeriod}, linear)`, N, pjsAlign, ptsAlign);

    // ── Event access (at) ────────────────────────────────────────

    const pjsAccess = timeIt(
      `pondjs at ${N}`,
      () => {
        for (let i = 0; i < pjsNumSeries.size(); i++) {
          pjsNumSeries.at(i).get('value');
        }
      },
      1,
      5,
    );

    const ptsAccess = timeIt(
      `pondts at ${N}`,
      () => {
        for (let i = 0; i < ptsNumSeries.length; i++) {
          ptsNumSeries.at(i).get('value');
        }
      },
      1,
      5,
    );
    record('Access', 'at(i).get() full scan', N, pjsAccess, ptsAccess);

    // ── Serialization (toJSON) ───────────────────────────────────

    const pjsToJSON = timeIt(`pondjs toJSON ${N}`, () => {
      pjsNumSeries.toJSON();
    });

    const ptsToJSON = timeIt(`pondts toJSON ${N}`, () => {
      ptsNumSeries.toJSON();
    });
    record('Serialization', 'toJSON()', N, pjsToJSON, ptsToJSON);

    // ── Chained operations ───────────────────────────────────────

    const pjsChain = timeIt(`pondjs chain ${N}`, () => {
      pjsNumSeries
        .map((e) => e.setData({ value: e.get('value') * 2 }))
        .select({ fieldSpec: ['value'] });
    });

    const ptsChain = timeIt(`pondts chain ${N}`, () => {
      ptsNumSeries
        .map(numSchema, (e) => e.set('value', e.get('value') * 2))
        .select('value');
    });
    record('Chained', 'map → select', N, pjsChain, ptsChain);

    // ── Statistical reducers ─────────────────────────────────────

    const pjsMedian = timeIt(`pondjs median ${N}`, () => {
      pjsNumSeries.median('value');
    });

    const ptsMedian = timeIt(`pondts median ${N}`, () => {
      ptsNumSeries.reduce('value', 'median');
    });
    record('Statistics', 'median(value)', N, pjsMedian, ptsMedian);

    const pjsStdev = timeIt(`pondjs stdev ${N}`, () => {
      pjsNumSeries.stdev('value');
    });

    const ptsStdev = timeIt(`pondts stdev ${N}`, () => {
      ptsNumSeries.reduce('value', 'stdev');
    });
    record('Statistics', 'stdev(value)', N, pjsStdev, ptsStdev);

    console.log(`  ${N} events: all operations measured`);
  }

  // ── Report ───────────────────────────────────────────────────────

  console.log();
  console.log('='.repeat(90));
  console.log('RESULTS');
  console.log('='.repeat(90));
  console.log();

  // pond-ts median below the timer's usable resolution → "instant" (metadata
  // reshapes like select / rename, which are O(1) column-store rebinds post the
  // columnar wave). Excluded from the geomean below — there the ratio is a
  // near-zero divisor, not a meaningful speedup, and would dominate it.
  const INSTANT_MS = 0.005;
  const isInstant = (r) => r.pondtsTime.median < INSTANT_MS;

  // Group by category
  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    console.log(`── ${cat} ${'─'.repeat(80 - cat.length)}`);
    console.log(
      padR('Operation', 32) +
        padR('N', 7) +
        padR('pondjs (ms)', 13) +
        padR('pond-ts (ms)', 13) +
        padR('Speedup', 10) +
        'Winner',
    );
    console.log('─'.repeat(85));

    const catResults = results.filter((r) => r.category === cat);
    for (const r of catResults) {
      const winner = r.speedup >= 1.0 ? 'pond-ts' : 'pondjs';
      const speedupStr = isInstant(r)
        ? 'instant'
        : r.speedup >= 1.0
          ? `${r.speedup.toFixed(1)}x`
          : `${(1 / r.speedup).toFixed(1)}x`;
      const marker =
        isInstant(r) || r.speedup >= 2.0 ? ' ★' : r.speedup < 0.8 ? ' ⚠' : '';
      console.log(
        padR(r.operation, 32) +
          padR(String(r.size), 7) +
          padR(r.pondjsTime.median.toFixed(2), 13) +
          padR(isInstant(r) ? '<0.01' : r.pondtsTime.median.toFixed(2), 13) +
          padR(speedupStr, 10) +
          winner +
          marker,
      );
    }
    console.log();
  }

  // Summary
  console.log(
    '── Summary ────────────────────────────────────────────────────────',
  );
  const wins = results.filter((r) => r.speedup >= 1.0).length;
  const losses = results.filter((r) => r.speedup < 1.0).length;
  const bigWins = results.filter((r) => r.speedup >= 2.0).length;
  const bigLosses = results.filter((r) => r.speedup < 0.5).length;
  // Geomean over MEASURABLE ops only — instant (sub-resolution) ops would
  // dominate it with a near-zero divisor.
  const measurable = results.filter((r) => !isInstant(r));
  const instantCount = results.length - measurable.length;
  const geoMean = Math.exp(
    measurable.reduce((s, r) => s + Math.log(r.speedup), 0) / measurable.length,
  );

  console.log(`Total benchmarks: ${results.length}`);
  console.log(`pond-ts faster: ${wins}  (${bigWins} by 2x+)`);
  console.log(`pondjs faster:  ${losses}  (${bigLosses} by 2x+)`);
  console.log(
    `Effectively instant (pond-ts below timer resolution): ${instantCount}`,
  );
  console.log(
    `Geometric mean speedup (measurable ops): ${geoMean.toFixed(2)}x`,
  );

  // Flag any regressions
  const regressions = results.filter((r) => r.speedup < 0.8);
  if (regressions.length > 0) {
    console.log();
    console.log('⚠  REGRESSIONS (pond-ts >20% slower):');
    for (const r of regressions) {
      console.log(
        `   ${r.operation} @ N=${r.size}: ${(1 / r.speedup).toFixed(1)}x slower`,
      );
    }
  }
}

function padR(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

runBenchmarks().catch(console.error);
