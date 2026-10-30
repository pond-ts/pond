//! `pond_rs.TradingCalendar`: exchange sessions for the session studies
//! (`session_vwap`, `pivot_points`) and for tagging bars with their session.

use std::sync::Arc;

use pond_rs::financial::{
    DateBound, Session, SessionRef, SessionRules, Stamped, TagSessions, TradingCalendar,
};
use pyo3::exceptions::PyTypeError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList, PyString, PyTuple};

use crate::convert::{err, time_ms, value_error};
use crate::series::PyTimeSeries;

/// A trading calendar: sessions in order, none overlapping, and lookups
/// over them. Build one from rules (`from_rules`: hours in a time zone,
/// weekdays, holidays, early closes, breaks) or from a list of sessions
/// (`from_sessions`). A session is a dict `{"date", "open", "close",
/// "breaks"}` with times in epoch milliseconds.
#[pyclass(name = "TradingCalendar", module = "pond_rs", frozen)]
pub struct PyTradingCalendar {
    pub inner: Arc<TradingCalendar>,
}

/// A date given as text (`"2024-01-08"`) or a `date`; `None` for anything
/// else.
fn date_text(obj: &Bound<'_, PyAny>) -> PyResult<Option<String>> {
    if let Ok(s) = obj.cast::<PyString>() {
        return Ok(Some(s.to_cow()?.into_owned()));
    }
    let datetime = obj.py().import("datetime")?;
    let is_date = obj.is_instance(&datetime.getattr("date")?)?;
    let is_datetime = obj.is_instance(&datetime.getattr("datetime")?)?;
    if is_date && !is_datetime {
        return Ok(Some(obj.call_method0("isoformat")?.extract()?));
    }
    Ok(None)
}

/// One end of a range of dates: a date (text or `date`) or a time
/// (read as its local date in the rules' zone).
fn date_bound(obj: &Bound<'_, PyAny>, what: &str) -> PyResult<DateBound> {
    match date_text(obj)? {
        Some(d) => Ok(DateBound::Date(d)),
        None => Ok(DateBound::At(time_ms(obj, what)?)),
    }
}

/// Two items from a `(start, end)` tuple or a `{"start", "end"}` dict.
fn pair<'py>(
    obj: &Bound<'py, PyAny>,
    keys: (&str, &str),
    what: &str,
) -> PyResult<(Bound<'py, PyAny>, Bound<'py, PyAny>)> {
    if let Ok(d) = obj.cast::<PyDict>() {
        let get = |k: &str| {
            d.get_item(k)?
                .ok_or_else(|| value_error(format!("{what}: missing '{k}'")))
        };
        return Ok((get(keys.0)?, get(keys.1)?));
    }
    if let Ok(t) = obj.cast::<PyTuple>()
        && t.len() == 2
    {
        return Ok((t.get_item(0)?, t.get_item(1)?));
    }
    Err(PyTypeError::new_err(format!(
        "{what}: expected ({0}, {1}) or {{\"{0}\": …, \"{1}\": …}}",
        keys.0, keys.1
    )))
}

/// A session from a dict `{"date", "open", "close", "breaks"?}`; times
/// may be anything `time_ms` reads, breaks `(start, end)` pairs or dicts.
pub fn session(obj: &Bound<'_, PyAny>) -> PyResult<Session> {
    const WHAT: &str = "session";
    let d = obj.cast::<PyDict>().map_err(|_| {
        PyTypeError::new_err("a session is a dict {\"date\", \"open\", \"close\", \"breaks\"?}")
    })?;
    let get = |k: &str| {
        d.get_item(k)?
            .ok_or_else(|| value_error(format!("{WHAT}: missing '{k}'")))
    };
    let date = date_text(&get("date")?)?
        .ok_or_else(|| PyTypeError::new_err("session 'date' is text (YYYY-MM-DD) or a date"))?;
    let mut s = Session::new(
        &date,
        time_ms(&get("open")?, "session open")?,
        time_ms(&get("close")?, "session close")?,
    );
    if let Some(breaks) = d.get_item("breaks")?
        && !breaks.is_none()
    {
        for b in breaks.try_iter()? {
            let (start, end) = pair(&b?, ("start", "end"), "session break")?;
            s = s.with_break(time_ms(&start, "break start")?, time_ms(&end, "break end")?);
        }
    }
    Ok(s)
}

