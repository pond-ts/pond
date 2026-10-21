//! Smoothing and band statistics: `smooth` (EMA, moving average, loess),
//! `baseline`, `outliers`, `scan` and `sample`, ported from pond-ts so
//! results match it bit for bit.
//!
//! On a series holding several entities (hosts, devices) each of these mixes
//! the entities' rows together, as in pond-ts.

use crate::column::ColumnData;
use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::reducer::Reducer;
use crate::rolling::{Alignment, Frame, Rolling, Span, check_magnitude, roll_column};
use crate::series::{Column, Key, TimeSeries};

/// How [`TimeSeries::smooth`] smooths a column, with its options. Build one
/// with [`Smooth::ema`], [`Smooth::ema_span`], [`Smooth::moving_average`]
/// or [`Smooth::loess`], then add options:
///
/// ```
/// # use pond_rs::{Alignment, Smooth};
/// let fast = Smooth::ema(0.2).min_samples(5).output("cpu_ema");
/// let local = Smooth::moving_average("5m").alignment(Alignment::Centered).skip_missing();
/// ```
///
/// An option that does not belong to the method (a `warmup` on a loess,
/// say) makes [`TimeSeries::smooth`] return an error.
#[derive(Debug, Clone, PartialEq)]
pub struct Smooth {
    method: Method,
    output: Option<String>,
    warmup: Option<usize>,
    min_samples: Option<usize>,
    alignment: Option<Alignment>,
    skip_missing: bool,
}

#[derive(Debug, Clone, PartialEq)]
enum Method {
    Ema(Rate),
    MovingAverage(String),
    Loess(f64),
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Rate {
    Alpha(f64),
    Span(f64),
}

impl Smooth {
    fn new(method: Method) -> Self {
        Smooth {
            method,
            output: None,
            warmup: None,
            min_samples: None,
            alignment: None,
            skip_missing: false,
        }
    }

    /// An exponential moving average with weight `alpha` in `(0, 1]` on the
    /// newest value: the first value is kept as it is, then each value `v`
    /// gives `alpha * v + (1 - alpha) * previous` (pond-ts `'ema'` with
    /// `alpha`). A gap gives a gap and leaves `previous` as it was.
    pub fn ema(alpha: f64) -> Self {
        Self::new(Method::Ema(Rate::Alpha(alpha)))
    }

    /// An exponential moving average over `span` bars, the finance
    /// convention: `alpha = 2 / (span + 1)`, with `span` at least 1
    /// (pond-ts `'ema'` with `span`).
    pub fn ema_span(span: f64) -> Self {
        Self::new(Method::Ema(Rate::Span(span)))
    }

    /// The mean of the values in a time window around each row (pond-ts
    /// `'movingAverage'`): trailing `(t - window, t]` by default. Rows
    /// sharing a time share a window. A row keyed by a time range or an
    /// interval sits at its middle, which may be half a millisecond.
    /// A window with no values gives a gap. A value of 2^960 or more is
    /// refused, as by [`TimeSeries::rolling`] (pond-ts gives a number).
    pub fn moving_average(window: &str) -> Self {
        Self::new(Method::MovingAverage(window.to_string()))
    }

    /// A local straight-line fit at each row (pond-ts `'loess'`): the
    /// `span` fraction (in `(0, 1]`) of the values nearest in time, at
    /// least 2, weighted by the tricube of their distance, as pond-ts fits
    /// it. Rows sit in time as for [`Smooth::moving_average`]. Each row
    /// costs time in proportion to the rows in its fit, so the whole call
    /// grows with the square of the row count.
    pub fn loess(span: f64) -> Self {
        Self::new(Method::Loess(span))
    }

    /// Write the result to a column with this name instead of replacing
    /// the source column. It must not be the key's name or another
    /// existing column; naming the source column replaces it.
    pub fn output(mut self, name: &str) -> Self {
        self.output = Some(name.to_string());
        self
    }

