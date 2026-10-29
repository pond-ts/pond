//! The views beyond `filter` (pond-ts `LiveSeries` / `LiveView` methods):
//! `map`, `select`, `sample`, `window`, `diff` / `rate` / `pct_change`,
//! `fill` and `cumulative`. Each one's step is a port of pond-ts's
//! (`live-view.ts`), run one source event at a time.
//!
//! Where pond-ts takes a bad argument silently, pond-rs refuses it when the
//! view is built, as batch pond-rs does: unknown columns, a column of the
//! wrong kind, a fill value of the wrong kind.

use std::sync::Arc;

use crate::column::Value;
use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::reducer::Reducer;
use crate::rowwise::{Fill, FirstRow};
use crate::series::{ColumnDef, ColumnKind};
use crate::smooth::Sample;

use super::event::{LiveEvent, LiveSchema};
use super::sealed::State;
use super::view::{Kept, LiveView, Step, Window};
use super::{LiveSeries, Node};

#[derive(Clone, Copy)]
enum Delta {
    Diff,
    Rate,
    Pct,
}

/// One column's fill.
#[derive(Clone)]
enum FillWith {
    Hold,
    Value(Value),
}

impl LiveSeries {
    /// Build a view on slot `source` and subscribe it.
    pub(super) fn add_view(
        &mut self,
        source: usize,
        schema: Arc<LiveSchema>,
        step: Step,
        window: Option<Window>,
        window_ms: Option<i64>,
    ) -> Node<LiveView> {
        let view = LiveView::new(
            self.name_of(source),
            schema,
            step,
            self.held(source),
            window,
            window_ms,
        );
        self.add_node(source, State::View(view))
    }

    /// The time window `filter`, `map` and `select` keep from a view.
    pub(super) fn window_ms_of(&self, source: usize) -> Option<i64> {
        match &self.slots[source].state {
            State::View(v) => v.window_ms,
            _ => None,
        }
    }

