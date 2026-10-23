//! The session studies (pond-ts `studies/session-vwap.ts`,
//! `studies/pivot-points.ts`, `studies/anchored-vwap.ts`): a VWAP that
//! restarts at every session open, the previous session's pivot levels,
//! and a VWAP from one anchor time on.

use std::borrow::Cow;

use super::calendar::{Session, Stamped, TradingCalendar, normalize_sessions, session_id_values};
use super::kernels::typical_price_values;
use crate::column::ColumnData;
use crate::error::{PondError, Result};
use crate::series::TimeSeries;

/// Where a session study finds its sessions (pond-ts's `sessions` /
/// `session` options): a calendar, a session list (checked and sorted as
/// [`normalize_sessions`] does), or the name of a session-id column already
/// on the series (what [`TradingCalendar::tag_sessions`] writes; each
/// value is one session, wherever it appears, and a gap is closed time).
///
/// `&calendar` and `&sessions[..]` convert into one;
/// [`SessionAnchor::column`] names a column.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionAnchor<'a> {
    Calendar(&'a TradingCalendar),
    Sessions(&'a [Session]),
    Column(String),
}

impl SessionAnchor<'_> {
    /// Sessions from a session-id column on the series.
    pub fn column(name: &str) -> Self {
        SessionAnchor::Column(name.to_string())
    }
}

impl<'a> From<&'a TradingCalendar> for SessionAnchor<'a> {
    fn from(calendar: &'a TradingCalendar) -> Self {
        SessionAnchor::Calendar(calendar)
    }
}

impl<'a> From<&'a [Session]> for SessionAnchor<'a> {
    fn from(sessions: &'a [Session]) -> Self {
        SessionAnchor::Sessions(sessions)
    }
}

impl<'a> From<&'a Vec<Session>> for SessionAnchor<'a> {
    fn from(sessions: &'a Vec<Session>) -> Self {
        SessionAnchor::Sessions(sessions)
    }
}

/// The settings both session studies share.
#[derive(Debug, Clone, PartialEq)]
struct Anchoring<'a> {
    anchor: SessionAnchor<'a>,
    stamped: Option<Stamped>,
}

/// Options for [`TimeSeries::session_vwap`]: where the sessions are, and
/// the columns it reads; writes `svwap`.
///
/// ```
/// use pond_rs::financial::{SessionAnchor, SessionRules, SessionVwap, Stamped, TradingCalendar};
/// let nyse = SessionRules::new("America/New_York", "09:30", "16:00");
/// let cal = TradingCalendar::from_rules(&nyse, "2024-01-08", "2024-01-12")?;
/// let by_calendar = SessionVwap::new(&cal).stamped(Stamped::Close);
/// let by_column = SessionVwap::new(SessionAnchor::column("session"));
/// # Ok::<(), pond_rs::PondError>(())
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct SessionVwap<'a> {
    anchoring: Anchoring<'a>,
    high: Option<String>,
    low: Option<String>,
    close: Option<String>,
    volume: Option<String>,
    output: Option<String>,
}

/// pond-ts's pivot methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PivotMethod {
    /// `P = (H + L + C) / 3`; `R1 = 2P - L`, `R2 = P + (H - L)`,
    /// `R3 = H + 2(P - L)`, and the supports mirrored.
    #[default]
    Standard,
    /// The standard pivot, levels at 0.382, 0.618 and 1 of the range.
    Fibonacci,
    /// `P = (H + L + 2C) / 4`, the standard ladder.
    Woodie,
    /// Four levels each side of the close, at 1.1 × the range / 12, 6, 4
    /// and 2.
    Camarilla,
}

