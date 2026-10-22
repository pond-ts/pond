//! The moving-average family (pond-ts `catalog/moving-average.ts`): studies
//! built from moving averages, beyond `sma` / `ema` / `moving_average`.

use super::kernels::{self, Ema, ma_column, moving_average_values};
use super::{MaType, Study};
use crate::error::{PondError, Result};
use crate::par;
use crate::series::TimeSeries;

study_options! {
    /// Options for [`TimeSeries::macd`]: EMA spans in bars, fast 12, slow
    /// 26, signal 9; writes `macdLine`, `macdSignal` and `macdHist` (the
    /// prefix and `Line` / `Signal` / `Hist`).
    ///
    /// ```
    /// use pond_rs::financial::Macd;
    /// let standard = Macd::default();
    /// let fast = Macd::default().fast(5).slow(35).signal(5).prefix("m");
    /// ```
    Macd, prefix = "macd" {
        /// The fast EMA span in bars (default 12).
        fast: usize = 12,
        /// The slow EMA span in bars (default 26); must be longer than `fast`.
        slow: usize = 26,
        /// The signal EMA span in bars, taken over the MACD line (default 9).
        signal: usize = 9,
    }
}

/// How [`TimeSeries::price_oscillator`] expresses the spread between its
/// two averages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OscillatorMode {
    /// `100 * (fast - slow) / slow` (TA-Lib's PPO); a gap where the slow
    /// average is zero.
    Percent,
    /// `fast - slow` in the source's own units (TA-Lib's APO).
    Absolute,
}

study_options! {
    /// Options for [`TimeSeries::price_oscillator`]: fast 12 and slow 26
    /// bars of `Ema`, as a percent; writes `priceOsc`.
    PriceOscillator, output = "priceOsc" {
        /// The fast average's length in bars (default 12).
        fast: usize = 12,
        /// The slow average's length in bars (default 26); must be longer than `fast`.
        slow: usize = 26,
        /// The kind of moving average (default `Ema`).
        ma: MaType = MaType::Ema,
        /// Percent of the slow average (default) or absolute.
        mode: OscillatorMode = OscillatorMode::Percent,
    }
}

study_options! {
    /// Options for [`TimeSeries::moving_average_cross`]: fast 10 and slow
    /// 30 bars of `Sma`; writes `maCross`.
    MovingAverageCross, output = "maCross" {
        /// The fast average's length in bars (default 10).
        fast: usize = 10,
        /// The slow average's length in bars (default 30); must be longer than `fast`.
        slow: usize = 30,
        /// The kind of moving average (default `Sma`).
        ma: MaType = MaType::Sma,
    }
}

study_options! {
    /// Options for [`TimeSeries::guppy`]: twelve `Ema`s; writes `gmmaS3`,
    /// `gmmaS5`, `gmmaS8`, `gmmaS10`, `gmmaS12`, `gmmaS15`, `gmmaL30`,
    /// `gmmaL35`, `gmmaL40`, `gmmaL45`, `gmmaL50` and `gmmaL60`.
    Guppy, prefix = "gmma" {
        /// The kind of moving average (default `Ema`).
        ma: MaType = MaType::Ema,
    }
}

study_options! {
    /// Options for [`TimeSeries::rainbow`]: ten 2-bar `Sma`s, each over
    /// the one before; writes `rainbow1` to `rainbow10`.
    Rainbow, prefix = "rainbow" {
        /// Each average's length in bars (default 2).
        period: usize = 2,
        /// The kind of moving average (default `Sma`).
        ma: MaType = MaType::Sma,
    }
}

study_options! {
    /// Options for [`TimeSeries::rainbow_oscillator`]: the [`Rainbow`]
    /// stack (2-bar `Sma`) against a 10-bar range; writes `rbo`,
    /// `rboUpper` and `rboLower`.
    RainbowOscillator, prefix = "rbo" {
        /// Each average's length in bars (default 2).
        period: usize = 2,
        /// The bars the source's highest and lowest are taken over (default 10).
        lookback: usize = 10,
        /// The kind of moving average (default `Sma`).
        ma: MaType = MaType::Sma,
    }
}

