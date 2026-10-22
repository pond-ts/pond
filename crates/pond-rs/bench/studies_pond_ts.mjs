// @pond-ts/financial side of examples/perf_studies.rs: same data, same
// calls, same checksum (present values in the output, and their sum).
//
//     npm run build --workspace=pond-ts
//     npm run build --workspace=@pond-ts/financial
//     node crates/pond-rs/bench/studies_pond_ts.mjs [name prefix]
import { TimeSeries } from '../../../packages/core/dist/index.js';
import * as f from '../../../packages/financial/dist/index.js';

const price = (i) => 100 + ((i * 7919) % 10_007) / 800;
const make = (rows, gappy) =>
  new TimeSeries({
    name: 'bench',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number', required: false },
    ],
    rows: Array.from({ length: rows }, (_, i) => [
      i * 60_000,
      !gappy || i % 17 !== 5 ? price(i) : undefined,
    ]),
  });
const dense = make(1_000_000, false);
const gappy = make(1_000_000, true);
// Price bars for the bands family: high and low a varying spread either
// side of the close.
const spread = (i) => ((i * 31) % 97) / 100 + 0.1;
const bars = new TimeSeries({
  name: 'bars',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'high', kind: 'number' },
    { name: 'low', kind: 'number' },
    { name: 'close', kind: 'number' },
    { name: 'open', kind: 'number' },
  ],
  rows: Array.from({ length: 1_000_000 }, (_, i) => [
    i * 60_000,
    price(i) + spread(i),
    price(i) - spread(i),
    price(i),
    price(i + 1),
  ]),
});

const cases = [
  ['sma 20', 'sma', () => f.sma(dense, { period: 20 })],
  ['sma 200', 'sma', () => f.sma(dense, { period: 200 })],
  ['sma 20 gaps', 'sma', () => f.sma(gappy, { period: 20 })],
  ['ema 20', 'ema', () => f.ema(dense, { period: 20 })],
  ['stdev 20', 'stdev', () => f.rollingStdev(dense, { period: 20 })],
  ['min 20', 'min', () => f.rollingMin(dense, { period: 20 })],
  ['max 200', 'max', () => f.rollingMax(dense, { period: 200 })],
  ['p90 20', 'p90', () => f.rollingPercentile(dense, { period: 20, q: 90 })],
  ['zscore 20', 'zscore', () => f.zScore(dense, { period: 20 })],
  ['zscore 20 gaps', 'zscore', () => f.zScore(gappy, { period: 20 })],
  ...f.MA_TYPES.map((type) => [
    `ma ${type} 20`,
    'ma',
    () => f.movingAverage(dense, { period: 20, type }),
  ]),
  ['macd', 'macdSignal', () => f.macd(dense)],
  ['priceOsc', 'priceOsc', () => f.priceOscillator(dense)],
  ['maCross', 'maCross', () => f.movingAverageCross(dense)],
  ['maDev 20', 'maDev', () => f.movingAverageDeviation(dense, { period: 20 })],
  ['disparity 14', 'disparity', () => f.disparityIndex(dense, { period: 14 })],
  ['dpo 20', 'dpo', () => f.detrendedPriceOscillator(dense, { period: 20 })],
  ['guppy', 'gmmaL60', () => f.guppy(dense)],
  ['rainbow', 'rainbow10', () => f.rainbow(dense)],
  ['rbo', 'rbo', () => f.rainbowOscillator(dense)],
  ['trix', 'trixSignal', () => f.trix(dense)],
  ['stc', 'stc', () => f.schaffTrendCycle(dense)],
  ['coppock', 'coppock', () => f.coppock(dense)],
  ['kst', 'kstSignal', () => f.kst(dense)],
  ['specialK', 'specialK', () => f.specialK(dense)],
  ['pmo', 'pmoSignal', () => f.priceMomentumOscillator(dense)],
  ['bollinger 20', 'bbUpper', () => f.bollinger(bars, { period: 20 })],
  ['bbWidth', 'bbWidth', () => f.bollingerBandwidth(bars)],
  ['percentB', 'percentB', () => f.bollingerPercentB(bars)],
  ['keltner', 'kcUpper', () => f.keltner(bars)],
  ['starc', 'starcUpper', () => f.starcBands(bars)],
  ['atrBands', 'atrbUpper', () => f.atrBands(bars)],
  ['donchian', 'dcMiddle', () => f.donchian(bars)],
  ['highLowBands', 'hlbUpper', () => f.highLowBands(bars)],
  ['primeBands', 'pnbUpper', () => f.primeNumberBands(bars)],
  ['envelope 20', 'envUpper', () => f.envelope(bars, { period: 20 })],
  ['rsi', 'rsi', () => f.rsi(bars)],
  ['stochastic', 'stochD', () => f.stochastic(bars)],
  ['smi', 'smiSignal', () => f.stochasticMomentumIndex(bars)],
  ['stochRsi', 'stochRsiD', () => f.stochasticRsi(bars)],
  ['williamsR', 'williamsR', () => f.williamsR(bars)],
  ['cmo', 'cmo', () => f.chandeMomentum(bars)],
  ['momentum', 'momentum', () => f.momentum(bars)],
  ['pctChange', 'pctChange', () => f.percentChange(bars)],
  ['imi', 'imi', () => f.intradayMomentumIndex(bars)],
  ['ao', 'ao', () => f.awesomeOscillator(bars)],
  ['uo', 'uo', () => f.ultimateOscillator(bars)],
  ['cci', 'cci', () => f.commodityChannelIndex(bars)],
  ['fisher', 'fisher', () => f.fisherTransform(bars)],
  ['psy', 'psy', () => f.psychologicalLine(bars)],
  ['pgo', 'pgo', () => f.prettyGoodOscillator(bars)],
  ['pno', 'pno', () => f.primeNumberOscillator(bars)],
  ['qstick', 'qstick', () => f.qstick(bars)],
  ['rvi', 'rviSignal', () => f.relativeVigorIndex(bars)],
  ['cog', 'cog', () => f.centerOfGravity(bars)],
  ['cfo', 'cfo', () => f.chandeForecastOscillator(bars)],
  ['tsi', 'tsiSignal', () => f.trueStrengthIndex(bars)],
  ['t-dmi', 'dmiAdxr', () => f.directionalMovement(bars)],
  ['t-aroon', 'aroonOsc', () => f.aroon(bars)],
  ['t-vortex', 'viMinus', () => f.vortex(bars)],
  ['t-vhf', 'vhf', () => f.verticalHorizontalFilter(bars)],
  ['t-rwi', 'rwiHigh', () => f.randomWalkIndex(bars)],
  ['t-st', 'st', () => f.superTrend(bars)],
  ['t-psar', 'psar', () => f.parabolicSar(bars)],
  ['t-ats', 'ats', () => f.atrTrailingStop(bars)],
];

const only = process.argv[2];
console.log('| Case | pond-ts | checksum |');
console.log('| --- | --- | --- |');
for (const [name, column, run] of cases) {
  if (only && !name.startsWith(only)) continue;
  let result = run();
  const times = [];
  for (let k = 0; k < 7; k++) {
    const t = performance.now();
    result = run();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const col = result.column(column);
  let n = 0;
  let sum = 0;
  for (let i = 0; i < result.length; i += 1) {
    const v = col.at(i);
    if (v !== undefined) {
      n += 1;
      sum += v;
    }
  }
  console.log(
    `| ${name} | ${times[3].toFixed(1)} ms | ${n} ${sum.toExponential(6)} |`,
  );
}
