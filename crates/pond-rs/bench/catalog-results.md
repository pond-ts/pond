# Catalog benchmark: every study, pond-rs against pond-ts

R2 step 5 (2026-10-23). Each of the 109 catalog studies at its defaults (the
catalog's example value where an option has none) on the same 1M one-minute
bars, median of 7 runs, in milliseconds. `bits` compares a hash of every bit
of every output column across all three runs.

- pond-rs: [`../examples/perf_catalog.rs`](../examples/perf_catalog.rs), on
  4 cores and with `RAYON_NUM_THREADS=1`.
- pond-ts: [`catalog_pond_ts.mjs`](catalog_pond_ts.mjs) (Node 22).
- Table: `python3 catalog_table.py ts.jsonl rs4.jsonl rs1.jsonl`.
- `ratio` is pond-ts time over pond-rs 4-core time.

| study                    | 1 thread | 4 cores | pond-ts | ratio | bits |
| ------------------------ | -------- | ------- | ------- | ----- | ---- |
| sma                      | 12.7     | 3.4     | 55.0    | 16.3x | same |
| ema                      | 4.8      | 4.7     | 10.5    | 2.3x  | same |
| movingAverage            | 9.1      | 2.9     | 34.1    | 11.9x | same |
| macd                     | 14.6     | 15.0    | 84.5    | 5.6x  | same |
| movingAverageCross       | 23.5     | 10.3    | 52.6    | 5.1x  | same |
| movingAverageDeviation   | 8.2      | 4.3     | 44.0    | 10.1x | same |
| guppy                    | 81.9     | 22.6    | 228.8   | 10.1x | same |
| rainbow                  | 79.9     | 34.4    | 262.8   | 7.6x  | same |
| rainbowOscillator        | 132.2    | 86.5    | 716.8   | 8.3x  | same |
| trix                     | 12.6     | 13.7    | 115.6   | 8.5x  | same |
| schaffTrendCycle         | 49.3     | 27.1    | 212.2   | 7.8x  | same |
| detrendedPriceOscillator | 12.7     | 5.7     | 52.7    | 9.2x  | same |
| disparityIndex           | 10.2     | 4.7     | 49.2    | 10.6x | same |
| coppock                  | 21.2     | 9.6     | 34.1    | 3.5x  | same |
| kst                      | 52.4     | 13.7    | 197.0   | 14.4x | same |
| specialK                 | 101.4    | 40.6    | 300.7   | 7.4x  | same |
| priceOscillator          | 8.6      | 5.7     | 62.9    | 11.0x | same |
| priceMomentumOscillator  | 12.0     | 7.6     | 42.9    | 5.7x  | same |
| bollinger                | 37.4     | 10.9    | 82.6    | 7.5x  | same |
| bollingerBandwidth       | 25.9     | 11.1    | 97.6    | 8.8x  | same |
| bollingerPercentB        | 29.8     | 12.2    | 72.8    | 6.0x  | same |
| keltner                  | 26.9     | 13.2    | 63.7    | 4.8x  | same |
| starcBands               | 27.8     | 12.1    | 84.9    | 7.0x  | same |
| atrBands                 | 18.4     | 12.5    | 63.8    | 5.1x  | same |
| donchian                 | 26.7     | 9.2     | 272.5   | 29.7x | same |
| highLowBands             | 35.4     | 12.1    | 65.4    | 5.4x  | same |
| primeNumberBands         | 52.9     | 16.6    | 70.4    | 4.2x  | same |
| envelope                 | 20.6     | 6.3     | 53.0    | 8.4x  | same |
| rsi                      | 9.3      | 9.3     | 54.0    | 5.8x  | same |
| stochastic               | 41.0     | 15.5    | 262.5   | 17.0x | same |
| stochasticMomentumIndex  | 47.0     | 18.5    | 263.6   | 14.2x | same |
| stochasticRsi            | 48.0     | 24.6    | 205.5   | 8.4x  | same |
| williamsR                | 20.1     | 9.7     | 193.9   | 19.9x | same |
| chandeMomentum           | 29.4     | 12.2    | 98.0    | 8.0x  | same |
| momentum                 | 3.3      | 2.2     | 26.9    | 12.1x | same |
| percentChange            | 3.5      | 4.4     | 19.0    | 4.3x  | same |
| intradayMomentumIndex    | 22.1     | 12.1    | 110.0   | 9.1x  | same |
| awesomeOscillator        | 24.4     | 12.6    | 54.0    | 4.3x  | same |
| ultimateOscillator       | 98.4     | 26.9    | 145.4   | 5.4x  | same |
| commodityChannelIndex    | 42.5     | 17.9    | 129.6   | 7.3x  | same |
| fisherTransform          | 50.9     | 43.8    | 146.8   | 3.4x  | same |
| psychologicalLine        | 13.0     | 8.3     | 64.4    | 7.8x  | same |
| prettyGoodOscillator     | 20.4     | 13.9    | 53.3    | 3.8x  | same |
| primeNumberOscillator    | 45.9     | 12.8    | 46.2    | 3.6x  | same |
| qstick                   | 8.7      | 6.5     | 45.7    | 7.1x  | same |
| relativeVigorIndex       | 33.2     | 18.2    | 123.8   | 6.8x  | same |
| centerOfGravity          | 18.1     | 7.4     | 74.0    | 10.0x | same |
| chandeForecastOscillator | 27.5     | 12.7    | 83.2    | 6.6x  | same |
| trueStrengthIndex        | 21.2     | 11.0    | 65.1    | 5.9x  | same |
| directionalMovement      | 50.1     | 26.6    | 155.8   | 5.9x  | same |
| aroon                    | 42.2     | 20.9    | 66.8    | 3.2x  | same |
| vortex                   | 45.8     | 16.6    | 102.6   | 6.2x  | same |
| verticalHorizontalFilter | 50.1     | 13.9    | 209.3   | 15.0x | same |
| randomWalkIndex          | 250.5    | 53.2    | 389.5   | 7.3x  | same |
| superTrend               | 23.6     | 22.2    | 62.9    | 2.8x  | same |
| parabolicSar             | 13.2     | 10.5    | 52.6    | 5.0x  | same |
| atrTrailingStop          | 20.8     | 18.1    | 56.5    | 3.1x  | same |
| zigZag                   | 18.5     | 18.1    | 129.8   | 7.2x  | same |
| ichimoku                 | 111.6    | 41.4    | 237.5   | 5.7x  | same |
| elderImpulse             | 15.0     | 14.0    | 123.3   | 8.8x  | same |
| elderRay                 | 7.2      | 7.6     | 48.0    | 6.3x  | same |
| trendIntensityIndex      | 31.0     | 13.7    | 94.7    | 6.9x  | same |
| ravi                     | 12.5     | 7.1     | 75.5    | 10.6x | same |
| swingIndex               | 6.7      | 11.6    | 60.2    | 5.2x  | same |
| accumulativeSwingIndex   | 9.8      | 15.2    | 52.1    | 3.4x  | same |
| atr                      | 8.5      | 9.3     | 34.2    | 3.7x  | same |
| historicalVolatility     | 43.5     | 25.0    | 63.5    | 2.5x  | same |
| chaikinVolatility        | 10.5     | 9.5     | 33.4    | 3.5x  | same |
| massIndex                | 21.4     | 17.1    | 81.7    | 4.8x  | same |
| choppinessIndex          | 49.2     | 41.1    | 319.9   | 7.8x  | same |
| gopalakrishnanRangeIndex | 25.6     | 17.0    | 341.5   | 20.1x | same |
| ulcerIndex               | 23.3     | 12.7    | 124.5   | 9.8x  | same |
| relativeVolatilityIndex  | 50.0     | 24.9    | 82.0    | 3.3x  | same |
| obv                      | 6.3      | 4.7     | 24.8    | 5.3x  | same |
| accumulationDistribution | 8.7      | 8.3     | 37.7    | 4.5x  | same |
| priceVolumeTrend         | 9.5      | 6.6     | 34.6    | 5.2x  | same |
| chaikinMoneyFlow         | 21.9     | 13.1    | 99.8    | 7.6x  | same |
| chaikinOscillator        | 21.7     | 16.9    | 52.6    | 3.1x  | same |
| moneyFlowIndex           | 36.0     | 18.8    | 77.9    | 4.1x  | same |
| twiggsMoneyFlow          | 30.9     | 24.2    | 85.5    | 3.5x  | same |
| forceIndex               | 6.4      | 4.8     | 34.7    | 7.2x  | same |
| easeOfMovement           | 16.2     | 10.4    | 63.6    | 6.1x  | same |
| klinger                  | 22.9     | 17.0    | 109.7   | 6.5x  | same |
| volumeOscillator         | 13.1     | 6.5     | 51.1    | 7.8x  | same |
| tradeVolumeIndex         | 5.1      | 4.9     | 47.3    | 9.7x  | same |
| negativeVolumeIndex      | 6.0      | 5.6     | 47.9    | 8.5x  | same |
| positiveVolumeIndex      | 5.5      | 5.1     | 50.8    | 10.0x | same |
| marketFacilitationIndex  | 5.4      | 6.2     | 37.9    | 6.1x  | same |
| shinoharaIntensityRatio  | 50.2     | 17.8    | 196.1   | 11.0x | same |
| vwap                     | 26.0     | 12.7    | 72.2    | 5.7x  | same |
| anchoredVwap             | 9.9      | 8.1     | 46.2    | 5.7x  | same |
| linearRegression         | 52.4     | 14.0    | 70.6    | 5.1x  | same |
| timeSeriesForecast       | 26.4     | 10.6    | 56.7    | 5.4x  | same |
| beta                     | 60.3     | 17.3    | 79.2    | 4.6x  | same |
| correlation              | 51.8     | 15.8    | 63.3    | 4.0x  | same |
| priceRelative            | 3.9      | 3.3     | 30.8    | 9.2x  | same |
| performanceIndex         | 3.7      | 3.5     | 23.9    | 6.9x  | same |
| zScore                   | 31.5     | 24.8    | 82.2    | 3.3x  | same |
| rollingStdev             | 21.7     | 8.9     | 32.0    | 3.6x  | same |
| rollingMin               | 8.0      | 4.5     | 144.9   | 32.4x | same |
| rollingMax               | 9.4      | 3.8     | 121.8   | 32.5x | same |
| rollingPercentile        | 74.0     | 73.2    | 188.9   | 2.6x  | same |
| typicalPrice             | 4.7      | 6.0     | 18.3    | 3.0x  | same |
| medianPrice              | 3.6      | 3.5     | 12.7    | 3.6x  | same |
| weightedClose            | 4.3      | 4.5     | 20.4    | 4.5x  | same |
| averagePrice             | 5.0      | 6.9     | 20.3    | 3.0x  | same |
| balanceOfPower           | 5.3      | 7.2     | 27.6    | 3.8x  | same |
| sessionVwap              | 10.3     | 8.1     | 36.8    | 4.6x  | same |
| pivotPoints              | 26.3     | 17.4    | 105.6   | 6.1x  | same |

109 studies; ratio min 2.3x, median 6.1x, max 32.5x; bits differ: none
