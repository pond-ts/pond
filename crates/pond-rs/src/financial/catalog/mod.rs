//! Every study, described at run time (pond-ts `@pond-ts/financial/catalog`):
//! the columns it reads, its numeric and menu options with defaults and
//! ranges, the columns it writes with their units, and a way to run it by
//! name with JSON options. For a registry, a picker, or an agent choosing
//! a study.
//!
//! ```
//! use pond_rs::financial::catalog::{STUDIES, study_descriptor};
//! use pond_rs::{Column, TimeSeries};
//! use serde_json::json;
//!
//! assert_eq!(STUDIES.len(), 109);
//! let rsi = study_descriptor("rsi").unwrap();
//! assert_eq!(rsi.param("period").unwrap().default_number(), Some(14.0));
//!
//! let close: Vec<f64> = (0..30).map(|i| 100.0 + (i % 7) as f64).collect();
//! let bars = TimeSeries::new("bars", (0..30).collect(), vec![Column::required("close", close)])?;
//! let out = rsi.run(&bars, json!({ "period": 5 }).as_object().unwrap())?;
//! assert!(out.column("rsi").is_ok());
//! # Ok::<(), pond_rs::PondError>(())
//! ```

mod run;
mod table;

pub use table::STUDIES;

use serde_json::{Map, Value, json};

use super::SessionAnchor;
use crate::error::Result;
use crate::series::TimeSeries;

/// A picker's grouping, one per study.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StudyFamily {
    MovingAverage,
    Bands,
    Momentum,
    Trend,
    Volatility,
    Volume,
    Statistical,
    Price,
    Session,
}

/// [`StudyFamily`] as a list, in menu order.
pub const STUDY_FAMILIES: [StudyFamily; 9] = [
    StudyFamily::MovingAverage,
    StudyFamily::Bands,
    StudyFamily::Momentum,
    StudyFamily::Trend,
    StudyFamily::Volatility,
    StudyFamily::Volume,
    StudyFamily::Statistical,
    StudyFamily::Price,
    StudyFamily::Session,
];

impl StudyFamily {
    /// pond-ts's name (`"moving-average"`, `"bands"`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            StudyFamily::MovingAverage => "moving-average",
            StudyFamily::Bands => "bands",
            StudyFamily::Momentum => "momentum",
            StudyFamily::Trend => "trend",
            StudyFamily::Volatility => "volatility",
            StudyFamily::Volume => "volume",
            StudyFamily::Statistical => "statistical",
            StudyFamily::Price => "price",
            StudyFamily::Session => "session",
        }
    }
}

/// What an output column is measured in; only [`StudyUnit::Inherit`] may
/// share the source column's axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StudyUnit {
    /// A level in the source's own units (a moving average, a band, a
    /// pivot).
    Inherit,
    /// The source's units, but a difference around zero (MACD, momentum).
    Delta,
    /// A percentage (RSI 0..100, Williams %R, a percent change).
    Percent,
    /// No units and no bounds (a z-score, a correlation).
    Ratio,
    /// A small whole-number verdict (+1 / 0 / -1, a direction).
    Signal,
    /// In the volume column's units (OBV, money flow).
    Volume,
    /// A running index from an arbitrary start (NVI / PVI at 1000).
    Index,
    /// A count of bars.
    Bars,
}

impl StudyUnit {
    /// pond-ts's name (`"inherit"`, `"delta"`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            StudyUnit::Inherit => "inherit",
            StudyUnit::Delta => "delta",
            StudyUnit::Percent => "percent",
            StudyUnit::Ratio => "ratio",
            StudyUnit::Signal => "signal",
            StudyUnit::Volume => "volume",
            StudyUnit::Index => "index",
            StudyUnit::Bars => "bars",
        }
    }
}

/// A column the study reads, by the option that names it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StudyInput {
    /// The option key (`"column"`, `"high"`, `"benchmark"`).
    pub role: &'static str,
    /// The column read when the option is left out; `None` means the
    /// option is required (a `benchmark`).
    pub default: Option<&'static str>,
}