    /// The index of each named value column of `schema`, which must be
    /// there, once each, and of `kind` when given.
    fn columns_of(
        call: &'static str,
        schema: &LiveSchema,
        names: &[&str],
        kind: Option<ColumnKind>,
    ) -> Result<Vec<usize>> {
        let mut out = Vec::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            let c = schema
                .value_index(name)
                .ok_or_else(|| PondError::UnknownColumn {
                    call,
                    column: name.to_string(),
                    available: schema.values().iter().map(|c| c.name.clone()).collect(),
                })?;
            if names[..i].contains(name) {
                return Err(PondError::InvalidData {
                    call,
                    message: format!("column '{name}' is named twice"),
                });
            }
            let have = schema.values()[c].kind;
            if let Some(want) = kind
                && have != want
            {
                return Err(PondError::WrongKind {
                    call,
                    column: name.to_string(),
                    kind: have.as_str(),
                    reason: format!("needs a {} column", want.as_str()),
                });
            }
            out.push(c);
        }
        Ok(out)
    }

    /// `schema` with the value columns at `targets` made optional numbers.
    fn numbers_at(schema: &LiveSchema, targets: &[usize]) -> Arc<LiveSchema> {
        let mut columns = schema.columns.clone();
        for &t in targets {
            columns[t + 1] = ColumnDef::optional(&columns[t + 1].name, ColumnKind::Number);
        }
        LiveSchema::new(columns)
    }

    /// Each event of `from` as `f` rewrites its values (pond-ts `map`): `f`
    /// gets the event and returns one cell per value column, in schema
    /// order, `None` for a gap. The key is kept: pond-rs has no re-keying
    /// map. A number that is not finite is stored as a gap, as pond-ts
    /// does.
    ///
    /// # Panics
    ///
    /// During a push, if `f` returns the wrong number of cells or a cell
    /// of the wrong kind for its column.
    pub fn map<F>(&mut self, from: impl Into<super::NodeId>, mut f: F) -> Result<Node<LiveView>>
    where
        F: FnMut(&LiveEvent) -> Vec<Option<Value>> + Send + 'static,
    {
        let source = self.source_of("LiveSeries::map", from.into())?;
        let schema = self.schema_of(source);
        let out = Arc::clone(&schema);
        let step: Step = Box::new(move |e: &LiveEvent| {
            let mut values = f(e);
            let defs = out.values();
            assert_eq!(
                values.len(),
                defs.len(),
                "LiveSeries::map: the closure must return one cell per value column"
            );
            for (cell, def) in values.iter_mut().zip(defs) {
                let fits = match (cell.as_ref(), def.kind) {
                    (None, _) => true,
                    (Some(Value::Number(x)), ColumnKind::Number) => {
                        if !x.is_finite() {
                            *cell = None;
                        }
                        true
                    }
                    (Some(Value::String(_)), ColumnKind::String)
                    | (Some(Value::Boolean(_)), ColumnKind::Boolean)
                    | (Some(Value::Array(_)), ColumnKind::Array) => true,
                    _ => false,
                };
                assert!(
                    fits,
                    "LiveSeries::map: column '{}' is {}, the closure returned {:?}",
                    def.name,
                    def.kind.as_str(),
                    cell
                );
            }
            Some(Kept::New(values))
        });
        Ok(self.add_view(source, schema, step, None, self.window_ms_of(source)))
    }

    /// The events of `from` with only the named value columns, kept in
    /// schema order (pond-ts `select`). Unknown names are an error.
    pub fn select(
        &mut self,
        from: impl Into<super::NodeId>,
        names: &[&str],
    ) -> Result<Node<LiveView>> {
        const CALL: &str = "LiveSeries::select";
        let source = self.source_of(CALL, from.into())?;
        let schema = self.schema_of(source);
        Self::columns_of(CALL, &schema, names, None)?;
        let keep: Vec<usize> = (0..schema.values().len())
            .filter(|&c| names.contains(&schema.values()[c].name.as_str()))
            .collect();
        let mut columns = vec![schema.columns[0].clone()];
        columns.extend(keep.iter().map(|&c| schema.values()[c].clone()));
        let out = LiveSchema::new(columns);
        let step: Step = Box::new(move |e: &LiveEvent| {
            Some(Kept::New(
                keep.iter().map(|&c| e.values()[c].clone()).collect(),
            ))
        });
        Ok(self.add_view(source, out, step, None, self.window_ms_of(source)))
    }

    /// Every `n`th event of `from`, counted from when the view is built
    /// (pond-ts `sample({ stride })`). Only [`Sample::Stride`]: a live
    /// reservoir would drop events from the middle, which views cannot
    /// follow (pond-ts has none either).
    pub fn sample(
        &mut self,
        from: impl Into<super::NodeId>,
        how: Sample,
    ) -> Result<Node<LiveView>> {
        const CALL: &str = "LiveSeries::sample";
        let source = self.source_of(CALL, from.into())?;
        let stride = match how {
            Sample::Stride(n) if n >= 1 => n,
            Sample::Stride(_) => {
                return Err(PondError::InvalidData {
                    call: CALL,
                    message: "stride must be at least 1".into(),
                });
            }
            Sample::Reservoir { .. } => {
                return Err(PondError::Unsupported {
                    call: CALL,
                    message: "live sample takes Sample::Stride only".into(),
                });
            }
        };
        let schema = self.schema_of(source);
        let mut seen = 0usize;
        let step: Step = Box::new(move |e: &LiveEvent| {
            seen += 1;
            seen.is_multiple_of(stride).then(|| Kept::Pass(e.clone()))
        });
        Ok(self.add_view(source, schema, step, None, None))
    }

    /// The events of `from` starting within `duration` (`"5s"`) of the
    /// newest one (pond-ts `window('5s')`). Its
    /// [`event_rate`](LiveView::event_rate) is events per second.
    pub fn window(
        &mut self,
        from: impl Into<super::NodeId>,
        duration: &str,
    ) -> Result<Node<LiveView>> {
        let source = self.source_of("LiveSeries::window", from.into())?;
        let ms = parse_duration(duration)?;
        let schema = self.schema_of(source);
        let step: Step = Box::new(|e: &LiveEvent| Some(Kept::Pass(e.clone())));
        Ok(self.add_view(source, schema, step, Some(Window::Span(ms)), Some(ms)))
    }

    /// The newest `rows` events of `from` (pond-ts `window(n)`); `rows`
    /// must be at least 1.
    pub fn window_rows(
        &mut self,
        from: impl Into<super::NodeId>,
        rows: usize,
    ) -> Result<Node<LiveView>> {
        const CALL: &str = "LiveSeries::window_rows";
        let source = self.source_of(CALL, from.into())?;
        if rows == 0 {
            return Err(PondError::InvalidData {
                call: CALL,
                message: "a window needs at least 1 row".into(),
            });
        }
        let schema = self.schema_of(source);
        let step: Step = Box::new(|e: &LiveEvent| Some(Kept::Pass(e.clone())));
        Ok(self.add_view(source, schema, step, Some(Window::Rows(rows)), None))
    }

    /// Each event's value minus the previous event's, for each named number
    /// column (pond-ts live `diff`). The first event, and any where either
    /// value is a gap, gets a gap; other columns pass through. The named
    /// columns become optional.
    pub fn diff(
        &mut self,
        from: impl Into<super::NodeId>,
        columns: &[&str],
    ) -> Result<Node<LiveView>> {
        self.delta(
            "LiveSeries::diff",
            from.into(),
            columns,
            FirstRow::Keep,
            Delta::Diff,
        )
    }

    /// [`LiveSeries::diff`], dropping the first event (pond-ts `{ drop:
    /// true }`) with [`FirstRow::Drop`].
    pub fn diff_with(
        &mut self,
        from: impl Into<super::NodeId>,
        columns: &[&str],
        first: FirstRow,
    ) -> Result<Node<LiveView>> {
        self.delta("LiveSeries::diff", from.into(), columns, first, Delta::Diff)
    }

    /// Change per second against the previous event (pond-ts live
    /// `rate`); a gap when the two start at the same time.
    pub fn rate(
        &mut self,
        from: impl Into<super::NodeId>,
        columns: &[&str],
    ) -> Result<Node<LiveView>> {
        self.delta(
            "LiveSeries::rate",
            from.into(),
            columns,
            FirstRow::Keep,
            Delta::Rate,
        )
    }

    /// [`LiveSeries::rate`] with the first event kept or dropped.
    pub fn rate_with(
        &mut self,
        from: impl Into<super::NodeId>,
        columns: &[&str],
        first: FirstRow,
    ) -> Result<Node<LiveView>> {
        self.delta("LiveSeries::rate", from.into(), columns, first, Delta::Rate)
    }

    /// Change as a fraction of the previous value (pond-ts live
    /// `pctChange`); a gap when that value is zero.
    pub fn pct_change(
        &mut self,
        from: impl Into<super::NodeId>,
        columns: &[&str],
    ) -> Result<Node<LiveView>> {
        self.delta(
            "LiveSeries::pct_change",
            from.into(),
            columns,
            FirstRow::Keep,
            Delta::Pct,
        )
    }

    /// [`LiveSeries::pct_change`] with the first event kept or dropped.
    pub fn pct_change_with(
        &mut self,
        from: impl Into<super::NodeId>,
        columns: &[&str],
        first: FirstRow,
    ) -> Result<Node<LiveView>> {
        self.delta(
            "LiveSeries::pct_change",
            from.into(),
            columns,
            first,
            Delta::Pct,
        )
    }

    fn delta(
        &mut self,
        call: &'static str,
        from: super::NodeId,
        columns: &[&str],
        first: FirstRow,
        mode: Delta,
    ) -> Result<Node<LiveView>> {
        let source = self.source_of(call, from)?;
        let schema = self.schema_of(source);
        if columns.is_empty() {
            return Err(PondError::InvalidData {
                call,
                message: "needs at least one column".into(),
            });
        }
        let targets = Self::columns_of(call, &schema, columns, Some(ColumnKind::Number))?;
        let out = Self::numbers_at(&schema, &targets);
        let mut prev: Option<(LiveEvent, i64)> = None;
        let step: Step = Box::new(move |e: &LiveEvent| {
            let mut values = e.values().to_vec();
            match &prev {
                None => {
                    prev = Some((e.clone(), e.begin()));
                    if first == FirstRow::Drop {
                        return None;
                    }
                    for &t in &targets {
                        values[t] = None;
                    }
                }
                Some((before, t0)) => {
                    // pond-ts: `(begin - prevTime) / 1000`, in f64.
                    let dt = (e.begin() - t0) as f64 / 1000.0;
                    for &t in &targets {
                        values[t] = match (&values[t], &before.values()[t]) {
                            (Some(Value::Number(now)), Some(Value::Number(was))) => {
                                let delta = now - was;
                                let v = match mode {
                                    Delta::Diff => Some(delta),
                                    Delta::Rate => (dt != 0.0).then(|| delta / dt),
                                    Delta::Pct => (*was != 0.0).then(|| delta / was),
                                };
                                v.filter(|v| v.is_finite()).map(Value::Number)
                            }
                            _ => None,
                        };
                    }
                    prev = Some((e.clone(), e.begin()));
                }
            }
            Some(Kept::New(values))
        });
        Ok(self.add_view(source, out, step, None, None))
    }

    /// Fill gaps in the named columns as events arrive (pond-ts live
    /// `fill({ col: strategy })`): [`Fill::Hold`] (the last value seen),
    /// [`Fill::Zero`] (number columns) or [`Fill::Value`] (of the column's
    /// kind). [`Fill::Bfill`] and [`Fill::Linear`] need later events and
    /// are refused, as in pond-ts.
    pub fn fill(
        &mut self,
        from: impl Into<super::NodeId>,
        spec: &[(&str, Fill)],
    ) -> Result<Node<LiveView>> {
        self.fill_spec(from.into(), Some(spec), None, None)
    }

    /// [`LiveSeries::fill`] filling at most `limit` gaps in a row per
    /// column (pond-ts `{ limit }`). A live view cannot see where a run of
    /// gaps ends, so it fills the first `limit` gaps of a longer run and
    /// leaves the rest; batch `fill_with` leaves such a run unfilled.
    pub fn fill_with(
        &mut self,
        from: impl Into<super::NodeId>,
        spec: &[(&str, Fill)],
        limit: usize,
    ) -> Result<Node<LiveView>> {
        self.fill_spec(from.into(), Some(spec), None, Some(limit))
    }

    /// Fill gaps in every value column with one strategy (pond-ts live
    /// `fill('hold')` / `fill('zero')`). `Zero` skips columns that are not
    /// numbers, as batch `fill_all` does.
    pub fn fill_all(
        &mut self,
        from: impl Into<super::NodeId>,
        fill: Fill,
    ) -> Result<Node<LiveView>> {
        self.fill_spec(from.into(), None, Some(fill), None)
    }

    /// [`LiveSeries::fill_all`] with a `limit`, as [`LiveSeries::fill_with`].
    pub fn fill_all_with(
        &mut self,
        from: impl Into<super::NodeId>,
        fill: Fill,
        limit: usize,
    ) -> Result<Node<LiveView>> {
        self.fill_spec(from.into(), None, Some(fill), Some(limit))
    }

    fn fill_spec(
        &mut self,
        from: super::NodeId,
        spec: Option<&[(&str, Fill)]>,
        all: Option<Fill>,
        limit: Option<usize>,
    ) -> Result<Node<LiveView>> {
        const CALL: &str = "LiveSeries::fill";
        let source = self.source_of(CALL, from)?;
        let schema = self.schema_of(source);
        let refuse = |message: String| PondError::InvalidData {
            call: CALL,
            message,
        };
        let live_only = |fill: &Fill| match fill {
            Fill::Bfill | Fill::Linear => Err(refuse(
                "a live fill takes Hold, Zero or a value; Bfill and Linear need later events"
                    .into(),
            )),
            _ => Ok(()),
        };
        let mut plan: Vec<(usize, FillWith)> = Vec::new();
        match (spec, all) {
            (Some(spec), _) => {
                let names: Vec<&str> = spec.iter().map(|(n, _)| *n).collect();
                let cols = Self::columns_of(CALL, &schema, &names, None)?;
                for (&c, (name, fill)) in cols.iter().zip(spec) {
                    live_only(fill)?;
                    let kind = schema.values()[c].kind;
                    let with = match fill {
                        Fill::Hold => FillWith::Hold,
                        Fill::Zero if kind == ColumnKind::Number => {
                            FillWith::Value(Value::Number(0.0))
                        }
                        Fill::Zero => {
                            return Err(PondError::WrongKind {
                                call: CALL,
                                column: name.to_string(),
                                kind: kind.as_str(),
                                reason: "Zero fills number columns only".into(),
                            });
                        }
                        Fill::Value(v) => {
                            let fits = match (v, kind) {
                                (Value::Number(x), ColumnKind::Number) => x.is_finite(),
                                (Value::String(_), ColumnKind::String)
                                | (Value::Boolean(_), ColumnKind::Boolean)
                                | (Value::Array(_), ColumnKind::Array) => true,
                                _ => false,
                            };
                            if !fits {
                                return Err(PondError::WrongKind {
                                    call: CALL,
                                    column: name.to_string(),
                                    kind: kind.as_str(),
                                    reason: format!("the fill value {v:?} is not of this kind"),
                                });
                            }
                            FillWith::Value(v.clone())
                        }
                        Fill::Bfill | Fill::Linear => unreachable!("refused above"),
                    };
                    plan.push((c, with));
                }
            }
            (None, Some(fill)) => {
                live_only(&fill)?;
                for (c, def) in schema.values().iter().enumerate() {
                    match &fill {
                        Fill::Hold => plan.push((c, FillWith::Hold)),
                        Fill::Zero if def.kind == ColumnKind::Number => {
                            plan.push((c, FillWith::Value(Value::Number(0.0))))
                        }
                        Fill::Zero => {}
                        Fill::Value(_) => {
                            return Err(refuse(
                                "fill_all takes Hold or Zero; give a value per column with fill"
                                    .into(),
                            ));
                        }
                        Fill::Bfill | Fill::Linear => unreachable!("refused above"),
                    }
                }
            }
            (None, None) => unreachable!("one of the two"),
        }
        // Per column: the last value seen, and how many gaps in a row.
        let mut state: Vec<(Option<Value>, usize)> = vec![(None, 0); plan.len()];
        let step: Step = Box::new(move |e: &LiveEvent| {
            let mut values: Option<Vec<Option<Value>>> = None;
            for ((c, with), (last, run)) in plan.iter().zip(state.iter_mut()) {
                match &e.values()[*c] {
                    Some(v) => {
                        *last = Some(v.clone());
                        *run = 0;
                    }
                    None => {
                        *run += 1;
                        if limit.is_some_and(|l| *run > l) {
                            continue;
                        }
                        let fill = match with {
                            FillWith::Hold => last.clone(),
                            FillWith::Value(v) => Some(v.clone()),
                        };
                        if fill.is_some() {
                            values.get_or_insert_with(|| e.values().to_vec())[*c] = fill;
                        }
                    }
                }
            }
            Some(match values {
                None => Kept::Pass(e.clone()),
                Some(values) => Kept::New(values),
            })
        });
        Ok(self.add_view(source, schema, step, None, None))
    }

    /// Running totals down number columns (pond-ts live `cumulative`):
    /// [`Reducer::Sum`] (from `+0`), [`Reducer::Max`], [`Reducer::Min`] or
    /// [`Reducer::Count`] (values seen). A gap keeps the running value;
    /// events before the first value, and a running value that is not
    /// finite, give a gap.
    pub fn cumulative(
        &mut self,
        from: impl Into<super::NodeId>,
        spec: &[(&str, Reducer)],
    ) -> Result<Node<LiveView>> {
        const CALL: &str = "LiveSeries::cumulative";
        for (name, reducer) in spec {
            if !matches!(
                reducer,
                Reducer::Sum | Reducer::Max | Reducer::Min | Reducer::Count
            ) {
                return Err(PondError::InvalidData {
                    call: CALL,
                    message: format!(
                        "column '{name}': cumulative takes sum, max, min or count, not {reducer:?}"
                    ),
                });
            }
        }
        let folds = spec
            .iter()
            .map(
                |&(_, reducer)| -> Box<dyn FnMut(Option<f64>, f64) -> f64 + Send> {
                    match reducer {
                        Reducer::Sum => Box::new(|acc, v| acc.unwrap_or(0.0) + v),
                        Reducer::Count => Box::new(|acc, _| acc.unwrap_or(0.0) + 1.0),
                        // pond-ts: `acc === undefined || v > acc ? v : acc`.
                        Reducer::Max => Box::new(|acc, v| match acc {
                            Some(a) if v > a => v,
                            Some(a) => a,
                            None => v,
                        }),
                        _ => Box::new(|acc, v| match acc {
                            Some(a) if v < a => v,
                            Some(a) => a,
                            None => v,
                        }),
                    }
                },
            )
            .collect();
        let names: Vec<&str> = spec.iter().map(|(n, _)| *n).collect();
        self.running(CALL, from.into(), &names, folds)
    }

    /// A running fold of your own down one number column (pond-ts live
    /// `cumulative({ col: (acc, v) => … })`): the first value starts it as
    /// it is, then each later value `v` makes it `f(acc, v)`.
    pub fn cumulative_with<F>(
        &mut self,
        from: impl Into<super::NodeId>,
        column: &str,
        mut f: F,
    ) -> Result<Node<LiveView>>
    where
        F: FnMut(f64, f64) -> f64 + Send + 'static,
    {
        let fold: Box<dyn FnMut(Option<f64>, f64) -> f64 + Send> =
            Box::new(move |acc, v| acc.map_or(v, |a| f(a, v)));
        self.running(
            "LiveSeries::cumulative_with",
            from.into(),
            &[column],
            vec![fold],
        )
    }

    #[allow(clippy::type_complexity)]
    fn running(
        &mut self,
        call: &'static str,
        from: super::NodeId,
        names: &[&str],
        mut folds: Vec<Box<dyn FnMut(Option<f64>, f64) -> f64 + Send>>,
    ) -> Result<Node<LiveView>> {
        let source = self.source_of(call, from)?;
        let schema = self.schema_of(source);
        if names.is_empty() {
            return Err(PondError::InvalidData {
                call,
                message: "needs at least one column".into(),
            });
        }
        let targets = Self::columns_of(call, &schema, names, Some(ColumnKind::Number))?;
        let out = Self::numbers_at(&schema, &targets);
        let mut acc: Vec<Option<f64>> = vec![None; targets.len()];
        let step: Step = Box::new(move |e: &LiveEvent| {
            let mut values = e.values().to_vec();
            for (k, &t) in targets.iter().enumerate() {
                if let Some(Value::Number(v)) = values[t] {
                    acc[k] = Some(folds[k](acc[k], v));
                }
                values[t] = acc[k].filter(|a| a.is_finite()).map(Value::Number);
            }
            Some(Kept::New(values))
        });
        Ok(self.add_view(source, out, step, None, None))
    }
}