study_options! {
    /// Options for [`TimeSeries::trix`]: 15-bar triple EMA, 9-bar signal;
    /// writes `trix` and `trixSignal`.
    Trix, prefix = "trix" {
        /// Each EMA's span in bars (default 15).
        period: usize = 15,
        /// The signal EMA's span in bars (default 9).
        signal: usize = 9,
    }
}

study_options! {
    /// Options for [`TimeSeries::schaff_trend_cycle`]: EMAs of 23 and 50
    /// bars, 10-bar cycle; writes `stc`.
    SchaffTrendCycle, output = "stc" {
        /// The fast EMA span in bars (default 23).
        fast: usize = 23,
        /// The slow EMA span in bars (default 50); must be longer than `fast`.
        slow: usize = 50,
        /// The bars each stochastic pass looks back (default 10).
        cycle: usize = 10,
    }
}

study_options! {
    /// Options for [`TimeSeries::coppock`]: percent changes over 14 and 11
    /// bars, a 10-bar weighted average of their sum; writes `coppock`.
    Coppock, output = "coppock" {
        /// The longer percent change, in bars (default 14).
        long: usize = 14,
        /// The shorter percent change, in bars (default 11).
        short: usize = 11,
        /// The weighted average's length in bars (default 10).
        wma_period: usize = 10,
    }
}

study_options! {
    /// Options for [`TimeSeries::kst`]: Pring's fixed terms and a 9-bar
    /// signal; writes `kst` and `kstSignal`.
    Kst, prefix = "kst" {
        /// The signal's simple-average length in bars (default 9).
        signal: usize = 9,
    }
}

study_options! {
    /// Options for [`TimeSeries::special_k`] (Pring's fixed terms); writes
    /// `specialK`.
    SpecialK, output = "specialK" {}
}

study_options! {
    /// Options for [`TimeSeries::price_momentum_oscillator`]
    /// (DecisionPoint's fixed 35 / 20 / 10); writes `pmo` and `pmoSignal`.
    PriceMomentumOscillator, prefix = "pmo" {}
}

/// Guppy's short and long EMA lengths.
const GUPPY: [(char, usize); 12] = [
    ('S', 3),
    ('S', 5),
    ('S', 8),
    ('S', 10),
    ('S', 12),
    ('S', 15),
    ('L', 30),
    ('L', 35),
    ('L', 40),
    ('L', 45),
    ('L', 50),
    ('L', 60),
];

const RAINBOW_DEPTH: usize = 10;

/// Rows per stretch when a row-by-row loop runs on several cores.
const ROWS: usize = 1 << 16;

/// KST's (percent change, simple-average length, weight) terms.
const KST: [(usize, usize, f64); 4] = [(10, 10, 1.0), (15, 10, 2.0), (20, 10, 3.0), (30, 15, 4.0)];

/// Special K's terms: KST's four, then intermediate and long groups.
const SPECIAL_K: [(usize, usize, f64); 12] = [
    (10, 10, 1.0),
    (15, 10, 2.0),
    (20, 10, 3.0),
    (30, 15, 4.0),
    (40, 50, 1.0),
    (65, 65, 2.0),
    (75, 75, 3.0),
    (100, 100, 4.0),
    (195, 130, 1.0),
    (265, 130, 2.0),
    (390, 130, 3.0),
    (530, 195, 4.0),
];

/// The scratch column pond-ts takes the MACD signal over; a series that
/// already has it is refused, as in pond-ts.
const MACD_SCRATCH: &str = "__macdLine__";

