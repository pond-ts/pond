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
    { name: 'volume', kind: 'number' },
  ],
  rows: Array.from({ length: 1_000_000 }, (_, i) => [
    i * 60_000,
    price(i) + spread(i),
    price(i) - spread(i),
    price(i),
    price(i + 1),
    1000 + ((i * 7919) % 997),
  ]),
});

// Session tagging: a New York 09:30-16:00 calendar over the bars' two
// years.
const calendar = f.TradingCalendar.fromRules(
  { timeZone: 'America/New_York', open: '09:30', close: '16:00' },
  { from: '1969-12-31', to: '1971-12-31' },
);

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
  ['t2-zz', 'zzLine', () => f.zigZag(bars)],
  ['t2-ichi', 'ichiSenkouB', () => f.ichimoku(bars)],
  ['t2-impulse', 'impulse', () => f.elderImpulse(bars)],
  ['t2-ray', 'elderBear', () => f.elderRay(bars)],
  ['t2-tii', 'tii', () => f.trendIntensityIndex(bars)],
  ['t2-ravi', 'ravi', () => f.ravi(bars)],
  ['t2-si', 'si', () => f.swingIndex(bars, { limit: 20 })],
  ['t2-asi', 'asi', () => f.accumulativeSwingIndex(bars, { limit: 20 })],
  ['v-atr', 'atr', () => f.atr(bars)],
  ['v-hv', 'hv', () => f.historicalVolatility(bars)],
  ['v-chaikin', 'chaikinVol', () => f.chaikinVolatility(bars)],
  ['v-mass', 'mass', () => f.massIndex(bars)],
  ['v-chop', 'chop', () => f.choppinessIndex(bars)],
  ['v-gapo', 'gapo', () => f.gopalakrishnanRangeIndex(bars)],
  ['v-ulcer', 'ulcer', () => f.ulcerIndex(bars)],
  ['v-relvol', 'relVol', () => f.relativeVolatilityIndex(bars)],
  ['s-linreg', 'linregR2', () => f.linearRegression(bars)],
  ['s-tsf', 'tsf', () => f.timeSeriesForecast(bars)],
  ['s-beta', 'beta', () => f.beta(bars, { benchmark: 'open' })],
  ['s-corr', 'corr', () => f.correlation(bars, { benchmark: 'open' })],
  [
    's-pricerel',
    'priceRel',
    () => f.priceRelative(bars, { benchmark: 'open' }),
  ],
  ['s-perf', 'perf', () => f.performanceIndex(bars, { benchmark: 'open' })],
  ['vo-obv', 'obv', () => f.obv(bars)],
  ['vo-ad', 'ad', () => f.accumulationDistribution(bars, { close: 'open' })],
  ['vo-pvt', 'pvt', () => f.priceVolumeTrend(bars)],
  ['vo-cmf', 'cmf', () => f.chaikinMoneyFlow(bars, { close: 'open' })],
  [
    'vo-chaikin',
    'chaikinOsc',
    () => f.chaikinOscillator(bars, { close: 'open' }),
  ],
  ['vo-mfi', 'mfi', () => f.moneyFlowIndex(bars)],
  ['vo-tmf', 'tmf', () => f.twiggsMoneyFlow(bars)],
  ['vo-force', 'force', () => f.forceIndex(bars)],
  ['vo-eom', 'eom', () => f.easeOfMovement(bars)],
  ['vo-klinger', 'kvo', () => f.klinger(bars)],
  ['vo-volosc', 'volOsc', () => f.volumeOscillator(bars)],
  ['vo-tvi', 'tvi', () => f.tradeVolumeIndex(bars, { minTick: 0.01 })],
  ['vo-nvi', 'nvi', () => f.negativeVolumeIndex(bars)],
  ['vo-pvi', 'pvi', () => f.positiveVolumeIndex(bars)],
  ['vo-bwmfi', 'bwmfi', () => f.marketFacilitationIndex(bars)],
  ['vo-sir', 'sirStrong', () => f.shinoharaIntensityRatio(bars)],
  ['vo-vwap', 'vwap', () => f.vwap(bars, { period: 20 })],
  ['p-typical', 'typicalPrice', () => f.typicalPrice(bars)],
  ['p-median', 'medianPrice', () => f.medianPrice(bars)],
  ['p-wclose', 'weightedClose', () => f.weightedClose(bars)],
  ['p-avg', 'averagePrice', () => f.averagePrice(bars)],
  ['p-bop', 'bop', () => f.balanceOfPower(bars)],
  ['p-bop14', 'bop', () => f.balanceOfPower(bars, { period: 14 })],
  ['cal-tag', 'session', () => calendar.tagSessions(bars)],
  [
    'cal-tag-close',
    'session',
    () => calendar.tagSessions(bars, { stamped: 'close' }),
  ],
  ['sess-svwap', 'svwap', () => f.sessionVwap(bars, { sessions: calendar })],
  ['sess-pivot', 'ppPivot', () => f.pivotPoints(bars, { sessions: calendar })],
  [
    'sess-pivot-cam',
    'ppR4',
    () => f.pivotPoints(bars, { sessions: calendar, method: 'camarilla' }),
  ],
  [
    'sess-avwap',
    'avwap',
    () => f.anchoredVwap(bars, { anchor: 500_000 * 60_000 }),
  ],
];

const only = process.argv[2];
// POND_BITS=1: instead of timing, print a hash of every bit of every
// number column in the result (a gap hashes as one fixed value), to check
// the 1M-row outputs match pond-rs bit for bit (pond-rs prints the same
// hash under the same variable).
if (process.env.POND_BITS) {
  const f64 = new Float64Array(1);
  const u64 = new BigUint64Array(f64.buffer);
  const mask = (1n << 64n) - 1n;
  const GAP = 0x7ff8dead00000000n;
  for (const [name, , run] of cases) {
    if (only && !name.startsWith(only)) continue;
    const result = run();
    let h = 0xcbf29ce484222325n;
    for (const def of result.schema) {
      if (def.kind !== 'number') continue;
      const col = result.column(def.name);
      for (let i = 0; i < result.length; i += 1) {
        const v = col.at(i);
        if (v === undefined) {
          h ^= GAP;
        } else {
          f64[0] = v;
          h ^= u64[0];
        }
        h = (h * 0x100000001b3n) & mask;
      }
    }
    console.log(`${name} ${h.toString(16)}`);
  }
  process.exit(0);
}
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
