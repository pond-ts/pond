//! Technical-analysis studies for price bars (pond-ts `@pond-ts/financial`):
//! moving averages and the studies built on them (MACD, price oscillator,
//! Guppy, rainbow, TRIX, Schaff, Coppock, KST, …), bands (Bollinger,
//! Keltner, STARC, ATR, Donchian, high-low, prime number, envelope),
//! momentum (RSI, stochastics, Williams %R, Chande momentum, momentum,
//! percent change, intraday momentum, awesome and ultimate oscillators,
//! CCI, Fisher transform, psychological line, pretty good and prime number
//! oscillators, QStick, relative vigor, centre of gravity, Chande forecast,
//! true strength), trend (directional movement, Aroon, vortex, vertical
//! horizontal filter, random walk index, SuperTrend, parabolic SAR, ATR
//! trailing stop, ZigZag, Ichimoku, Elder impulse and ray, trend
//! intensity, RAVI, swing index and its running total),
//! rolling statistics and the z-score so far, each a method on
//! [`TimeSeries`] that adds its number columns and keeps every row.
//!
//! Every study follows the same rules, as in pond-ts:
//!
//! - It reads one number column, `close` unless [`Study::column`] names
//!   another, and writes new optional columns named after the study
//!   (`sma`, `ema`, …) unless [`Study::output`] names it. A study with
//!   several settings takes an options struct named after it instead
//!   ([`Macd`], [`Trix`], …): `Default` is pond-ts's defaults, with a
//!   setter per setting, `column`, and `output` (or `prefix`, for a study
//!   that writes several columns: `macdLine`, `macdSignal`, `macdHist`).
//!   A study that reads price bars takes `high`, `low`, `close` (and
//!   `open`) setters instead of `column` ([`Keltner`], [`Donchian`], …).
//!   No output may take the name of a column the series already has.
//! - Periods count rows (bars), not time: a 20-bar average spans a weekend
//!   gap as easily as a minute.
//! - The first rows, before a full window, get gaps; the row count never
//!   changes. A gap in the source is skipped or carried, per study.
//!
//! Results match `@pond-ts/financial` bit for bit (checked against a
//! fixture pond-ts writes) and the pandas / TA-Lib oracle within 5e-10.
//!
//! ```
//! use pond_rs::financial::{MaType, Study};
//! use pond_rs::{Column, TimeSeries};
//! let bars = TimeSeries::new("bars", vec![0, 60_000, 120_000, 180_000],
//!     vec![Column::required("close", vec![10.0, 11.0, 12.0, 14.0])])?;
//! let out = bars
//!     .sma(Study::period(2))?
//!     .moving_average(MaType::Wma, Study::period(3).output("wma3"))?;
//! let sma: Vec<_> = out.column("sma")?.numbers()?.iter().collect();
//! assert_eq!(sma, [None, Some(10.5), Some(11.5), Some(13.0)]);
//! // weights 1, 2, 3 on 11, 12, 14: (11 + 24 + 42) / 6
//! assert_eq!(out.column("wma3")?.numbers()?.get(3), Some(77.0 / 6.0));
//! # Ok::<(), pond_rs::PondError>(())
//! ```

#[macro_use]
mod options;
mod averages;
mod bands;
mod bivariate;
mod kernels;
mod momentum;
mod regression;
mod statistics;
mod trend;
mod volatility;
mod volume;

pub use averages::{
    Coppock, Guppy, Kst, Macd, MovingAverageCross, OscillatorMode, PriceMomentumOscillator,
    PriceOscillator, Rainbow, RainbowOscillator, SchaffTrendCycle, SpecialK, Trix,
};
pub use bands::{
    AtrBands, Bollinger, BollingerBandwidth, BollingerPercentB, Donchian, Envelope, HighLowBands,
    Keltner, PrimeNumberBands, StarcBands,
};
pub use momentum::{
    AwesomeOscillator, CommodityChannelIndex, FisherTransform, IntradayMomentumIndex,
    PercentChange, PrettyGoodOscillator, PrimeNumberOscillator, Qstick, RelativeVigorIndex,
    Stochastic, StochasticMomentumIndex, StochasticRsi, TrueStrengthIndex, UltimateOscillator,
    WilliamsR,
};
pub use statistics::{Beta, Correlation, LinearRegression, PerformanceIndex, PriceRelative};
pub use trend::{
    AccumulativeSwingIndex, Aroon, AtrTrailingStop, DirectionalMovement, ElderImpulse, ElderRay,
    Ichimoku, ParabolicSar, RandomWalkIndex, Ravi, SuperTrend, SwingIndex, TrendIntensityIndex,
    Vortex, ZigZag,
};
pub use volatility::{
    Atr, ChaikinVolatility, ChoppinessIndex, GopalakrishnanRangeIndex, HistoricalVolatility,
    MassIndex, RelativeVolatilityIndex,
};
pub use volume::{
    AccumulationDistribution, ChaikinMoneyFlow, ChaikinOscillator, EaseOfMovement, ForceIndex,
    Klinger, MarketFacilitationIndex, MoneyFlowIndex, NegativeVolumeIndex, Obv,
    PositiveVolumeIndex, PriceVolumeTrend, ShinoharaIntensityRatio, TradeVolumeIndex,
    TwiggsMoneyFlow, VolumeOscillator, Vwap,
};