/// Moving-average studies, as pond-ts's `@pond-ts/financial` functions.
/// The family's shared rules: averages read from the column are
/// [`TimeSeries::moving_average`]'s (so `Sma` counts rows, as `sma` does);
/// an average of a derived line waits for `period` values and gives a gap
/// while its window holds one.
impl TimeSeries {
    /// MACD (pond-ts `macd`): the fast EMA minus the slow EMA (`Line`), an
    /// EMA of that line (`Signal`) and their difference (`Hist`). Each
    /// column starts as soon as it can: at the defaults the line at bar 25
    /// and the others at bar 33.
    ///
    /// ```
    /// use pond_rs::financial::Macd;
    /// use pond_rs::{Column, TimeSeries};
    /// let close: Vec<f64> = (0..40).map(|i| 100.0 + (i as f64 / 3.0).sin()).collect();
    /// let bars = TimeSeries::new("bars", (0..40).collect(), vec![Column::required("close", close)])?;
    /// let out = bars.macd(Macd::default())?;
    /// let line = out.column("macdLine")?.numbers()?;
    /// assert_eq!((line.get(24), line.get(25).is_some()), (None, true));
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn macd(&self, options: Macd) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::macd";
        positive(CALL, "fastPeriod", options.fast)?;
        positive(CALL, "slowPeriod", options.slow)?;
        positive(CALL, "signalPeriod", options.signal)?;
        shorter(CALL, "macd", options.fast, options.slow)?;
        let prefix = options.name();
        let names = [
            format!("{prefix}Line"),
            format!("{prefix}Signal"),
            format!("{prefix}Hist"),
        ];
        self.free_names(CALL, &names)?;
        self.free_names(CALL, &[MACD_SCRATCH])?;
        let values = self.study_source(CALL, options.source())?;
        // One pass: the three EMAs advance row by row together.
        let (mut fast, mut slow) = (Ema::period(options.fast), Ema::period(options.slow));
        let mut signal_ema = Ema::period(options.signal);
        let n = values.len();
        let (mut line, mut signal, mut hist) = (vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        for (i, &v) in values.iter().enumerate() {
            let l = fast.push(v) - slow.push(v);
            let s = signal_ema.push(l);
            (line[i], signal[i], hist[i]) = (l, s, l - s);
        }
        self.study_outputs(CALL, names.into_iter().zip([line, signal, hist]))
    }