/// A session as a dict, times in epoch milliseconds.
pub fn session_to_py<'py>(py: Python<'py>, s: &Session) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("date", &s.date)?;
    d.set_item("open", s.open)?;
    d.set_item("close", s.close)?;
    let breaks = PyList::empty(py);
    for b in &s.breaks {
        let item = PyDict::new(py);
        item.set_item("start", b.start)?;
        item.set_item("end", b.end)?;
        breaks.append(item)?;
    }
    d.set_item("breaks", breaks)?;
    Ok(d)
}

fn maybe_session<'py>(py: Python<'py>, s: Option<&Session>) -> PyResult<Bound<'py, PyAny>> {
    match s {
        Some(s) => Ok(session_to_py(py, s)?.into_any()),
        None => Ok(py.None().into_bound(py)),
    }
}

pub fn stamped(word: &str) -> PyResult<Stamped> {
    match word {
        "open" => Ok(Stamped::Open),
        "close" => Ok(Stamped::Close),
        other => Err(value_error(format!(
            "stamped must be \"open\" or \"close\"; got \"{other}\""
        ))),
    }
}

impl PyTradingCalendar {
    fn lookup<'py>(
        &self,
        py: Python<'py>,
        from: &Bound<'py, PyAny>,
        next: bool,
    ) -> PyResult<Bound<'py, PyAny>> {
        let date = date_text(from)?;
        let at = match &date {
            Some(_) => 0,
            None => time_ms(from, "from")?,
        };
        let r = match &date {
            Some(d) => SessionRef::Date(d),
            None => SessionRef::At(at),
        };
        let s = if next {
            self.inner.next_session(r)
        } else {
            self.inner.previous_session(r)
        };
        maybe_session(py, s)
    }
}

#[pymethods]
impl PyTradingCalendar {
    /// Sessions from `open` to `close` (local `"HH:MM"`) in `time_zone`,
    /// for every trading day from `start` to `end` (both included; a date
    /// as text or a `date`, or a time read as its local date). `weekmask`
    /// lists the trading weekdays (1 = Monday … 7 = Sunday; Monday to
    /// Friday by default); `breaks` are `(start, end)` local times inside
    /// each session (a lunch); `holidays` are dates with no session;
    /// `early_closes` maps a date to its earlier `"HH:MM"` close. Opens and
    /// closes follow the zone's clock changes.
    #[staticmethod]
    #[pyo3(signature = (time_zone, open, close, start, end, *, weekmask=None, breaks=None, holidays=None, early_closes=None))]
    fn from_rules(
        py: Python<'_>,
        time_zone: &str,
        open: &str,
        close: &str,
        start: &Bound<'_, PyAny>,
        end: &Bound<'_, PyAny>,
        weekmask: Option<Vec<u8>>,
        breaks: Option<&Bound<'_, PyAny>>,
        holidays: Option<&Bound<'_, PyAny>>,
        early_closes: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<Self> {
        let mut rules = SessionRules::new(time_zone, open, close);
        if let Some(days) = weekmask {
            rules = rules.weekmask(&days);
        }
        for b in breaks.into_iter().flat_map(|b| b.try_iter()).flatten() {
            let (s, e) = pair(&b?, ("start", "end"), "break")?;
            rules = rules.with_break(&s.extract::<String>()?, &e.extract::<String>()?);
        }
        for h in holidays.into_iter().flat_map(|h| h.try_iter()).flatten() {
            let h = h?;
            let d = date_text(&h)?
                .ok_or_else(|| PyTypeError::new_err("a holiday is text (YYYY-MM-DD) or a date"))?;
            rules = rules.holiday(&d);
        }
        for (date, at) in early_closes.into_iter().flat_map(|d| d.iter()) {
            let d = date_text(&date)?.ok_or_else(|| {
                PyTypeError::new_err("an early close's date is text (YYYY-MM-DD) or a date")
            })?;
            rules = rules.early_close(&d, &at.extract::<String>()?);
        }
        let (from, to) = (date_bound(start, "start")?, date_bound(end, "end")?);
        py.detach(|| TradingCalendar::from_rules(&rules, from, to))
            .map(|c| PyTradingCalendar { inner: Arc::new(c) })
            .map_err(err)
    }

    /// A calendar from a list of sessions (dicts `{"date", "open", "close",
    /// "breaks"?}`), checked and sorted by open. `time_zone` only notes the
    /// exchange's zone for display.
    #[staticmethod]
    #[pyo3(signature = (sessions, *, time_zone=None))]
    fn from_sessions(sessions: &Bound<'_, PyAny>, time_zone: Option<&str>) -> PyResult<Self> {
        let list = sessions
            .try_iter()?
            .map(|s| session(&s?))
            .collect::<PyResult<Vec<_>>>()?;
        let mut cal = TradingCalendar::from_sessions(list).map_err(err)?;
        if let Some(z) = time_zone {
            cal = cal.with_time_zone(z);
        }
        Ok(PyTradingCalendar {
            inner: Arc::new(cal),
        })
    }

    /// The exchange's zone (the rules' zone), if known.
    #[getter]
    fn time_zone(&self) -> Option<&str> {
        self.inner.time_zone()
    }

    /// Every session, in order, as dicts (times in epoch milliseconds).
    #[getter]
    fn sessions<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyList>> {
        let items = self
            .inner
            .sessions()
            .iter()
            .map(|s| session_to_py(py, s))
            .collect::<PyResult<Vec<_>>>()?;
        PyList::new(py, items)
    }

    fn __len__(&self) -> usize {
        self.inner.len()
    }

    fn __repr__(&self) -> String {
        let s = self.inner.sessions();
        match (s.first(), s.last()) {
            (Some(a), Some(b)) => format!(
                "TradingCalendar({} sessions, {} to {})",
                s.len(),
                a.date,
                b.date
            ),
            _ => "TradingCalendar(0 sessions)".into(),
        }
    }

    /// The session on `date` (text or a `date`), or `None` on a day off.
    fn session_on<'py>(
        &self,
        py: Python<'py>,
        date: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let d = date_text(date)?
            .ok_or_else(|| PyTypeError::new_err("expected a date (text YYYY-MM-DD or a date)"))?;
        maybe_session(py, self.inner.session_on(&d))
    }