/// Options for [`TimeSeries::pivot_points`]: where the sessions are, the
/// method, the columns it reads, and the prefix of the columns it writes
/// (`pp`: `ppPivot`, `ppR1`…`ppR3`, `ppS1`…`ppS3`, and `ppR4` / `ppS4` for
/// Camarilla).
///
/// ```
/// use pond_rs::financial::{PivotMethod, PivotPoints, SessionRules, TradingCalendar};
/// let nyse = SessionRules::new("America/New_York", "09:30", "16:00");
/// let cal = TradingCalendar::from_rules(&nyse, "2024-01-08", "2024-01-12")?;
/// let fib = PivotPoints::new(&cal).method(PivotMethod::Fibonacci).prefix("fib");
/// # Ok::<(), pond_rs::PondError>(())
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct PivotPoints<'a> {
    anchoring: Anchoring<'a>,
    method: PivotMethod,
    high: Option<String>,
    low: Option<String>,
    close: Option<String>,
    prefix: Option<String>,
}

macro_rules! session_setters {
    ($($src:ident),*) => {
        /// The bar-stamp convention for a calendar or session list:
        /// [`Stamped::Open`] (the default) or [`Stamped::Close`]. Given
        /// with a session-id column it is an error, as in pond-ts (pass
        /// it to `tag_sessions` instead).
        pub fn stamped(mut self, stamped: Stamped) -> Self {
            self.anchoring.stamped = Some(stamped);
            self
        }

        $(
            #[doc = concat!("Read the ", stringify!($src), " from this column instead of `", stringify!($src), "`.")]
            pub fn $src(mut self, name: &str) -> Self {
                self.$src = Some(name.to_string());
                self
            }
        )*
    };
}

impl<'a> SessionVwap<'a> {
    /// A session VWAP over the sessions `anchor` gives.
    pub fn new(anchor: impl Into<SessionAnchor<'a>>) -> Self {
        Self {
            anchoring: Anchoring {
                anchor: anchor.into(),
                stamped: None,
            },
            high: None,
            low: None,
            close: None,
            volume: None,
            output: None,
        }
    }

    session_setters!(high, low, close, volume);

    /// Name the output this instead of `svwap`.
    pub fn output(mut self, name: &str) -> Self {
        self.output = Some(name.to_string());
        self
    }
}

impl<'a> PivotPoints<'a> {
    /// Standard pivots over the sessions `anchor` gives.
    pub fn new(anchor: impl Into<SessionAnchor<'a>>) -> Self {
        Self {
            anchoring: Anchoring {
                anchor: anchor.into(),
                stamped: None,
            },
            method: PivotMethod::Standard,
            high: None,
            low: None,
            close: None,
            prefix: None,
        }
    }

    /// The pivot method (default [`PivotMethod::Standard`]).
    pub fn method(mut self, method: PivotMethod) -> Self {
        self.method = method;
        self
    }

    session_setters!(high, low, close);

    /// Start the output names with this instead of `pp`.
    pub fn prefix(mut self, prefix: &str) -> Self {
        self.prefix = Some(prefix.to_string());
        self
    }
}

study_options! {
    /// Options for [`TimeSeries::anchored_vwap`]: the anchor time (epoch
    /// milliseconds) and the columns it reads; writes `avwap`.
    AnchoredVwap(anchor: i64), output = "avwap", reads [high, low, close, volume] {}
}