    /// Price oscillator (pond-ts `priceOscillator`): the spread between a
    /// fast and a slow moving average, as a percent of the slow one or in
    /// the source's units ([`OscillatorMode`]). Starts where the slow
    /// average does.
    pub fn price_oscillator(&self, options: PriceOscillator) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::price_oscillator";
        positive(CALL, "fastPeriod", options.fast)?;
        positive(CALL, "slowPeriod", options.slow)?;
        shorter(CALL, "priceOscillator", options.fast, options.slow)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let (fast, slow) = par::join(
            || ma_column(&values, options.fast, options.ma),
            || ma_column(&values, options.slow, options.ma),
        );
        let out = fast
            .iter()
            .zip(&slow)
            .map(|(&f, &s)| match options.mode {
                OscillatorMode::Absolute => f - s,
                OscillatorMode::Percent if s == 0.0 => f64::NAN,
                OscillatorMode::Percent => (100.0 * (f - s)) / s,
            })
            .collect();
        self.study_outputs(CALL, [(output, out)])
    }

    /// Moving-average cross (pond-ts `movingAverageCross`), a signal
    /// column: `1` on the bar the fast average moves above the slow one,
    /// `-1` on the bar it moves below, `0` otherwise. Touching (equal) is
    /// not a cross and does not reset the side. A gap where either average
    /// is a gap; after a gap the first bar only notes the side (gap).
    pub fn moving_average_cross(&self, options: MovingAverageCross) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::moving_average_cross";
        positive(CALL, "fastPeriod", options.fast)?;
        positive(CALL, "slowPeriod", options.slow)?;
        shorter(CALL, "movingAverageCross", options.fast, options.slow)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let (fast, slow) = par::join(
            || ma_column(&values, options.fast, options.ma),
            || ma_column(&values, options.slow, options.ma),
        );
        let mut out = vec![f64::NAN; values.len()];
        let (mut run, mut last_sign) = (0usize, 0.0);
        for i in 0..out.len() {
            if fast[i].is_nan() || slow[i].is_nan() {
                run = 0;
                continue;
            }
            run += 1;
            let difference = fast[i] - slow[i];
            let sign = if difference > 0.0 {
                1.0
            } else if difference < 0.0 {
                -1.0
            } else {
                0.0
            };
            if run == 1 {
                last_sign = sign;
            } else if sign == 0.0 {
                out[i] = 0.0;
            } else if last_sign == 0.0 {
                last_sign = sign;
                out[i] = 0.0;
            } else if sign != last_sign {
                last_sign = sign;
                out[i] = sign;
            } else {
                out[i] = 0.0;
            }
        }
        self.study_outputs(CALL, [(output, out)])
    }

    /// Moving-average deviation (pond-ts `movingAverageDeviation`), output
    /// `maDev`: the value minus its moving average, in the source's units.
    /// pond-ts's defaults are `MaType::Sma` and a 20-bar period.
    pub fn moving_average_deviation(&self, kind: MaType, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::moving_average_deviation";
        let (values, output) = self.study_input(CALL, &study, "maDev")?;
        let ma = ma_column(&values, study.period, kind);
        let out = values.iter().zip(&ma).map(|(p, m)| p - m).collect();
        self.study_output(CALL, output, out)
    }

    /// Disparity index (pond-ts `disparityIndex`), output `disparity`: how
    /// far the value sits from its moving average, as a percent of the
    /// average; a gap where the average is zero. pond-ts's defaults are
    /// `MaType::Sma` and a 14-bar period.
    pub fn disparity_index(&self, kind: MaType, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::disparity_index";
        let (values, output) = self.study_input(CALL, &study, "disparity")?;
        let ma = ma_column(&values, study.period, kind);
        let out = values
            .iter()
            .zip(&ma)
            .map(|(&p, &m)| {
                if m == 0.0 {
                    f64::NAN
                } else {
                    (100.0 * (p - m)) / m
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Detrended price oscillator (pond-ts `detrendedPriceOscillator`),
    /// output `dpo`: the value minus the moving average from `period / 2 +
    /// 1` bars earlier. pond-ts's defaults are `MaType::Sma` and a 20-bar
    /// period.
    pub fn detrended_price_oscillator(&self, kind: MaType, study: Study) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::detrended_price_oscillator";
        let (values, output) = self.study_input(CALL, &study, "dpo")?;
        let ma = ma_column(&values, study.period, kind);
        let shift = study.period / 2 + 1;
        let out = (0..values.len())
            .map(|i| {
                if i < shift {
                    f64::NAN
                } else {
                    values[i] - ma[i - shift]
                }
            })
            .collect();
        self.study_output(CALL, output, out)
    }

    /// Guppy multiple moving average (pond-ts `guppy`): twelve moving
    /// averages of the column, short (3, 5, 8, 10, 12, 15) and long (30,
    /// 35, 40, 45, 50, 60), written `<prefix>S3` … `<prefix>L60`.
    pub fn guppy(&self, options: Guppy) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::guppy";
        let prefix = options.name();
        let names: Vec<String> = GUPPY
            .iter()
            .map(|(group, period)| format!("{prefix}{group}{period}"))
            .collect();
        self.free_names(CALL, &names)?;
        let values = self.study_source(CALL, options.source())?;
        let columns = par::map(&GUPPY, |&(_, period)| {
            ma_column(&values, period, options.ma)
        });
        self.study_outputs(CALL, names.into_iter().zip(columns))
    }

    /// Rainbow moving average (pond-ts `rainbow`): ten moving averages,
    /// each of the one before (the first of the column), written
    /// `<prefix>1` … `<prefix>10`. Each waits for whole windows of the one
    /// before, so the tenth starts `10 * (period - 1)` bars in.
    pub fn rainbow(&self, options: Rainbow) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::rainbow";
        positive(CALL, "period", options.period)?;
        let prefix = options.name();
        let names: Vec<String> = (1..=RAINBOW_DEPTH)
            .map(|stage| format!("{prefix}{stage}"))
            .collect();
        self.free_names(CALL, &names)?;
        let values = self.study_source(CALL, options.source())?;
        let stack = rainbow_stack(&values, options.period, options.ma);
        self.study_outputs(CALL, names.into_iter().zip(stack))
    }

    /// Rainbow oscillator (pond-ts `rainbowOscillator`, ChartIQ's
    /// definition): `100 * (value - mean of the rainbow) / range`
    /// (`<prefix>`), with `100 * (rainbow's max - min) / range` as
    /// `<prefix>Upper` and its negative as `<prefix>Lower`. The range is
    /// the column's highest minus lowest over `lookback` bars (gaps
    /// skipped); a gap for a flat range or an incomplete rainbow.
    pub fn rainbow_oscillator(&self, options: RainbowOscillator) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::rainbow_oscillator";
        positive(CALL, "period", options.period)?;
        positive(CALL, "lookback", options.lookback)?;
        let prefix = options.name();
        let names = [
            prefix.to_string(),
            format!("{prefix}Upper"),
            format!("{prefix}Lower"),
        ];
        self.free_names(CALL, &names)?;
        let price = self.study_source(CALL, options.source())?;
        let (stack, (highest, lowest)) = par::join(
            || rainbow_stack(&price, options.period, options.ma),
            || {
                par::join(
                    || kernels::rolling_extreme::<true>(&price, options.lookback),
                    || kernels::rolling_extreme::<false>(&price, options.lookback),
                )
            },
        );
        // Each row reads only its own row, so stretches of rows run on
        // separate cores.
        let n = price.len();
        let (mut line, mut upper) = (vec![0.0; n], vec![0.0; n]);
        par::fill_chunks(&mut line, &mut upper, ROWS, |start, line, upper| {
            for (k, (line, upper)) in line.iter_mut().zip(upper.iter_mut()).enumerate() {
                let i = start + k;
                let (mut sum, mut high, mut low) = (0.0, f64::NEG_INFINITY, f64::INFINITY);
                for stage in &stack {
                    let v = stage[i];
                    sum += v;
                    if v > high {
                        high = v;
                    }
                    if v < low {
                        low = v;
                    }
                }
                let range = highest[i] - lowest[i];
                (*line, *upper) = if sum.is_nan() || range == 0.0 {
                    (f64::NAN, f64::NAN)
                } else {
                    (
                        (100.0 * (price[i] - sum / RAINBOW_DEPTH as f64)) / range,
                        (100.0 * (high - low)) / range,
                    )
                };
            }
        });
        let mut lower = vec![0.0; n];
        par::fill_chunks(&mut lower, &mut [], ROWS, |start, lower, _| {
            for (l, u) in lower.iter_mut().zip(&upper[start..]) {
                *l = -u;
            }
        });
        self.study_outputs(CALL, names.into_iter().zip([line, upper, lower]))
    }

    /// TRIX (pond-ts `trix`): the one-bar percent change of a triple EMA
    /// (`<prefix>`), and an EMA of that (`<prefix>Signal`). Each EMA waits
    /// for the one before, so the line starts at bar `3 * (period - 1) +
    /// 1`.
    pub fn trix(&self, options: Trix) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::trix";
        positive(CALL, "period", options.period)?;
        positive(CALL, "signalPeriod", options.signal)?;
        let prefix = options.name();
        let names = [prefix.to_string(), format!("{prefix}Signal")];
        self.free_names(CALL, &names)?;
        let values = self.study_source(CALL, options.source())?;
        // One pass: each EMA reads the one before it, row by row; the line
        // is the one-bar percent change of the third.
        let mut e1 = Ema::period(options.period);
        let (mut e2, mut e3) = (e1.clone(), e1.clone());
        let mut signal_ema = Ema::period(options.signal);
        let n = values.len();
        let (mut line, mut signal) = (vec![0.0; n], vec![0.0; n]);
        let mut previous = f64::NAN;
        for (i, &v) in values.iter().enumerate() {
            let third = e3.push(e2.push(e1.push(v)));
            let l = if i < 1 {
                f64::NAN
            } else {
                kernels::percent_change(previous, third)
            };
            previous = third;
            (line[i], signal[i]) = (l, signal_ema.push(l));
        }
        self.study_outputs(CALL, names.into_iter().zip([line, signal]))
    }

    /// Schaff trend cycle (pond-ts `schaffTrendCycle`), 0 to 100: a
    /// stochastic over `cycle` bars of the MACD (fast EMA minus slow),
    /// half-smoothed, then the same again over that.
    pub fn schaff_trend_cycle(&self, options: SchaffTrendCycle) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::schaff_trend_cycle";
        positive(CALL, "fastPeriod", options.fast)?;
        positive(CALL, "slowPeriod", options.slow)?;
        positive(CALL, "cyclePeriod", options.cycle)?;
        shorter(CALL, "schaffTrendCycle", options.fast, options.slow)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let (mut fast, mut slow) = (Ema::period(options.fast), Ema::period(options.slow));
        let macd: Vec<f64> = values
            .iter()
            .map(|&v| fast.push(v) - slow.push(v))
            .collect();
        let pass = |values: &[f64]| {
            let (highest, lowest) = kernels::rolling_extremes_strict(values, options.cycle);
            kernels::stochastic_half_smooth(&highest, &lowest, values)
        };
        let stc = pass(&pass(&macd));
        self.study_outputs(CALL, [(output, stc)])
    }

    /// Coppock curve (pond-ts `coppock`): a weighted moving average over
    /// `wma_period` bars of the sum of the percent changes over `long` and `short`
    /// bars.
    pub fn coppock(&self, options: Coppock) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::coppock";
        positive(CALL, "longPeriod", options.long)?;
        positive(CALL, "shortPeriod", options.short)?;
        positive(CALL, "wmaPeriod", options.wma_period)?;
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let (long, short) = par::join(
            || kernels::percent_change_values(&values, options.long),
            || kernels::percent_change_values(&values, options.short),
        );
        let sum: Vec<f64> = long.iter().zip(&short).map(|(l, s)| l + s).collect();
        let curve = kernels::wma_values(&sum, options.wma_period);
        self.study_outputs(CALL, [(output, curve)])
    }

    /// Know Sure Thing (pond-ts `kst`, Pring): the weighted sum of four
    /// smoothed percent changes (10, 15, 20, 30 bars; smoothed 10, 10, 10,
    /// 15; weights 1 to 4) as `<prefix>`, and its simple average over
    /// `signal` bars as `<prefix>Signal`.
    pub fn kst(&self, options: Kst) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::kst";
        positive(CALL, "signalPeriod", options.signal)?;
        let prefix = options.name();
        let names = [prefix.to_string(), format!("{prefix}Signal")];
        self.free_names(CALL, &names)?;
        let values = self.study_source(CALL, options.source())?;
        let line = weighted_rates(&values, &KST);
        let signal = kernels::rolling_mean_values(&line, options.signal);
        self.study_outputs(CALL, names.into_iter().zip([line, signal]))
    }

    /// Special K (pond-ts `specialK`, Pring): KST's sum extended with
    /// intermediate and long terms, twelve in all (percent changes up to
    /// 530 bars), so it starts about 724 bars in.
    pub fn special_k(&self, options: SpecialK) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::special_k";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let values = self.study_source(CALL, options.source())?;
        let line = weighted_rates(&values, &SPECIAL_K);
        self.study_outputs(CALL, [(output, line)])
    }

    /// Price momentum oscillator (pond-ts `priceMomentumOscillator`,
    /// DecisionPoint): the one-bar percent change smoothed with alpha
    /// `2 / 35` (35 values), times 10, smoothed with alpha `2 / 20` (20
    /// values) as `<prefix>`; a 10-bar EMA of that as `<prefix>Signal`.
    pub fn price_momentum_oscillator(
        &self,
        options: PriceMomentumOscillator,
    ) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::price_momentum_oscillator";
        let prefix = options.name();
        let names = [prefix.to_string(), format!("{prefix}Signal")];
        self.free_names(CALL, &names)?;
        let values = self.study_source(CALL, options.source())?;
        // One pass: the one-bar percent change, smoothed, times 10,
        // smoothed again, and the signal EMA of that, row by row.
        let (mut first, mut second) = (Ema::new(2.0 / 35.0, 35), Ema::new(2.0 / 20.0, 20));
        let mut signal_ema = Ema::period(10);
        let n = values.len();
        let (mut line, mut signal) = (vec![0.0; n], vec![0.0; n]);
        for i in 0..n {
            let roc = kernels::percent_change_at(&values, 1, i);
            let l = second.push(10.0 * first.push(roc));
            (line[i], signal[i]) = (l, signal_ema.push(l));
        }
        self.study_outputs(CALL, names.into_iter().zip([line, signal]))
    }
}