/// A numeric or menu option.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StudyParam {
    /// The option key (`"period"`, `"maType"`).
    pub name: &'static str,
    pub kind: ParamKind,
    /// Leaving the option out switches a behaviour off rather than meaning
    /// a default value (`balanceOfPower`'s `period`); it then has an
    /// `example`, not a `default`.
    pub optional: bool,
    /// Only legal alongside this other option (`balanceOfPower`'s `maType`
    /// needs its `period`).
    pub requires: Option<&'static str>,
}

/// The two kinds of option.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ParamKind {
    /// A number; `integer` for bar counts.
    Number {
        integer: bool,
        /// The value used when the option is left out; `None` means
        /// required (or [`StudyParam::optional`]).
        default: Option<f64>,
        /// For an option with no default: a value that makes the study run.
        example: Option<f64>,
        /// The legal range, inclusive, where the study checks a fixed
        /// bound.
        min: Option<f64>,
        max: Option<f64>,
        /// The useful range a control is drawn on (advisory).
        suggest: Option<(f64, f64)>,
    },
    /// One of a closed list of names (`maType`, a pivot `method`).
    Enum {
        of: &'static [&'static str],
        default: Option<&'static str>,
        example: Option<&'static str>,
    },
}

impl StudyParam {
    /// The default of a number option.
    pub fn default_number(&self) -> Option<f64> {
        match self.kind {
            ParamKind::Number { default, .. } => default,
            ParamKind::Enum { .. } => None,
        }
    }

    fn to_json(self) -> Value {
        let mut o = Map::new();
        match self.kind {
            ParamKind::Number {
                integer,
                default,
                example,
                min,
                max,
                suggest,
            } => {
                o.insert(
                    "kind".into(),
                    json!(if integer { "integer" } else { "number" }),
                );
                for (key, v) in [
                    ("default", default),
                    ("example", example),
                    ("min", min),
                    ("max", max),
                ] {
                    if let Some(v) = v {
                        o.insert(key.into(), json_number(v));
                    }
                }
                if let Some((lo, hi)) = suggest {
                    o.insert("suggest".into(), json!([json_number(lo), json_number(hi)]));
                }
            }
            ParamKind::Enum {
                of,
                default,
                example,
            } => {
                o.insert("kind".into(), json!("enum"));
                if let Some(v) = default {
                    o.insert("default".into(), json!(v));
                }
                if let Some(v) = example {
                    o.insert("example".into(), json!(v));
                }
                o.insert("of".into(), json!(of));
            }
        }
        if self.optional {
            o.insert("optional".into(), json!(true));
        }
        if let Some(r) = self.requires {
            o.insert("requires".into(), json!(r));
        }
        Value::Object(o)
    }
}

/// A whole number as a JSON integer (as JavaScript writes it), anything
/// else as a float.
fn json_number(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9.0e15 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

/// One column the study writes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StudyOutput {
    /// The name after the prefix (`"Upper"` in `bbUpper`) under
    /// [`StudyNaming::Prefix`]; `""` is the bare prefix, and the only id
    /// under [`StudyNaming::Output`].
    pub id: &'static str,
    pub unit: StudyUnit,
}

/// How the study names its columns, with the default name.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StudyNaming {
    /// One column, named by the `output` option.
    Output(&'static str),
    /// A family named `prefix + id`, by the `prefix` option.
    Prefix(&'static str),
}

/// An input that is neither a column nor a number option.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StudyAnchor {
    /// The session studies: give `session` (a session-id column) or
    /// `sessions` (a session list) in the options, or a calendar through
    /// [`StudyDescriptor::run_with`].
    Session,
    /// `anchoredVwap`: give `anchor`, epoch milliseconds.
    Time,
}