/// The session studies.
impl TimeSeries {
    /// Session VWAP (pond-ts `sessionVwap`): the volume-weighted average of
    /// the typical price `(high + low + close) / 3` from each session's
    /// open, restarting at every open. A bar in closed time is a gap. The
    /// sums start at a session's first bar with both a price and a volume;
    /// a gap after that ends the session's line (the next open starts
    /// again); no volume yet is a gap.
    ///
    /// ```
    /// use pond_rs::financial::{Session, SessionVwap, TradingCalendar};
    /// use pond_rs::{Column, TimeSeries};
    /// let cal = TradingCalendar::from_sessions([
    ///     Session::new("2024-01-08", 0, 100),
    ///     Session::new("2024-01-09", 200, 300),
    /// ])?;
    /// let bars = TimeSeries::new("bars", vec![0, 50, 150, 200], vec![
    ///     Column::required("high", vec![10.0, 12.0, 11.0, 20.0]),
    ///     Column::required("low", vec![10.0, 12.0, 11.0, 20.0]),
    ///     Column::required("close", vec![10.0, 12.0, 11.0, 20.0]),
    ///     Column::required("volume", vec![1.0, 3.0, 5.0, 2.0]),
    /// ])?;
    /// let out = bars.session_vwap(SessionVwap::new(&cal))?;
    /// let v: Vec<_> = out.column("svwap")?.numbers()?.iter().collect();
    /// // (10·1 + 12·3) / 4; 150 is closed time; the second session restarts
    /// assert_eq!(v, [Some(10.0), Some(11.5), None, Some(20.0)]);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn session_vwap(&self, options: SessionVwap<'_>) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::session_vwap";
        let output = options.output.as_deref().unwrap_or("svwap").to_string();
        self.free_names(CALL, &[&output])?;
        let ids = self.session_ids(CALL, &options.anchoring, "sessionVwap")?;
        let [high, low, close, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close, &options.volume],
            ["high", "low", "close", "volume"],
        )?;
        let typical = typical_price_values(&high, &low, &close);
        let out = anchored_vwap_values(&typical, &volume, &ids);
        self.study_output(CALL, output, out)
    }

    /// Pivot points (pond-ts `pivotPoints`): from the previous session's
    /// highest high, lowest low and last close, a pivot and support and
    /// resistance levels, held on every bar of the session. "Previous" is
    /// the previous session with bars in this series. The first session
    /// with bars, and closed time, get gaps. Each of the three is taken
    /// over the cells present (a bar missing its high still gives its low);
    /// a session with none gives gaps.
    pub fn pivot_points(&self, options: PivotPoints<'_>) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::pivot_points";
        let prefix = options.prefix.as_deref().unwrap_or("pp");
        let camarilla = options.method == PivotMethod::Camarilla;
        let mut suffixes = vec!["Pivot", "R1", "R2", "R3"];
        if camarilla {
            suffixes.push("R4");
        }
        suffixes.extend(["S1", "S2", "S3"]);
        if camarilla {
            suffixes.push("S4");
        }
        let names: Vec<String> = suffixes.iter().map(|s| format!("{prefix}{s}")).collect();
        self.free_names(CALL, &names)?;
        let ids = self.session_ids(CALL, &options.anchoring, "pivotPoints")?;
        let [high, low, close] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close],
            ["high", "low", "close"],
        )?;
        let levels = pivot_level_values(options.method, &ids, &high, &low, &close);
        self.study_outputs(CALL, names.into_iter().zip(levels))
    }

    /// Anchored VWAP (pond-ts `anchoredVwap`): the volume-weighted average
    /// of the typical price from the first bar at or after `anchor` (epoch
    /// milliseconds, compared with each row's start) to the end of the
    /// series. Earlier bars are gaps. The sums start at the first bar with
    /// both a price and a volume; a gap after that ends the line; no
    /// volume yet is a gap.
    pub fn anchored_vwap(&self, options: AnchoredVwap) -> Result<TimeSeries> {
        const CALL: &str = "TimeSeries::anchored_vwap";
        let output = options.name().to_string();
        self.free_names(CALL, &[&output])?;
        let [high, low, close, volume] = self.price_columns(
            CALL,
            [&options.high, &options.low, &options.close, &options.volume],
            ["high", "low", "close", "volume"],
        )?;
        let typical = typical_price_values(&high, &low, &close);
        let anchors: Vec<f64> = self
            .key()
            .begin()
            .iter()
            .map(|&t| if t < options.anchor { f64::NAN } else { 0.0 })
            .collect();
        let out = anchored_vwap_values(&typical, &volume, &anchors);
        self.study_output(CALL, output, out)
    }

    /// pond-ts `resolveSessionIds`: one session id per row, `NaN` in
    /// closed time.
    fn session_ids(
        &self,
        call: &'static str,
        anchoring: &Anchoring<'_>,
        study: &str,
    ) -> Result<Cow<'_, [f64]>> {
        let err = |message: String| PondError::InvalidData { call, message };
        let stamped = anchoring.stamped;
        let times = self.key().begin();
        let list: Cow<'_, [Session]> = match &anchoring.anchor {
            SessionAnchor::Column(name) => {
                if stamped.is_some() {
                    return Err(err(format!(
                        "{study} 'stamped' applies to the 'sessions' door; a session-id column already carries its stamp convention — pass stamped to tagSessions instead"
                    )));
                }
                let Some(column) = self.columns().iter().find(|c| c.name() == name) else {
                    return Err(err(format!(
                        "session column '{name}' is not on the series; join the comparison series in first (align + joinMany) or pass a different 'session'"
                    )));
                };
                return match column.data() {
                    ColumnData::Number(_) => self.study_source(call, name),
                    other => Err(err(format!(
                        "session column '{name}' is a {} column, not a number column",
                        other.kind().as_str()
                    ))),
                };
            }
            SessionAnchor::Calendar(calendar) => match (times.first(), times.last()) {
                // Narrowed to the sessions the bars can reach; under close
                // stamping a bar at a session's close belongs to it, hence
                // the millisecond before the first bar.
                (Some(&first), Some(&last)) => Cow::Borrowed(
                    calendar.sessions_in_range(first.saturating_sub(1), last.saturating_add(1)),
                ),
                _ => Cow::Borrowed(&[]),
            },
            SessionAnchor::Sessions(list) => {
                Cow::Owned(normalize_sessions(list.iter().cloned()).map_err(|e| e.renamed(call))?)
            }
        };
        Ok(Cow::Owned(session_id_values(
            times,
            &list,
            stamped.unwrap_or_default(),
        )))
    }
}