use std::borrow::Cow;

use crate::column::ColumnData;
use crate::error::{PondError, Result};
use crate::reducer::{Agg, Reducer};
use crate::rolling::Rolling;
use crate::series::{Column, TimeSeries};

/// The source column every study reads unless told otherwise.
pub const DEFAULT_SOURCE: &str = "close";

/// What a single-period study reads and writes: the `period` in bars, the
/// source column (default `close`) and the output column (default the
/// study's name).
///
/// ```
/// use pond_rs::financial::Study;
/// let plain = Study::period(20); // close → sma / ema / …
/// let custom = Study::period(14).column("open").output("open_sma14");
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct Study {
    period: usize,
    column: Option<String>,
    output: Option<String>,
}

impl Study {
    /// A study over `period` bars. It must be at least 1; the study returns
    /// an error otherwise.
    pub fn period(period: usize) -> Self {
        Self {
            period,
            column: None,
            output: None,
        }
    }

    /// Read this number column instead of `close`.
    pub fn column(mut self, name: &str) -> Self {
        self.column = Some(name.to_string());
        self
    }

    /// Write the result to a column with this name instead of the study's
    /// default.
    pub fn output(mut self, name: &str) -> Self {
        self.output = Some(name.to_string());
        self
    }

    fn source(&self) -> &str {
        self.column.as_deref().unwrap_or(DEFAULT_SOURCE)
    }

    fn output_or<'a>(&'a self, default: &'a str) -> &'a str {
        self.output.as_deref().unwrap_or(default)
    }
}

/// The kinds of moving average [`TimeSeries::moving_average`] computes, as
/// pond-ts's `type` option (and TA-Lib's MA types).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaType {
    /// Simple: the mean of the finite values in the window
    /// ([`TimeSeries::sma`]).
    Sma,
    /// Exponential, alpha `2 / (period + 1)`, starting from the first value
    /// ([`TimeSeries::ema`]).
    Ema,
    /// Weighted 1, 2, …, period, newest heaviest; a gap while the window
    /// holds a gap.
    Wma,
    /// Wilder's smoothing (the RSI / ATR average): the mean of the first
    /// `period` values, then `(previous * (period - 1) + value) / period`.
    Smma,
    /// Double exponential: `2 * ema - ema(ema)`.
    Dema,
    /// Triple exponential: `3 * ema - 3 * ema(ema) + ema(ema(ema))`.
    Tema,
    /// Triangular: a simple average of a simple average, the two lengths
    /// adding up to `period + 1`.
    Trima,
    /// Hull: `wma(2 * wma(period / 2) - wma(period), round(sqrt(period)))`.
    Hull,
    /// Kaufman's adaptive average (fast 2, slow 30).
    Kama,
    /// Zero-lag exponential: an EMA of `2 * value - value (period - 1) / 2
    /// bars back`.
    Zlema,
}

impl MaType {
    /// Every type, in pond-ts's order.
    pub const ALL: [MaType; 10] = [
        MaType::Sma,
        MaType::Ema,
        MaType::Wma,
        MaType::Smma,
        MaType::Dema,
        MaType::Tema,
        MaType::Trima,
        MaType::Hull,
        MaType::Kama,
        MaType::Zlema,
    ];