/// The rainbow's ten averages, each of the one before.
fn rainbow_stack(values: &[f64], period: usize, kind: MaType) -> Vec<Vec<f64>> {
    let mut stack: Vec<Vec<f64>> = Vec::with_capacity(RAINBOW_DEPTH);
    for stage in 0..RAINBOW_DEPTH {
        let input = if stage == 0 {
            values
        } else {
            &stack[stage - 1]
        };
        let next = moving_average_values(input, period, kind);
        stack.push(next);
    }
    stack
}

/// KST and Special K: the sum of `weight * mean(percent change)` over the
/// terms, in order; a gap while any term is.
///
/// Stretches of rows run on separate cores. Each works through the terms
/// in order with small buffers of its own: the percent changes its
/// windows read, then their masked mean (the same bits as over the whole
/// column), added in. No term is held for the whole column.
fn weighted_rates(values: &[f64], terms: &[(usize, usize, f64)]) -> Vec<f64> {
    let longest = terms.iter().map(|t| t.1).max().unwrap_or(1);
    weighted_rates_chunked(values, terms, ROWS.max(longest * 8))
}

fn weighted_rates_chunked(values: &[f64], terms: &[(usize, usize, f64)], chunk: usize) -> Vec<f64> {
    let mut line = vec![0.0; values.len()];
    par::fill_chunks(&mut line, &mut [], chunk, |start, line, _| {
        let end = start + line.len();
        let mut smoothed = vec![0.0; line.len()];
        let mut changes = Vec::new();
        for &(change, smooth, weight) in terms {
            let from = kernels::mean_values_reads_from(start, smooth);
            changes.clear();
            changes.extend((from..end).map(|i| kernels::percent_change_at(values, change, i)));
            kernels::rolling_mean_values_into(&changes, smooth, start - from, &mut smoothed);
            for (l, s) in line.iter_mut().zip(&smoothed) {
                *l += weight * s;
            }
        }
    });
    line
}