/// pond-ts `anchoredVwapValues`: `Σ typical · volume / Σ volume` over the
/// bars of each anchor group up to each bar. A `NaN` id is no group (a
/// gap); a change of id restarts both sums. The sums start at the group's
/// first bar with both inputs; a gap after that makes the rest of the
/// group gaps; a zero total volume is a gap.
fn anchored_vwap_values(typical: &[f64], volume: &[f64], anchors: &[f64]) -> Vec<f64> {
    let mut current = f64::NAN;
    let mut started = false;
    let (mut flow, mut weight) = (0.0, 0.0);
    let mut out = vec![f64::NAN; typical.len()];
    for (i, slot) in out.iter_mut().enumerate() {
        let id = anchors[i];
        if id.is_nan() {
            continue;
        }
        if id != current {
            current = id;
            started = false;
            flow = 0.0;
            weight = 0.0;
        }
        let v = volume[i];
        let f = typical[i] * v;
        if !started {
            if f.is_nan() {
                continue;
            }
            started = true;
        }
        flow += f;
        weight += v;
        *slot = if weight == 0.0 {
            f64::NAN
        } else {
            flow / weight
        };
    }
    out
}

/// pond-ts `previousSessionHlcValues` then `pivotLevelValues`, in one
/// pass: for each bar, the levels from the previous session's (with bars)
/// highest high, lowest low and last close, each over the cells present;
/// `NaN` on the first session and in closed time. Output order: pivot,
/// resistances, then supports (Camarilla's fourth pair in its place in
/// each half). Fused so no intermediate high / low / close arrays are
/// written; the arithmetic per level is pond-ts's.
fn pivot_level_values(
    method: PivotMethod,
    ids: &[f64],
    high: &[f64],
    low: &[f64],
    close: &[f64],
) -> Vec<Vec<f64>> {
    let n = ids.len();
    let count = if method == PivotMethod::Camarilla {
        9
    } else {
        7
    };
    let mut levels: Vec<Vec<f64>> = (0..count).map(|_| Vec::with_capacity(n)).collect();
    let mut current = f64::NAN;
    let mut seen = false;
    let (mut cur_h, mut cur_l, mut cur_c) = (f64::NAN, f64::NAN, f64::NAN);
    let (mut prev_h, mut prev_l, mut prev_c) = (f64::NAN, f64::NAN, f64::NAN);
    for i in 0..n {
        let id = ids[i];
        let row = if id.is_nan() {
            [f64::NAN; 9]
        } else {
            if id != current {
                if seen {
                    (prev_h, prev_l, prev_c) = (cur_h, cur_l, cur_c);
                }
                current = id;
                seen = true;
                (cur_h, cur_l, cur_c) = (f64::NAN, f64::NAN, f64::NAN);
            }
            let h = high[i];
            if !h.is_nan() && (cur_h.is_nan() || h > cur_h) {
                cur_h = h;
            }
            let l = low[i];
            if !l.is_nan() && (cur_l.is_nan() || l < cur_l) {
                cur_l = l;
            }
            if !close[i].is_nan() {
                cur_c = close[i];
            }
            pivot_row(method, prev_h, prev_l, prev_c)
        };
        for (level, value) in levels.iter_mut().zip(row) {
            level.push(value);
        }
    }
    levels
}