/// A study, described: everything a registry or a picker needs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StudyDescriptor {
    /// pond-ts's name for the study (`"atr"`).
    pub name: &'static str,
    pub family: StudyFamily,
    /// One line, for a menu.
    pub summary: &'static str,
    /// The columns read, in options order.
    pub inputs: &'static [StudyInput],
    /// The number and menu options, in options order. Column inputs, the
    /// naming option and the anchors are not params.
    pub params: &'static [StudyParam],
    pub naming: StudyNaming,
    /// The columns written, in order, under the default options (a menu
    /// value can change the set: `pivotPoints`' `camarilla` adds `R4` and
    /// `S4`).
    pub outputs: &'static [StudyOutput],
    pub anchor: Option<StudyAnchor>,
}

impl StudyDescriptor {
    /// The option `name`, if the study has one.
    pub fn param(&self, name: &str) -> Option<&'static StudyParam> {
        self.params.iter().find(|p| p.name == name)
    }

    /// The column names the study writes under its default naming.
    pub fn output_names(&self) -> Vec<String> {
        match self.naming {
            StudyNaming::Output(name) => vec![name.to_string()],
            StudyNaming::Prefix(prefix) => self
                .outputs
                .iter()
                .map(|o| format!("{prefix}{}", o.id))
                .collect(),
        }
    }

    /// Run the study on `series` with pond-ts's options, as JSON: column
    /// options by name (`"high": "h"`), numbers, menu names, `output` or
    /// `prefix`, and the anchor (`session`, `sessions`, `stamped`,
    /// `anchor`). Options the study does not have are ignored, as in
    /// pond-ts; an option of the wrong type (`null` included) is an error,
    /// as is a bar count that is negative or not whole.
    pub fn run(&self, series: &TimeSeries, options: &Map<String, Value>) -> Result<TimeSeries> {
        run::run(self, series, options, None)
    }

    /// [`run`](Self::run) with the sessions given directly (a
    /// [`TradingCalendar`](super::TradingCalendar) has no JSON form); the
    /// options must then name neither `session` nor `sessions`. Only for
    /// the session studies.
    pub fn run_with(
        &self,
        series: &TimeSeries,
        options: &Map<String, Value>,
        sessions: SessionAnchor<'_>,
    ) -> Result<TimeSeries> {
        run::run(self, series, options, Some(sessions))
    }

    /// The descriptor in pond-ts's JSON shape (without `run`). `params` is
    /// an object keyed by option name; [`params`](Self::params) keeps the
    /// options order.
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("name".into(), json!(self.name));
        o.insert("family".into(), json!(self.family.as_str()));
        o.insert("summary".into(), json!(self.summary));
        let inputs: Vec<Value> = self
            .inputs
            .iter()
            .map(|i| match i.default {
                Some(d) => json!({ "role": i.role, "default": d }),
                None => json!({ "role": i.role }),
            })
            .collect();
        o.insert("inputs".into(), Value::Array(inputs));
        let params: Map<String, Value> = self
            .params
            .iter()
            .map(|p| (p.name.to_string(), p.to_json()))
            .collect();
        o.insert("params".into(), Value::Object(params));
        let (kind, default) = match self.naming {
            StudyNaming::Output(d) => ("output", d),
            StudyNaming::Prefix(d) => ("prefix", d),
        };
        o.insert("naming".into(), json!({ "kind": kind, "default": default }));
        let outputs: Vec<Value> = self
            .outputs
            .iter()
            .map(|out| json!({ "id": out.id, "unit": out.unit.as_str() }))
            .collect();
        o.insert("outputs".into(), Value::Array(outputs));
        if let Some(anchor) = self.anchor {
            let a = match anchor {
                StudyAnchor::Session => "session",
                StudyAnchor::Time => "time",
            };
            o.insert("anchor".into(), json!(a));
        }
        Value::Object(o)
    }
}

/// Look a study up by pond-ts's name; `None` when it is not in the
/// catalog.
pub fn study_descriptor(name: &str) -> Option<&'static StudyDescriptor> {
    STUDIES.iter().find(|d| d.name == name)
}