    /// EMA only: drop the first `rows` rows from the result, hiding the
    /// average's first steps (it still reads them). This changes the row
    /// count; [`Smooth::min_samples`] does not.
    pub fn warmup(mut self, rows: usize) -> Self {
        self.warmup = Some(rows);
        self
    }

    /// EMA only: a gap until this many values have been read; the rows stay.
    pub fn min_samples(mut self, values: usize) -> Self {
        self.min_samples = Some(values);
        self
    }

    /// Moving average only: where the window sits around each row
    /// ([`Alignment::Trailing`] by default).
    pub fn alignment(mut self, alignment: Alignment) -> Self {
        self.alignment = Some(alignment);
        self
    }

    /// Moving average and loess: keep a gap where the source has one
    /// (pond-ts `missing: 'skip'`). By default a gap gets the value fitted
    /// from the values around it (`missing: 'bridge'`).
    pub fn skip_missing(mut self) -> Self {
        self.skip_missing = true;
        self
    }

    /// An error naming the first option set that `method` does not take.
    fn check_options(&self) -> Result<()> {
        let (method, ema, moving, loess) = match self.method {
            Method::Ema(_) => ("ema", true, false, false),
            Method::MovingAverage(_) => ("moving_average", false, true, false),
            Method::Loess(_) => ("loess", false, false, true),
        };
        let misplaced = [
            ("warmup", self.warmup.is_some() && !ema),
            ("min_samples", self.min_samples.is_some() && !ema),
            ("alignment", self.alignment.is_some() && !moving),
            ("skip_missing", self.skip_missing && !(moving || loess)),
        ];
        match misplaced.iter().find(|(_, bad)| *bad) {
            None => Ok(()),
            Some((option, _)) => Err(invalid(format!("{method} does not take {option}"))),
        }
    }
}

const SMOOTH: &str = "smooth";

fn invalid(message: String) -> PondError {
    PondError::InvalidData {
        call: SMOOTH,
        message,
    }
}

/// Where each row sits in time for `smooth`: a time key's time, or the
/// middle of a time range / interval, as pond-ts computes it in f64
/// (`begin + (end - begin) / 2`, which may be half a millisecond).
fn anchors(key: &Key) -> Vec<f64> {
    let begin = key.begin();
    match key.end() {
        None => begin.iter().map(|&b| b as f64).collect(),
        Some(end) => begin
            .iter()
            .zip(end)
            .map(|(&b, &e)| b as f64 + (e - b) as f64 / 2.0)
            .collect(),
    }
}

/// Row indexes in anchor order (stable). Time-range and interval keys sort
/// by begin, so their middles can run backwards (a long range before a
/// short one); the moving-average sweep and the loess search need them in
/// order (pond-ts [PND-SMOOTHMID]). `None` when they already are.
fn anchor_order(anchors: &[f64]) -> Option<Vec<usize>> {
    if anchors.windows(2).all(|w| w[0] <= w[1]) {
        return None;
    }
    let mut order: Vec<usize> = (0..anchors.len()).collect();
    order.sort_by(|&a, &b| anchors[a].total_cmp(&anchors[b]));
    Some(order)
}

/// pond-ts `loessAt`: the local straight-line fit at `x` over the values
/// at sorted `anchors`. `None` when there are no values.
fn loess_at(x: f64, anchors: &[f64], values: &[f64], span: f64) -> Option<f64> {
    let n = anchors.len();
    match n {
        0 => return None,
        1 => return Some(values[0]),
        _ => {}
    }
    let neighbours = ((span * n as f64).ceil() as usize).clamp(2, n);
    // The run of `neighbours` anchors nearest `x`: the first start whose
    // window's far end is no further from `x` than its near end.
    let (mut low, mut high) = (0, n - neighbours);
    while low < high {
        let mid = (low + high) / 2;
        if x - anchors[mid] > anchors[mid + neighbours] - x {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    let (start, end) = (low, low + neighbours);
    let bandwidth = (x - anchors[start]).abs().max((anchors[end - 1] - x).abs());
    if bandwidth == 0.0 {
        // Every neighbour sits at `x`: the mean of the values there.
        let lo = anchors.partition_point(|&a| a < x);
        let hi = anchors.partition_point(|&a| a <= x);
        let sum = values[lo..hi].iter().fold(0.0, |acc, v| acc + v);
        return Some(sum / (hi - lo) as f64);
    }
    let (mut weighted, mut sw, mut swx, mut swy, mut swxx, mut swxy) =
        (0usize, 0.0, 0.0, 0.0, 0.0, 0.0);
    for i in start..end {
        // Centred on `x`, so the fit at `x` is the intercept.
        let dx = anchors[i] - x;
        let y = values[i];
        let ratio = dx.abs() / bandwidth;
        // Tricube, as products (pond-ts [PND-LOESSPOW]).
        let cube = ratio * ratio * ratio;
        let tail = 1.0 - cube;
        let w = if ratio >= 1.0 {
            0.0
        } else {
            tail * tail * tail
        };
        if w == 0.0 {
            continue;
        }
        weighted += 1;
        sw += w;
        swx += w * dx;
        swy += w * y;
        swxx += w * dx * dx;
        swxy += w * dx * y;
    }
    if weighted == 0 || sw == 0.0 {
        return None;
    }
    let denominator = sw * swxx - swx * swx;
    if denominator.abs() < f64::EPSILON {
        return Some(swy / sw);
    }
    Some((swy * swxx - swx * swxy) / denominator)
}

/// `values` with a gap wherever the source row is a gap.
fn skip_gaps(mut values: Vec<f64>, source: &[f64]) -> Vec<f64> {
    for (v, s) in values.iter_mut().zip(source) {
        if !s.is_finite() {
            *v = f64::NAN;
        }
    }
    values
}

/// A number result, with non-finite values as gaps.
fn finite_or_gap(v: f64) -> f64 {
    if v.is_finite() { v } else { f64::NAN }
}

/// How [`TimeSeries::sample`] picks rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sample {
    /// Every `n`th row: rows `n - 1`, `2n - 1`, … (pond-ts `{ stride }`).
    /// `n` must be at least 1.
    Stride(usize),
    /// `size` rows picked at random, every row equally likely (pond-ts
    /// `{ reservoir: { size } }`, one pass of Algorithm R), kept in their
    /// order in the series. The same `seed` picks the same rows; pond-ts
    /// has no seed. A series of at most `size` rows is kept whole. `size`
    /// must be at least 1.
    Reservoir { size: usize, seed: u64 },
}

/// SplitMix64: a small, fast generator, enough for picking rows.
struct SplitMix64(u64);

impl SplitMix64 {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A whole number in `0..bound`, from the top bits of a 128-bit
    /// product (Lemire's method, without its rejection step: the bias is
    /// below `bound / 2^64`).
    fn below(&mut self, bound: u64) -> u64 {
        ((self.next() as u128 * bound as u128) >> 64) as u64
    }
}

impl TimeSeries {
    /// The source column as numbers (gaps as NaN), or a wrong-kind error.
    pub(crate) fn number_source(
        &self,
        call: &'static str,
        column: &str,
    ) -> Result<(usize, &[f64])> {
        let c = self.column_index(call, column)?;
        let source = &self.columns()[c];
        match source.data() {
            ColumnData::Number(v) => Ok((c, v.values())),
            other => Err(PondError::WrongKind {
                call,
                column: source.name().to_string(),
                kind: other.kind().as_str(),
                reason: "needs a number column".to_string(),
            }),
        }
    }

    /// An error if `name` is the key's or a value column's name.
    fn check_new_name(&self, call: &'static str, name: &str) -> Result<()> {
        if name == self.key_name() || self.columns().iter().any(|c| c.name() == name) {
            return Err(PondError::DuplicateOutput {
                call,
                column: name.to_string(),
            });
        }
        Ok(())
    }

    /// This series with column `c` replaced by `values` (optional), or with
    /// `values` added as a new optional column `output`.
    fn put_numbers(&self, c: usize, output: Option<&str>, values: Vec<f64>) -> TimeSeries {
        let mut columns = self.columns().to_vec();
        match output {
            None => {
                columns[c] = Column::from_data(columns[c].name().to_string(), values, false);
            }
            Some(name) => columns.push(Column::from_data(name.to_string(), values, false)),
        }
        self.with_value_columns(columns)
    }

    /// Smooth one number column (pond-ts `smooth(column, method,
    /// options)`); see [`Smooth`] for the methods. The result replaces the
    /// column (now optional), or goes to a new optional column named by
    /// [`Smooth::output`]. Other columns and the key are kept.
    ///
    /// ```
    /// # use pond_rs::{Column, Smooth, TimeSeries};
    /// let s = TimeSeries::new("s", vec![0, 1000, 2000],
    ///     vec![Column::required("v", vec![2.0, 4.0, 8.0])])?;
    /// let e = s.smooth("v", &Smooth::ema(0.5).output("v_ema"))?;
    /// let got: Vec<_> = e.column("v_ema")?.numbers()?.iter().collect();
    /// assert_eq!(got, [Some(2.0), Some(3.0), Some(5.5)]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Errors, where pond-ts is silent: an unknown column (pond-ts passes
    /// the series through) and a column that is not numbers (pond-ts gives
    /// a gap in every row). A non-finite result (an overflow) is a gap.
    pub fn smooth(&self, column: &str, smooth: &Smooth) -> Result<TimeSeries> {
        smooth.check_options()?;
        let (c, values) = self.number_source(SMOOTH, column)?;
        let output = smooth.output.as_deref().filter(|&o| o != column);
        if let Some(name) = output {
            self.check_new_name(SMOOTH, name)?;
        }
        match &smooth.method {
            Method::Ema(rate) => {
                let alpha = match *rate {
                    Rate::Alpha(a) if a.is_finite() && a > 0.0 && a <= 1.0 => a,
                    Rate::Alpha(a) => {
                        return Err(invalid(format!("ema alpha must be in (0, 1], got {a}")));
                    }
                    Rate::Span(s) if s.is_finite() && s >= 1.0 => 2.0 / (s + 1.0),
                    Rate::Span(s) => {
                        return Err(invalid(format!(
                            "ema span must be a finite number >= 1, got {s}"
                        )));
                    }
                };
                let min_samples = smooth.min_samples.unwrap_or(0);
                let mut previous: Option<f64> = None;
                let mut seen = 0;
                let out: Vec<f64> = values
                    .iter()
                    .map(|&raw| {
                        if !raw.is_finite() {
                            return f64::NAN;
                        }
                        let v = previous.map_or(raw, |p| alpha * raw + (1.0 - alpha) * p);
                        previous = Some(v);
                        seen += 1;
                        if seen < min_samples {
                            f64::NAN
                        } else {
                            finite_or_gap(v)
                        }
                    })
                    .collect();
                let result = self.put_numbers(c, output, out);
                let warmup = smooth.warmup.unwrap_or(0).min(result.len());
                Ok(if warmup == 0 {
                    result
                } else {
                    result.row_range(warmup..result.len())
                })
            }
            Method::MovingAverage(window) => {
                let window_ms = parse_duration(window)?;
                check_magnitude(SMOOTH, &self.columns()[c], Reducer::Avg)?;
                let mut times = anchors(self.key());
                let order = anchor_order(&times);
                let sorted_values: Vec<f64>;
                let in_order = match &order {
                    None => values,
                    Some(order) => {
                        times = order.iter().map(|&i| times[i]).collect();
                        sorted_values = order.iter().map(|&i| values[i]).collect();
                        &sorted_values
                    }
                };
                let frame = Frame {
                    times: &times,
                    span: Span::Time(window_ms),
                    alignment: smooth.alignment.unwrap_or_default(),
                    min_samples: 0,
                };
                let mut out = roll_column(&frame, in_order, Reducer::Avg);
                if let Some(order) = order {
                    let mut by_row = vec![f64::NAN; out.len()];
                    for (k, &row) in order.iter().enumerate() {
                        by_row[row] = out[k];
                    }
                    out = by_row;
                }
                if smooth.skip_missing {
                    out = skip_gaps(out, values);
                }
                Ok(self.put_numbers(c, output, out))
            }
            Method::Loess(span) => {
                let span = *span;
                if !(span.is_finite() && span > 0.0 && span <= 1.0) {
                    return Err(invalid(format!("loess span must be in (0, 1], got {span}")));
                }
                let times = anchors(self.key());
                let rows: Vec<usize> = match anchor_order(&times) {
                    None => (0..times.len()).collect(),
                    Some(order) => order,
                };
                let (fit_at, fit_values): (Vec<f64>, Vec<f64>) = rows
                    .iter()
                    .filter(|&&i| values[i].is_finite())
                    .map(|&i| (times[i], values[i]))
                    .unzip();
                let rows: Vec<usize> = (0..times.len()).collect();
                // Each row's fit stands alone, so rows can run on any core.
                let out: Vec<f64> = crate::par::map(&rows, |&i| {
                    if smooth.skip_missing && !values[i].is_finite() {
                        return f64::NAN;
                    }
                    loess_at(times[i], &fit_at, &fit_values, span).map_or(f64::NAN, finite_or_gap)
                });
                Ok(self.put_numbers(c, output, out))
            }
        }
    }

    /// The rolling mean and standard deviation of `column` over a time
    /// window, with a band `sigma` deviations either side (pond-ts
    /// `baseline(column, { window, sigma, alignment, minSamples })`). Adds
    /// four optional columns, `avg`, `sd`, `upper` and `lower`, keeping the
    /// rest; see [`TimeSeries::baseline_named`] for other names.
    ///
    /// The window is as in [`TimeSeries::rolling_with`] (`sd` is the
    /// population standard deviation). A row whose window has no values,
    /// or fewer rows than `options.min_samples`, gets gaps in all four. A
    /// flat window (`sd` is 0) keeps `avg` and `sd` but gives gaps in
    /// `upper` and `lower`: a band of zero width would flag every other
    /// value.
    ///
    /// ```
    /// # use pond_rs::{Column, Rolling, TimeSeries};
    /// let s = TimeSeries::new("cpu", vec![0, 1000, 2000],
    ///     vec![Column::required("cpu", vec![1.0, 3.0, 5.0])])?;
    /// let b = s.baseline("cpu", "2s", 1.0, Rolling::default())?;
    /// assert_eq!(b.column("upper")?.numbers()?.get(2), Some(5.0)); // 4 + 1
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// `sigma` must be a positive finite number, and `column` a number
    /// column (pond-ts gives gaps for any other kind). A value of 2^480 or
    /// more is refused, as by a rolling standard deviation (pond-ts gives
    /// a number).
    pub fn baseline(
        &self,
        column: &str,
        window: &str,
        sigma: f64,
        options: Rolling,
    ) -> Result<TimeSeries> {
        self.baseline_named(
            column,
            window,
            sigma,
            options,
            ["avg", "sd", "upper", "lower"],
        )
    }

    /// [`TimeSeries::baseline`] with the four new columns named `names`, in
    /// the order avg, sd, upper, lower (pond-ts `names`). The names must be
    /// new and distinct: not the key's name, an existing column or each
    /// other (pond-ts checks only the existing columns).
    pub fn baseline_named(
        &self,
        column: &str,
        window: &str,
        sigma: f64,
        options: Rolling,
        names: [&str; 4],
    ) -> Result<TimeSeries> {
        const CALL: &str = "baseline";
        for (i, name) in names.iter().enumerate() {
            self.check_new_name(CALL, name)?;
            if names[..i].contains(name) {
                return Err(PondError::DuplicateOutput {
                    call: CALL,
                    column: name.to_string(),
                });
            }
        }
        let (avg, sd) = self.band(CALL, column, window, sigma, options)?;
        let (upper, lower): (Vec<f64>, Vec<f64>) = avg
            .iter()
            .zip(&sd)
            .map(|(&a, &s)| {
                // A gap in `sd` is NaN, which fails `> 0`.
                if s > 0.0 {
                    (a + sigma * s, a - sigma * s)
                } else {
                    (f64::NAN, f64::NAN)
                }
            })
            .unzip();
        let mut columns = self.columns().to_vec();
        for (name, values) in names.iter().zip([avg, sd, upper, lower]) {
            columns.push(Column::from_data(name.to_string(), values, false));
        }
        Ok(self.with_value_columns(columns))
    }

    /// The rows whose `column` value is more than `sigma` rolling standard
    /// deviations from the rolling mean (pond-ts `outliers(column, {
    /// window, sigma, alignment, minSamples })`): the rows
    /// [`TimeSeries::baseline`] puts outside its band. Rows with a gap, a
    /// flat window (`sd` is 0) or no baseline are never outliers. The
    /// result keeps every column. Errors as [`TimeSeries::baseline`].
    ///
    /// ```
    /// # use pond_rs::{Column, Rolling, TimeSeries};
    /// let s = TimeSeries::new("cpu", vec![0, 1000, 2000, 3000],
    ///     vec![Column::required("cpu", vec![1.0, 1.0, 1.0, 9.0])])?;
    /// let o = s.outliers("cpu", "4s", 1.0, Rolling::default())?;
    /// assert_eq!(o.key().begin(), &[3000]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn outliers(
        &self,
        column: &str,
        window: &str,
        sigma: f64,
        options: Rolling,
    ) -> Result<TimeSeries> {
        const CALL: &str = "outliers";
        let (avg, sd) = self.band(CALL, column, window, sigma, options)?;
        let (_, values) = self.number_source(CALL, column)?;
        let rows: Vec<usize> = (0..self.len())
            .filter(|&i| {
                let (v, a, s) = (values[i], avg[i], sd[i]);
                // Gaps are NaN: every comparison with one is false.
                s > 0.0 && (v - a).abs() > sigma * s
            })
            .collect();
        Ok(self.take_rows(&rows))
    }

    /// The rolling mean and standard deviation for `baseline` / `outliers`.
    fn band(
        &self,
        call: &'static str,
        column: &str,
        window: &str,
        sigma: f64,
        options: Rolling,
    ) -> Result<(Vec<f64>, Vec<f64>)> {
        if !(sigma.is_finite() && sigma > 0.0) {
            return Err(PondError::InvalidData {
                call,
                message: format!("sigma must be a positive finite number, got {sigma}"),
            });
        }
        let (c, values) = self.number_source(call, column)?;
        let source = &self.columns()[c];
        check_magnitude(call, source, Reducer::Avg)?;
        check_magnitude(call, source, Reducer::Stdev)?;
        let window_ms = parse_duration(window)?;
        // Range- and interval-keyed rows sit at their begin, as in rolling.
        let frame = Frame {
            times: self.key().begin(),
            span: Span::Time(window_ms),
            alignment: options.alignment,
            min_samples: options.min_samples,
        };
        let reducers = [Reducer::Avg, Reducer::Stdev];
        let mut both = crate::par::map(&reducers, |&r| roll_column(&frame, values, r));
        let sd = both.pop().expect("two reducers");
        let avg = both.pop().expect("two reducers");
        Ok((avg, sd))
    }

    /// A running fold of your own down one number column, replacing it
    /// (pond-ts `scan(column, step, init)`): `step(acc, value, row)`
    /// returns the next accumulator and this row's output. The accumulator
    /// can be any type, so the running state can be more than the output
    /// (a reference level and a total, say). See [`TimeSeries::scan_to`]
    /// to keep the source column.
    ///
    /// A gap does not call `step`: the accumulator is kept and the row
    /// repeats the last output (a gap before the first value). A
    /// non-finite output is a gap. The column becomes optional.
    ///
    /// ```
    /// # use pond_rs::{Column, TimeSeries};
    /// // Total climb, counting only rises from the last low point.
    /// let s = TimeSeries::new("track", vec![0, 1, 2, 3],
    ///     vec![Column::required("ele", vec![10.0, 12.0, 11.0, 14.0])])?;
    /// let gain = s.scan("ele", (f64::INFINITY, 0.0), |(low, total), v, _row| {
    ///     let total = if v > low { total + v - low } else { total };
    ///     ((v, total), total)
    /// })?;
    /// let got: Vec<_> = gain.column("ele")?.numbers()?.iter().collect();
    /// assert_eq!(got, [Some(0.0), Some(2.0), Some(2.0), Some(5.0)]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    ///
    /// Errors: an unknown column, or one that is not numbers.
    pub fn scan<A>(
        &self,
        column: &str,
        init: A,
        step: impl FnMut(A, f64, usize) -> (A, f64),
    ) -> Result<TimeSeries> {
        self.scan_into(column, None, init, step)
    }

    /// [`TimeSeries::scan`], writing the outputs to a new optional column
    /// `output` (pond-ts `{ output }`) and keeping the source. `output`
    /// must be a new name.
    pub fn scan_to<A>(
        &self,
        column: &str,
        output: &str,
        init: A,
        step: impl FnMut(A, f64, usize) -> (A, f64),
    ) -> Result<TimeSeries> {
        self.scan_into(column, Some(output), init, step)
    }

    fn scan_into<A>(
        &self,
        column: &str,
        output: Option<&str>,
        init: A,
        mut step: impl FnMut(A, f64, usize) -> (A, f64),
    ) -> Result<TimeSeries> {
        const CALL: &str = "scan";
        let (c, values) = self.number_source(CALL, column)?;
        if let Some(name) = output {
            self.check_new_name(CALL, name)?;
        }
        let mut acc = Some(init);
        let mut last = f64::NAN;
        let out: Vec<f64> = values
            .iter()
            .enumerate()
            .map(|(i, &v)| {
                if v.is_finite() {
                    let (next, o) = step(acc.take().expect("accumulator is put back"), v, i);
                    acc = Some(next);
                    last = finite_or_gap(o);
                }
                last
            })
            .collect();
        Ok(self.put_numbers(c, output, out))
    }

    /// Some of the rows, in order (pond-ts `sample`); see [`Sample`].
    ///
    /// ```
    /// # use pond_rs::{Column, Sample, TimeSeries};
    /// let s = TimeSeries::new("s", (0..10).map(|i| i * 1000).collect(),
    ///     vec![Column::required("v", (0..10).map(f64::from).collect::<Vec<_>>())])?;
    /// assert_eq!(s.sample(Sample::Stride(4))?.key().begin(), &[3000, 7000]);
    /// assert_eq!(s.sample(Sample::Reservoir { size: 3, seed: 7 })?.len(), 3);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn sample(&self, how: Sample) -> Result<TimeSeries> {
        const CALL: &str = "sample";
        let n = self.len();
        let rows: Vec<usize> = match how {
            Sample::Stride(0) | Sample::Reservoir { size: 0, .. } => {
                return Err(PondError::InvalidData {
                    call: CALL,
                    message: "needs a stride or size of at least 1".into(),
                });
            }
            Sample::Stride(stride) => (stride - 1..n).step_by(stride).collect(),
            Sample::Reservoir { size, .. } if n <= size => return Ok(self.clone()),
            Sample::Reservoir { size, seed } => {
                let mut rng = SplitMix64(seed);
                let mut picked: Vec<usize> = (0..size).collect();
                for i in size..n {
                    let j = rng.below(i as u64 + 1) as usize;
                    if j < size {
                        picked[j] = i;
                    }
                }
                picked.sort_unstable();
                picked
            }
        };
        Ok(self.take_rows(&rows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(times: Vec<i64>, values: Vec<Option<f64>>) -> TimeSeries {
        TimeSeries::new("s", times, vec![Column::optional("v", values)]).unwrap()
    }

    fn numbers(s: &TimeSeries, name: &str) -> Vec<Option<f64>> {
        s.column(name).unwrap().numbers().unwrap().iter().collect()
    }

    #[test]
    fn options_must_fit_the_method() {
        let s = series(vec![0, 1], vec![Some(1.0), Some(2.0)]);
        for bad in [
            Smooth::loess(0.5).warmup(1),
            Smooth::moving_average("1s").min_samples(1),
            Smooth::ema(0.5).alignment(Alignment::Leading),
            Smooth::ema(0.5).skip_missing(),
        ] {
            let e = s.smooth("v", &bad).unwrap_err();
            assert!(e.to_string().contains("does not take"), "{e}");
        }
    }

    #[test]
    fn loess_fits_a_line_exactly() {
        // On points on a straight line every local fit is that line.
        let t: Vec<i64> = (0..20).map(|i| i * 1000).collect();
        let v: Vec<Option<f64>> = (0..20).map(|i| Some(3.0 * i as f64 - 7.0)).collect();
        let s = series(t, v.clone());
        let fit = s.smooth("v", &Smooth::loess(0.4)).unwrap();
        for (got, want) in numbers(&fit, "v").iter().zip(&v) {
            assert!((got.unwrap() - want.unwrap()).abs() < 1e-9);
        }
    }

    #[test]
    fn scan_carries_over_gaps_and_drops_non_finite() {
        let s = series(
            vec![0, 1, 2, 3, 4],
            vec![None, Some(1.0), None, Some(0.0), Some(2.0)],
        );
        // Output 1 / value: infinity at the zero, then back.
        let r = s
            .scan_to("v", "inv", 0, |n, v, _| (n + 1, 1.0 / v))
            .unwrap();
        assert_eq!(
            numbers(&r, "inv"),
            [None, Some(1.0), Some(1.0), None, Some(0.5)]
        );
        assert!(!r.column("inv").unwrap().is_required());
    }

    #[test]
    fn reservoir_picks_rows_evenly() {
        // Each of 10 rows should be picked in about 3/10 of the runs.
        let s = series((0..10).collect(), (0..10).map(|i| Some(i as f64)).collect());
        let mut counts = [0usize; 10];
        let runs = 20_000;
        for seed in 0..runs {
            let picked = s.sample(Sample::Reservoir { size: 3, seed }).unwrap();
            assert_eq!(picked.len(), 3);
            let begin = picked.key().begin();
            assert!(begin.windows(2).all(|w| w[0] < w[1]), "in order");
            for &t in begin {
                counts[t as usize] += 1;
            }
        }
        let expected = runs as f64 * 0.3;
        for c in counts {
            // Five standard deviations: sqrt(20000 * 0.3 * 0.7) is about 65.
            assert!((c as f64 - expected).abs() < 5.0 * 65.0, "{counts:?}");
        }
        // The same seed picks the same rows.
        let a = s.sample(Sample::Reservoir { size: 4, seed: 9 }).unwrap();
        let b = s.sample(Sample::Reservoir { size: 4, seed: 9 }).unwrap();
        assert_eq!(a.key().begin(), b.key().begin());
    }
}