/// pond-ts `pivotLevelValues` for one bar's previous-session high, low and
/// close (all `NaN` in, all `NaN` out).
fn pivot_row(method: PivotMethod, h: f64, l: f64, c: f64) -> [f64; 9] {
    let range = h - l;
    let p = if method == PivotMethod::Woodie {
        (h + l + 2.0 * c) / 4.0
    } else {
        (h + l + c) / 3.0
    };
    match method {
        PivotMethod::Fibonacci => [
            p,
            p + 0.382 * range,
            p + 0.618 * range,
            p + range,
            p - 0.382 * range,
            p - 0.618 * range,
            p - range,
            0.0,
            0.0,
        ],
        PivotMethod::Camarilla => [
            p,
            c + (range * 1.1) / 12.0,
            c + (range * 1.1) / 6.0,
            c + (range * 1.1) / 4.0,
            c + (range * 1.1) / 2.0,
            c - (range * 1.1) / 12.0,
            c - (range * 1.1) / 6.0,
            c - (range * 1.1) / 4.0,
            c - (range * 1.1) / 2.0,
        ],
        PivotMethod::Standard | PivotMethod::Woodie => [
            p,
            2.0 * p - l,
            p + range,
            h + 2.0 * (p - l),
            2.0 * p - h,
            p - range,
            l - 2.0 * (h - p),
            0.0,
            0.0,
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::series::Column;

    fn bars() -> TimeSeries {
        let n = 4;
        let col = |name: &str| Column::required(name, vec![1.0; n]);
        TimeSeries::new(
            "bars",
            vec![0, 10, 20, 30],
            vec![
                col("high"),
                col("low"),
                col("close"),
                col("volume"),
                Column::required("name", vec!["a"; n]),
                col("S4"),
            ],
        )
        .unwrap()
    }

    fn message(r: Result<TimeSeries>) -> String {
        r.unwrap_err().to_string()
    }

    /// A calendar is narrowed to the sessions the bars reach, but under
    /// close stamping a first bar exactly at a session's close still
    /// belongs to that session: same ids as the whole list, unnarrowed.
    #[test]
    fn calendar_keeps_the_session_closing_at_the_first_bar() {
        let list = [
            Session::new("2024-01-08", 0, 10),
            Session::new("2024-01-09", 20, 30),
        ];
        let cal = TradingCalendar::from_sessions(list.clone()).unwrap();
        let s = bars(); // bars at 0, 10, 20, 30
        let s = s.slice(1..); // first bar at 10, the first close
        for stamped in [Stamped::Open, Stamped::Close] {
            let by_cal = s
                .session_vwap(SessionVwap::new(&cal).stamped(stamped))
                .unwrap();
            let by_list = s
                .session_vwap(SessionVwap::new(&list[..]).stamped(stamped))
                .unwrap();
            let got: Vec<_> = by_cal
                .column("svwap")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .collect();
            let want: Vec<_> = by_list
                .column("svwap")
                .unwrap()
                .numbers()
                .unwrap()
                .iter()
                .collect();
            assert_eq!(got, want, "{stamped:?}");
        }
        let closed = s
            .session_vwap(SessionVwap::new(&cal).stamped(Stamped::Close))
            .unwrap();
        assert_eq!(
            closed.column("svwap").unwrap().numbers().unwrap().get(0),
            Some(1.0)
        );
    }

    /// Volumes that cancel out (+2 then -2) leave a zero total: a gap, as
    /// pond-ts's `weight === 0 ? NaN` (not ±infinity from `flow / 0`).
    #[test]
    fn zero_total_volume_is_a_gap() {
        let s = TimeSeries::new(
            "bars",
            vec![0, 10, 20],
            vec![
                Column::required("high", vec![1.0, 3.0, 5.0]),
                Column::required("low", vec![1.0, 3.0, 5.0]),
                Column::required("close", vec![1.0, 3.0, 5.0]),
                Column::required("volume", vec![2.0, -2.0, 1.0]),
            ],
        )
        .unwrap();
        let out = s.anchored_vwap(AnchoredVwap::new(0)).unwrap();
        let got: Vec<_> = out
            .column("avwap")
            .unwrap()
            .numbers()
            .unwrap()
            .iter()
            .collect();
        assert_eq!(got, [Some(1.0), None, Some(1.0)]);
    }

    /// pond-ts checks the output names, then the sessions (the stamp with
    /// a column, the column, the list), then reads the price columns.
    #[test]
    fn errors_come_in_pond_ts_order() {
        let s = bars();
        let bad_list = [Session::new("2024-01-08", 5, 5)];
        let none = SessionAnchor::column("nope");
        let m = message(s.session_vwap(SessionVwap::new(none.clone()).output("close")));
        assert!(m.contains("collides"), "{m}");
        let m = message(s.session_vwap(SessionVwap::new(none.clone()).stamped(Stamped::Open)));
        assert!(
            m.contains("'stamped' applies to the 'sessions' door"),
            "{m}"
        );
        let m = message(s.session_vwap(SessionVwap::new(none.clone()).high("nope2")));
        assert!(
            m.contains("session column 'nope' is not on the series"),
            "{m}"
        );
        let m = message(s.session_vwap(SessionVwap::new(SessionAnchor::column("name"))));
        assert!(m.contains("is a string column, not a number column"), "{m}");
        let m = message(s.session_vwap(SessionVwap::new(&bad_list[..]).high("nope2")));
        assert!(m.contains("close (5) must be > open (5)"), "{m}");
        let m = message(s.session_vwap(SessionVwap::new(&[][..]).high("nope2")));
        assert!(m.contains("nope2"), "{m}");
        // Pivots: every name, Camarilla's included, before the sessions.
        let m = message(
            s.pivot_points(
                PivotPoints::new(none.clone())
                    .method(PivotMethod::Camarilla)
                    .prefix(""),
            ),
        );
        assert!(m.contains("'S4' collides"), "{m}");
        let ok = s.pivot_points(PivotPoints::new(&[][..]).prefix(""));
        assert!(ok.is_ok(), "standard writes no S4");
        let m = message(s.pivot_points(PivotPoints::new(none).prefix("")));
        assert!(m.contains("session column 'nope'"), "{m}");
        // Anchored: the output, then the columns.
        let m = message(s.anchored_vwap(AnchoredVwap::new(0).output("close").high("nope2")));
        assert!(m.contains("collides"), "{m}");
        let m = message(s.anchored_vwap(AnchoredVwap::new(0).high("nope2")));
        assert!(m.contains("nope2"), "{m}");
    }
}