    /// pond-ts's name for the type (`"sma"`, `"ema"`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            MaType::Sma => "sma",
            MaType::Ema => "ema",
            MaType::Wma => "wma",
            MaType::Smma => "smma",
            MaType::Dema => "dema",
            MaType::Tema => "tema",
            MaType::Trima => "trima",
            MaType::Hull => "hull",
            MaType::Kama => "kama",
            MaType::Zlema => "zlema",
        }
    }

    /// The type pond-ts calls `name`, or an error listing them.
    pub fn parse(name: &str) -> Result<Self> {
        MaType::ALL
            .into_iter()
            .find(|t| t.as_str() == name)
            .ok_or_else(|| PondError::InvalidData {
                call: "MaType::parse",
                message: format!(
                    "unknown moving-average type '{name}'; expected one of {}",
                    MaType::ALL.map(MaType::as_str).join(", ")
                ),
            })
    }
}

/// Studies, as pond-ts's `@pond-ts/financial` functions. Each adds one
/// optional number column; see the [`financial`](crate::financial) module
/// for the rules they share.
impl TimeSeries {
    /// Simple moving average over `period` bars (pond-ts `sma`), output
    /// `sma`: the mean of the window's finite values. A row gets a value
    /// once `period` rows have passed, even when some of them are gaps; a
    /// window of only gaps gives a gap.
    ///
    /// Sums are kept relative to a recent value and restarted every
    /// `period` rows, so prices near 1e15 keep their low digits. O(N), and
    /// split across cores with the `parallel` feature: because the sums
    /// restart every `period` rows, each stretch gives the same bits as one
    /// sweep (as for `rolling_stdev`, `rolling_min` / `rolling_max` and the
    /// `Wma` / `Trima` / `Hull` moving averages).
    pub fn sma(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::sma";
        let (values, output) = self.study_input(CALL, &study, "sma")?;
        let (mean, _) = kernels::rolling_mean_sd(&values, study.period, false);
        self.study_output(CALL, output, mean)
    }

    /// Exponential moving average over `period` bars (pond-ts `ema`),
    /// output `ema`: alpha `2 / (period + 1)`, starting from the first
    /// value, with a gap until `period` values have been read. A gap row
    /// gets a gap and leaves the average as it was. The same numbers as
    /// [`TimeSeries::smooth`] with `Smooth::ema_span(period).min_samples(period)`.
    pub fn ema(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::ema";
        let (values, output) = self.study_input(CALL, &study, "ema")?;
        let ema = kernels::ema_values(&values, study.period);
        self.study_output(CALL, output, ema)
    }

    /// A moving average of the chosen [`MaType`] (pond-ts `movingAverage`
    /// with `type`), output `ma`. `Sma` and `Ema` give exactly
    /// [`TimeSeries::sma`] and [`TimeSeries::ema`]. The others need whole
    /// windows: `Wma`, `Trima` and `Hull` give a gap while the window holds
    /// a gap; `Dema`, `Tema` and `Zlema` skip gaps as `Ema` does (a gap
    /// row gets a gap; `Zlema` also where the value `(period - 1) / 2` rows
    /// back is a gap); `Smma` and `Kama` start after leading gaps but turn
    /// every value after a later gap into a gap (as in pond-ts). O(N) for every
    /// type.
    pub fn moving_average(&self, kind: MaType, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::moving_average";
        let (values, output) = self.study_input(CALL, &study, "ma")?;
        let ma = match kind {
            MaType::Sma => kernels::rolling_mean_sd(&values, study.period, false).0,
            other => kernels::moving_average_values(&values, study.period, other),
        };
        self.study_output(CALL, output, ma)
    }

    /// Rolling population standard deviation over `period` bars (pond-ts
    /// `rollingStdev`), output `stdev`; gaps as for [`TimeSeries::sma`].
    pub fn rolling_stdev(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::rolling_stdev";
        let (values, output) = self.study_input(CALL, &study, "stdev")?;
        let (_, sd) = kernels::rolling_mean_sd(&values, study.period, true);
        self.study_output(CALL, output, sd.expect("asked for the spread"))
    }

    /// Lowest value over `period` bars (pond-ts `rollingMin`), output
    /// `min`. A row gets a value once `period` rows have passed; gaps are
    /// skipped and a window of only gaps gives a gap.
    pub fn rolling_min(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::rolling_min";
        let (values, output) = self.study_input(CALL, &study, "min")?;
        let min = kernels::rolling_extreme::<false>(&values, study.period);
        self.study_output(CALL, output, min)
    }

    /// Highest value over `period` bars (pond-ts `rollingMax`), output
    /// `max`; gaps as for [`TimeSeries::rolling_min`].
    pub fn rolling_max(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::rolling_max";
        let (values, output) = self.study_input(CALL, &study, "max")?;
        let max = kernels::rolling_extreme::<true>(&values, study.period);
        self.study_output(CALL, output, max)
    }