    /// Whether `date` has a session.
    fn is_trading_day(&self, date: &Bound<'_, PyAny>) -> PyResult<bool> {
        let d = date_text(date)?
            .ok_or_else(|| PyTypeError::new_err("expected a date (text YYYY-MM-DD or a date)"))?;
        Ok(self.inner.is_trading_day(&d))
    }

    /// The session whose `[open, close)` holds the time (a break is still
    /// inside its session), or `None`.
    fn session_containing<'py>(
        &self,
        py: Python<'py>,
        time: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyAny>> {
        maybe_session(py, self.inner.session_containing(time_ms(time, "time")?))
    }

    /// Whether the market trades at the time: inside a session and not in
    /// one of its breaks.
    fn is_open(&self, time: &Bound<'_, PyAny>) -> PyResult<bool> {
        Ok(self.inner.is_open(time_ms(time, "time")?))
    }

    /// The sessions overlapping `[start, end)`, in order.
    fn sessions_in_range<'py>(
        &self,
        py: Python<'py>,
        start: &Bound<'py, PyAny>,
        end: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyList>> {
        let found = self
            .inner
            .sessions_in_range(time_ms(start, "start")?, time_ms(end, "end")?);
        let items = found
            .iter()
            .map(|s| session_to_py(py, s))
            .collect::<PyResult<Vec<_>>>()?;
        PyList::new(py, items)
    }

    /// The first session after `from_`: a date (text or `date`) gives the
    /// next trading day; a time gives the next session to open after it.
    fn next_session<'py>(
        &self,
        py: Python<'py>,
        from_: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyAny>> {
        self.lookup(py, from_, true)
    }

    /// The last session before `from_`: a date gives the trading day
    /// before; a time gives the last session to open before it (so a time
    /// inside a session gives that session).
    fn previous_session<'py>(
        &self,
        py: Python<'py>,
        from_: &Bound<'py, PyAny>,
    ) -> PyResult<Bound<'py, PyAny>> {
        self.lookup(py, from_, false)
    }

    /// `series` with a session-id column added: each row gets the open
    /// (epoch milliseconds) of the session its time falls in, or a gap in
    /// closed time. `stamped="close"` is for bars stamped with their end (a
    /// bar at the close belongs to the session). Use the column with
    /// `partition_by`, or as a session study's `session=`.
    #[pyo3(signature = (series, *, column="session", stamped="open"))]
    fn tag_sessions(
        &self,
        py: Python<'_>,
        series: &PyTimeSeries,
        column: &str,
        stamped: &str,
    ) -> PyResult<PyTimeSeries> {
        let options = TagSessions::default()
            .column(column)
            .stamped(self::stamped(stamped)?);
        let s = &*series.inner;
        py.detach(|| self.inner.tag_sessions(s, options))
            .map(PyTimeSeries::wrap)
            .map_err(err)
    }
}