pub(super) fn positive(call: &'static str, name: &str, period: usize) -> Result<()> {
    if period == 0 {
        return Err(PondError::InvalidData {
            call,
            message: format!("{name} must be a positive integer (bar count)"),
        });
    }
    Ok(())
}

pub(super) fn shorter(call: &'static str, study: &str, fast: usize, slow: usize) -> Result<()> {
    if fast >= slow {
        return Err(PondError::InvalidData {
            call,
            message: format!(
                "{study} fastPeriod ({fast}) must be shorter than slowPeriod ({slow})"
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cut into stretches of any size, KST's and Special K's sums come out
    /// with the bits of the plain route: each term's percent change and
    /// masked mean over the whole column, added in order.
    #[test]
    fn weighted_rates_in_stretches_match_whole_columns() {
        let mut x = 0x9E37_79B9_7F4A_7C15u64;
        let values: Vec<f64> = (0..6_000)
            .map(|i| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                match i {
                    _ if (600..640).contains(&i) => f64::NAN,
                    _ if i % 2_503 == 17 => f64::NAN,
                    350 => 0.0,
                    _ => 50.0 + (x % 10_007) as f64 / 97.0,
                }
            })
            .collect();
        for terms in [&KST[..], &SPECIAL_K[..]] {
            let mut want = vec![0.0; values.len()];
            for &(change, smooth, weight) in terms {
                let smoothed = kernels::rolling_mean_values(
                    &kernels::percent_change_values(&values, change),
                    smooth,
                );
                for (w, s) in want.iter_mut().zip(&smoothed) {
                    *w += weight * s;
                }
            }
            let finite = want.iter().filter(|v| v.is_finite()).count();
            assert!(finite > 1_000, "{} terms: {finite} values", terms.len());
            for chunk in [1, 2, 7, 64, 195, 999, 6_000] {
                let got = weighted_rates_chunked(&values, terms, chunk);
                let same = want
                    .iter()
                    .zip(&got)
                    .all(|(a, b)| a.to_bits() == b.to_bits() || (a.is_nan() && b.is_nan()));
                assert!(same, "{} terms, stretch {chunk}", terms.len());
            }
        }
    }
}