    /// The `q`th percentile (0 to 100) over `period` bars, interpolated
    /// linearly between ranks (pond-ts `rollingPercentile`). The output
    /// is `p` followed by `q` as JavaScript prints it (`p90`, `p2.5`,
    /// `p1e-7`); gaps as for [`TimeSeries::rolling_min`].
    pub fn rolling_percentile(&self, q: f64, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::rolling_percentile";
        if !(0.0..=100.0).contains(&q) {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!("q must be in [0, 100], got {q}"),
            });
        }
        let name = format!("p{}", crate::grid::js_number(q));
        self.rolling_stat(CALL, study, Reducer::Percentile(q), &name)
    }

    /// Rolling z-score over `period` bars (pond-ts `zScore`), output
    /// `zscore`: how many standard deviations (population) each value sits
    /// from its window's mean. A gap where the value is a gap or the
    /// window has no spread.
    pub fn z_score(&self, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::z_score";
        let (values, output) = self.study_input(CALL, &study, "zscore")?;
        let (deviation, sd) = kernels::rolling_deviation_sd(&values, study.period);
        let z = deviation
            .iter()
            .zip(&sd)
            .map(|(&d, &s)| if s == 0.0 { f64::NAN } else { d / s })
            .collect();
        self.study_output(CALL, output, z)
    }

    /// The percentile goes through `rolling_rows`, as pond-ts sends it
    /// through core `rolling({ count: period }, …, { minSamples: period })`.
    fn rolling_stat(
        &self,
        call: &'static str,
        study: Study,
        reducer: Reducer,
        default: &str,
    ) -> Result<TimeSeries> {
        let (_, output) = self.study_input(call, &study, default)?;
        let rolled = self
            .rolling_rows(
                study.period,
                &[Agg::new("value", study.source(), reducer)],
                Rolling {
                    min_samples: study.period,
                    ..Rolling::default()
                },
            )
            .map_err(|e| e.renamed(call))?;
        let values = rolled.column("value")?.numbers()?.values().to_vec();
        self.study_output(call, output, values)
    }

    /// The checks every single-period study runs, and its source column's
    /// numbers with every gap as `NaN`.
    fn study_input(
        &self,
        call: &'static str,
        study: &Study,
        default: &str,
    ) -> Result<(Cow<'_, [f64]>, String)> {
        if study.period == 0 {
            return Err(PondError::InvalidData {
                call,
                message: "period must be a positive integer (bar count)".into(),
            });
        }
        let output = study.output_or(default).to_string();
        self.free_names(call, &[&output])?;
        Ok((self.study_source(call, study.source())?, output))
    }

    /// The price columns a study reads, each named by its option or its
    /// default.
    fn price_columns<const N: usize>(
        &self,
        call: &'static str,
        names: [&Option<String>; N],
        defaults: [&str; N],
    ) -> Result<[std::borrow::Cow<'_, [f64]>; N]> {
        let mut out = Vec::with_capacity(N);
        for (name, default) in names.into_iter().zip(defaults) {
            out.push(self.study_source(call, name.as_deref().unwrap_or(default))?);
        }
        Ok(out.try_into().unwrap_or_else(|_| unreachable!()))
    }

    /// Refuses a study output named like a column the series already has.
    fn free_names(&self, call: &'static str, names: &[impl AsRef<str>]) -> Result<()> {
        for name in names {
            let name = name.as_ref();
            if name == self.key_name() || self.columns().iter().any(|c| c.name() == name) {
                return Err(PondError::InvalidData {
                    call,
                    message: format!(
                        "study output column '{name}' collides with an existing column; pass a different 'output'"
                    ),
                });
            }
        }
        Ok(())
    }

    /// A study's source column's numbers with every gap as `NaN` (borrowed
    /// when they already are).
    fn study_source(&self, call: &'static str, column: &str) -> Result<Cow<'_, [f64]>> {
        let source = &self.columns()[self.column_index(call, column)?];
        match source.data() {
            ColumnData::Number(v) => {
                // Gaps must read as NaN; copy only if one is stored as an
                // infinity.
                let values = v.values();
                Ok(
                    if v.all_finite() || !values.iter().any(|x| x.is_infinite()) {
                        Cow::Borrowed(values)
                    } else {
                        Cow::Owned(kernels::gaps_as_nan(values))
                    },
                )
            }
            other => Err(PondError::WrongKind {
                call,
                column: source.name().to_string(),
                kind: other.kind().as_str(),
                reason: "studies read a number column".into(),
            }),
        }
    }

    fn study_output(
        &self,
        call: &'static str,
        output: String,
        values: Vec<f64>,
    ) -> Result<TimeSeries> {
        self.study_outputs(call, [(output, values)])
    }

    /// Adds the study's columns, in order, as optional number columns.
    fn study_outputs(
        &self,
        call: &'static str,
        columns: impl IntoIterator<Item = (String, Vec<f64>)>,
    ) -> Result<TimeSeries> {
        let mut columns = columns.into_iter();
        let (name, values) = columns.next().expect("a study writes a column");
        let mut out = self
            .with_column(Column::optional(name, values))
            .map_err(|e| e.renamed(call))?;
        for (name, values) in columns {
            out = out
                .with_column(Column::optional(name, values))
                .map_err(|e| e.renamed(call))?;
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A gap stored as an infinity (which `Column::optional` keeps as it
    /// is) gives the same result as one stored as NaN.
    #[test]
    fn infinite_gaps_read_as_gaps() {
        let make = |gap: f64| {
            let close = vec![1.0, 2.0, gap, 4.0, 5.0, 6.0, 7.0, 8.0];
            let time = (0..close.len() as i64).collect();
            TimeSeries::new("s", time, vec![Column::optional("close", close)]).unwrap()
        };
        for kind in MaType::ALL {
            let with = |gap| {
                make(gap)
                    .moving_average(kind, Study::period(2))
                    .unwrap()
                    .column("ma")
                    .unwrap()
                    .numbers()
                    .unwrap()
                    .iter()
                    .collect::<Vec<_>>()
            };
            assert_eq!(with(f64::INFINITY), with(f64::NAN), "{}", kind.as_str());
            assert_eq!(with(f64::NEG_INFINITY), with(f64::NAN), "{}", kind.as_str());
        }
    }

    /// A period far longer than the series gives all gaps: no huge
    /// allocation, no overflow.
    #[test]
    fn huge_periods_give_gaps() {
        let close: Vec<f64> = (0..10).map(f64::from).collect();
        let series = TimeSeries::new(
            "s",
            (0..10).collect(),
            vec![Column::required("close", close)],
        )
        .unwrap();
        for period in [11, 1 << 40, usize::MAX - 1, usize::MAX] {
            let study = || Study::period(period).output("out");
            let mut results = vec![
                series.sma(study()),
                series.ema(study()),
                series.rolling_stdev(study()),
                series.rolling_min(study()),
                series.rolling_max(study()),
                series.rolling_percentile(50.0, study()),
                series.z_score(study()),
            ];
            for kind in MaType::ALL {
                results.push(series.moving_average(kind, study()));
            }
            for kind in MaType::ALL {
                results.push(series.moving_average_deviation(kind, study()));
                results.push(series.disparity_index(kind, study()));
                results.push(series.detrended_price_oscillator(kind, study()));
                let (fast, slow) = (period - 1, period);
                results.push(
                    series.price_oscillator(
                        PriceOscillator::default().fast(fast).slow(slow).ma(kind),
                    ),
                );
                results.push(series.moving_average_cross(
                    MovingAverageCross::default().fast(fast).slow(slow).ma(kind),
                ));
                results.push(series.rainbow(Rainbow::default().period(period).ma(kind)));
                results.push(
                    series.rainbow_oscillator(
                        RainbowOscillator::default()
                            .period(period)
                            .lookback(period)
                            .ma(kind),
                    ),
                );
            }
            let (fast, slow) = (period - 1, period);
            results.push(series.macd(Macd::default().fast(fast).slow(slow).signal(period)));
            results.push(series.trix(Trix::default().period(period).signal(period)));
            results.push(
                series.schaff_trend_cycle(
                    SchaffTrendCycle::default()
                        .fast(fast)
                        .slow(slow)
                        .cycle(period),
                ),
            );
            results.push(
                series.coppock(
                    Coppock::default()
                        .long(period)
                        .short(period)
                        .wma_period(period),
                ),
            );
            for result in results {
                let out = result.unwrap();
                // Every column the study added is all gaps.
                for column in &out.columns()[1..] {
                    let values = column.numbers().unwrap();
                    assert!(
                        (0..10).all(|i| values.get(i).is_none()),
                        "period {period}: {}",
                        column.name()
                    );
                }
            }
        }
    }
}
