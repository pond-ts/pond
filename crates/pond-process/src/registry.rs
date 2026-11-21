//! Op definitions, the params they take, and the registry that holds them.
//!
//! Mirrors `registry.ts` and `params.ts`: one declaration is read by the
//! param checks, by `describe()` (what a picker or a model is shown), and
//! later by the runner.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use pond_rs::js_number;
use serde_json::{Map, Value, json};

use crate::context::{FoldContext, FoldFn, OpContext, RunFn};
use crate::error::{ErrorKind, ProcessError, Result};
use crate::js::{js_string, js_typeof, json_stringify};

/// Resolved params: every declared param, defaults filled in, in the order
/// the op declares them.
pub type Params = Map<String, Value>;

/// Writes an op's lineage text from its params and its already-written
/// inputs (`"close 1 rows earlier"`).
pub type Label = Arc<dyn Fn(&Params, &str) -> String + Send + Sync>;

/// One declared param.
#[derive(Debug, Clone, PartialEq)]
pub enum ParamDef {
    /// A number; `integer` also rejects fractions.
    Number {
        integer: bool,
        default: f64,
        min: Option<f64>,
        max: Option<f64>,
        /// The useful range, for a slider or a model. Never rejects.
        suggest: Option<(f64, f64)>,
        label: Option<String>,
    },
    /// One of a fixed list of strings.
    Enum {
        default: String,
        of: Vec<String>,
        label: Option<String>,
    },
    /// True or false.
    Boolean {
        default: bool,
        label: Option<String>,
    },
}

impl ParamDef {
    /// A whole-number param.
    pub fn int(default: f64) -> Self {
        ParamDef::Number {
            integer: true,
            default,
            min: None,
            max: None,
            suggest: None,
            label: None,
        }
    }

    /// A number param.
    pub fn num(default: f64) -> Self {
        ParamDef::Number {
            integer: false,
            default,
            min: None,
            max: None,
            suggest: None,
            label: None,
        }
    }

    /// A param that takes one of `of`.
    pub fn choice(default: &str, of: &[&str]) -> Self {
        ParamDef::Enum {
            default: default.into(),
            of: of.iter().map(|s| (*s).into()).collect(),
            label: None,
        }
    }

    /// A true-or-false param.
    pub fn flag(default: bool) -> Self {
        ParamDef::Boolean {
            default,
            label: None,
        }
    }

    /// Sets the lowest legal value of a number param.
    pub fn min(mut self, v: f64) -> Self {
        if let ParamDef::Number { min, .. } = &mut self {
            *min = Some(v);
        }
        self
    }

    /// Sets the highest legal value of a number param.
    pub fn max(mut self, v: f64) -> Self {
        if let ParamDef::Number { max, .. } = &mut self {
            *max = Some(v);
        }
        self
    }

    /// Sets the useful range of a number param.
    pub fn suggest(mut self, lo: f64, hi: f64) -> Self {
        if let ParamDef::Number { suggest, .. } = &mut self {
            *suggest = Some((lo, hi));
        }
        self
    }

    /// Sets the text a control shows for the param.
    pub fn label(mut self, text: &str) -> Self {
        match &mut self {
            ParamDef::Number { label, .. }
            | ParamDef::Enum { label, .. }
            | ParamDef::Boolean { label, .. } => *label = Some(text.into()),
        }
        self
    }

    /// The default, as a JSON value.
    pub fn default_value(&self) -> Value {
        match self {
            ParamDef::Number { default, .. } => number(*default),
            ParamDef::Enum { default, .. } => Value::String(default.clone()),
            ParamDef::Boolean { default, .. } => Value::Bool(*default),
        }
    }

    /// The declaration as `describe()` reports it.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        match self {
            ParamDef::Number {
                integer,
                default,
                min,
                max,
                suggest,
                label,
            } => {
                out.insert(
                    "kind".into(),
                    json!(if *integer { "integer" } else { "number" }),
                );
                if let Some(v) = min {
                    out.insert("min".into(), number(*v));
                }
                if let Some(v) = max {
                    out.insert("max".into(), number(*v));
                }
                if let Some((lo, hi)) = suggest {
                    out.insert("suggest".into(), json!([number(*lo), number(*hi)]));
                }
                out.insert("default".into(), number(*default));
                if let Some(l) = label {
                    out.insert("label".into(), json!(l));
                }
            }
            ParamDef::Enum { default, of, label } => {
                out.insert("kind".into(), json!("enum"));
                out.insert("of".into(), json!(of));
                out.insert("default".into(), json!(default));
                if let Some(l) = label {
                    out.insert("label".into(), json!(l));
                }
            }
            ParamDef::Boolean { default, label } => {
                out.insert("kind".into(), json!("boolean"));
                out.insert("default".into(), json!(default));
                if let Some(l) = label {
                    out.insert("label".into(), json!(l));
                }
            }
        }
        Value::Object(out)
    }
}

/// A number as JSON, whole numbers written as integers so they compare
/// equal to what JavaScript wrote.
pub(crate) fn number(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

/// One declared input.
#[derive(Debug, Clone, PartialEq)]
pub struct InputDef {
    /// The input's name inside the op (`"left"`, `"source"`).
    pub role: String,
    /// The unit the input must carry, if it demands one.
    pub unit: Option<String>,
}

/// One declared output column of an op.
#[derive(Debug, Clone, PartialEq)]
pub struct OutputDef {
    /// Added to the spec id to name the column; `""` for a single output.
    pub id: String,
    /// A unit, or `"inherit"` to take input 0's.
    pub unit: String,
    /// The params this output depends on; `None` means all of them.
    pub depends_on: Option<Vec<String>>,
}

/// Whether a definition makes columns or ends in a fact.
#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
    /// Makes one or more columns.
    Op { outputs: Vec<OutputDef> },
    /// Ends in a fact; nothing can take it as an input.
    Fold { unit: String },
}

/// An op or fold definition.
#[derive(Clone)]
pub struct Def {
    pub name: String,
    pub family: String,
    pub summary: String,
    /// In declaration order.
    pub params: Vec<(String, ParamDef)>,
    pub inputs: Vec<InputDef>,
    pub shape: Shape,
    pub label: Option<Label>,
    /// The op's code; `None` until set (a definition can be described
    /// and named without it).
    pub run: Option<RunFn>,
    /// The fold's code.
    pub fold: Option<FoldFn>,
    /// Rows of history the op needs before its first answer, from its
    /// params; `None` when undeclared, which [`required_history`] reports
    /// as unknown rather than zero.
    ///
    /// [`required_history`]: crate::required_history
    pub lookback: Option<LookbackFn>,
}

/// An op's lookback: its params (defaults applied) in, rows out.
pub type LookbackFn = Arc<dyn Fn(&Params) -> f64 + Send + Sync>;

impl fmt::Debug for Def {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Def")
            .field("name", &self.name)
            .field("family", &self.family)
            .field("params", &self.params)
            .field("inputs", &self.inputs)
            .field("shape", &self.shape)
            .finish_non_exhaustive()
    }
}

impl Def {
    /// An op that makes columns. Add at least one output.
    pub fn op(name: &str, family: &str, summary: &str) -> Self {
        Def::new(name, family, summary, Shape::Op { outputs: vec![] })
    }

    /// A fold whose fact carries `unit` (`"inherit"` for input 0's).
    pub fn fold(name: &str, family: &str, summary: &str, unit: &str) -> Self {
        Def::new(name, family, summary, Shape::Fold { unit: unit.into() })
    }

    fn new(name: &str, family: &str, summary: &str, shape: Shape) -> Self {
        Def {
            name: name.into(),
            family: family.into(),
            summary: summary.into(),
            params: vec![],
            inputs: vec![],
            shape,
            label: None,
            run: None,
            fold: None,
            lookback: None,
        }
    }

    /// Declares a param.
    pub fn param(mut self, key: &str, def: ParamDef) -> Self {
        self.params.push((key.into(), def));
        self
    }

    /// Declares an input.
    pub fn input(mut self, role: &str) -> Self {
        self.inputs.push(InputDef {
            role: role.into(),
            unit: None,
        });
        self
    }

    /// Declares an input that must carry `unit`.
    pub fn typed_input(mut self, role: &str, unit: &str) -> Self {
        self.inputs.push(InputDef {
            role: role.into(),
            unit: Some(unit.into()),
        });
        self
    }

    /// Declares an output column depending on every param.
    pub fn output(self, id: &str, unit: &str) -> Self {
        self.push_output(id, unit, None)
    }

    /// Declares an output column depending only on `depends_on`.
    pub fn output_on(self, id: &str, unit: &str, depends_on: &[&str]) -> Self {
        let keys = depends_on.iter().map(|k| (*k).into()).collect();
        self.push_output(id, unit, Some(keys))
    }

    fn push_output(mut self, id: &str, unit: &str, depends_on: Option<Vec<String>>) -> Self {
        if let Shape::Op { outputs } = &mut self.shape {
            outputs.push(OutputDef {
                id: id.into(),
                unit: unit.into(),
                depends_on,
            });
        }
        self
    }

    /// Sets an op's code.
    pub fn run(
        mut self,
        f: impl Fn(&OpContext) -> std::result::Result<Vec<Vec<f64>>, ProcessError>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        self.run = Some(Arc::new(f));
        self
    }

    /// Sets a fold's code.
    pub fn folds(
        mut self,
        f: impl Fn(&FoldContext) -> std::result::Result<Value, ProcessError> + Send + Sync + 'static,
    ) -> Self {
        self.fold = Some(Arc::new(f));
        self
    }

    /// Declares how many rows of history the op needs before its first
    /// answer. An element-wise op declares `|_| 0.0`; leaving it out means
    /// "unknown", which is not the same thing.
    pub fn lookback(mut self, f: impl Fn(&Params) -> f64 + Send + Sync + 'static) -> Self {
        self.lookback = Some(Arc::new(f));
        self
    }

    /// Sets the lineage text.
    pub fn label(mut self, f: impl Fn(&Params, &str) -> String + Send + Sync + 'static) -> Self {
        self.label = Some(Arc::new(f));
        self
    }

    /// True for a fold.
    pub fn is_fold(&self) -> bool {
        matches!(self.shape, Shape::Fold { .. })
    }

    /// The declared outputs; empty for a fold.
    pub fn outputs(&self) -> &[OutputDef] {
        match &self.shape {
            Shape::Op { outputs } => outputs,
            Shape::Fold { .. } => &[],
        }
    }

    fn param_def(&self, key: &str) -> Option<&ParamDef> {
        self.params.iter().find(|(k, _)| k == key).map(|(_, d)| d)
    }
}

/// Validates one param value against its declaration.
fn check_param(op: &str, key: &str, def: &ParamDef, v: &Value) -> Result<()> {
    let got = || format!("{} ({})", json_stringify(v), js_typeof(v));
    let fail = |m: String| Err(ProcessError::new(ErrorKind::Param, m));
    match def {
        ParamDef::Number {
            integer, min, max, ..
        } => {
            let kind = if *integer { "integer" } else { "number" };
            let Some(x) = v.as_f64() else {
                let article = if *integer { "an" } else { "a" };
                return fail(format!(
                    "{op}.{key} must be {article} {kind}, got {}",
                    got()
                ));
            };
            if *integer && !(x.is_finite() && x.fract() == 0.0) {
                return fail(format!("{op}.{key} must be an integer, got {}", got()));
            }
            if let Some(m) = min
                && x < *m
            {
                return fail(format!(
                    "{op}.{key}={} is below minimum {}",
                    js_number(x),
                    js_number(*m)
                ));
            }
            if let Some(m) = max
                && x > *m
            {
                return fail(format!(
                    "{op}.{key}={} is above maximum {}",
                    js_number(x),
                    js_number(*m)
                ));
            }
            Ok(())
        }
        ParamDef::Enum { of, .. } => match v.as_str() {
            Some(s) if of.iter().any(|o| o == s) => Ok(()),
            _ => {
                let list = of.iter().map(|o| format!("'{o}'")).collect::<Vec<_>>();
                fail(format!(
                    "{op}.{key} must be one of {}, got {}",
                    list.join(", "),
                    got()
                ))
            }
        },
        ParamDef::Boolean { .. } => {
            if v.is_boolean() {
                Ok(())
            } else {
                fail(format!("{op}.{key} must be a boolean, got {}", got()))
            }
        }
    }
}

/// Checks a `suggest` range when the op is defined.
fn check_suggest(op: &str, key: &str, def: &ParamDef) -> Result<()> {
    let ParamDef::Number {
        min,
        max,
        suggest: Some((lo, hi)),
        ..
    } = def
    else {
        return Ok(());
    };
    let bad = if lo > hi {
        Some("is inverted".to_string())
    } else if min.is_some_and(|m| *lo < m) || max.is_some_and(|m| *hi > m) {
        let lo_text = min.map_or("-∞".into(), js_number);
        let hi_text = max.map_or("∞".into(), js_number);
        Some(format!("escapes the legal range [{lo_text}, {hi_text}]"))
    } else {
        None
    };
    match bad {
        Some(b) => Err(ProcessError::new(
            ErrorKind::Process,
            format!(
                "{op}.{key} suggest [{}, {}] {b}",
                js_number(*lo),
                js_number(*hi)
            ),
        )),
        None => Ok(()),
    }
}

/// The ops and folds a plan may use, in the order they were defined.
#[derive(Debug, Clone, Default)]
pub struct Registry {
    defs: Vec<Arc<Def>>,
    index: HashMap<String, usize>,
}

impl Registry {
    /// An empty registry.
    pub fn new() -> Self {
        Registry::default()
    }

    /// A registry holding the standard folds (`last`, `extremes`,
    /// `percentileRank`, `shape`), as `createRegistry()` gives.
    pub fn standard() -> Self {
        let mut registry = Registry::new();
        for def in crate::folds::standard_folds() {
            registry.define(def).expect("the standard folds are valid");
        }
        registry
    }

    /// Adds a definition, or replaces one of the same name in place.
    ///
    /// Mistakes in a definition's own source are reported here, in front
    /// of its author, rather than when a plan first uses it.
    pub fn define(&mut self, def: Def) -> Result<&mut Self> {
        let name = def.name.clone();
        let err = |m: String| Err(ProcessError::new(ErrorKind::Process, m));
        if def.param_def("as").is_some() {
            return err(format!(
                "definition '{name}' uses reserved param 'as' — fluent plans use it for the node slot"
            ));
        }
        if def.inputs.iter().any(|i| i.role == "as") {
            return err(format!(
                "definition '{name}' uses reserved input role 'as' — fluent plans use it for the node slot"
            ));
        }
        let mut roles = Vec::new();
        for input in &def.inputs {
            if roles.contains(&&input.role) {
                return err(format!(
                    "definition '{name}' declares input role '{}' twice",
                    input.role
                ));
            }
            roles.push(&input.role);
        }
        if let Shape::Op { outputs } = &def.shape {
            if outputs.is_empty() {
                return err(format!("op '{name}' declares no outputs"));
            }
            if outputs.len() > 1 && outputs.iter().any(|o| o.id.is_empty()) {
                return err(format!(
                    "op '{name}' is multi-output, so every output needs a suffix — '' would collide with the spec id"
                ));
            }
            let mut ids = Vec::new();
            for output in outputs {
                if ids.contains(&&output.id) {
                    return err(format!("op '{name}' declares output '{}' twice", output.id));
                }
                ids.push(&output.id);
                for key in output.depends_on.iter().flatten() {
                    if def.param_def(key).is_none() {
                        return err(format!(
                            "op '{name}' output '{}' dependsOn unknown param '{key}'",
                            output.id
                        ));
                    }
                }
            }
        }
        for (key, d) in &def.params {
            check_suggest(&name, key, d)?;
            if let Err(e) = check_param(&name, key, d, &d.default_value()) {
                return err(format!(
                    "definition '{name}' has an invalid default for '{key}': {}",
                    e.message
                ));
            }
        }
        let def = Arc::new(def);
        match self.index.get(&name) {
            Some(&i) => self.defs[i] = def,
            None => {
                self.index.insert(name, self.defs.len());
                self.defs.push(def);
            }
        }
        Ok(self)
    }

    /// True if an op or fold of this name is defined.
    pub fn has(&self, name: &str) -> bool {
        self.index.contains_key(name)
    }

    /// The definition, or an error listing what is available, so a model
    /// can pick again.
    pub fn get(&self, name: &str) -> Result<&Arc<Def>> {
        match self.index.get(name) {
            Some(&i) => Ok(&self.defs[i]),
            None => Err(ProcessError::new(
                ErrorKind::UnknownOp,
                format!(
                    "unknown op '{name}' — have {}",
                    self.defs
                        .iter()
                        .map(|d| format!("'{}'", d.name))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            )),
        }
    }

    /// Every definition, in the order defined.
    pub fn defs(&self) -> impl Iterator<Item = &Arc<Def>> {
        self.defs.iter()
    }

    /// Fills in defaults, then checks every declared param.
    ///
    /// With `validate` false it fills defaults and checks nothing, keeping
    /// undeclared params rather than refusing them, so an id can still be
    /// written for a spec that would not run. A valid spec resolves the
    /// same either way.
    pub fn resolve_params(
        &self,
        op: &Def,
        given: Option<&Map<String, Value>>,
        validate: bool,
    ) -> Result<Params> {
        let empty = Map::new();
        let given = given.unwrap_or(&empty);
        let mut out = Params::new();
        for (key, def) in &op.params {
            let raw = given
                .get(key)
                .cloned()
                .unwrap_or_else(|| def.default_value());
            if validate {
                check_param(&op.name, key, def, &raw)?;
            }
            out.insert(key.clone(), raw);
        }
        for (key, v) in given {
            if op.param_def(key).is_some() {
                continue;
            }
            if !validate {
                out.insert(key.clone(), v.clone());
                continue;
            }
            let takes = op
                .params
                .iter()
                .map(|(k, _)| format!("'{k}'"))
                .collect::<Vec<_>>();
            let takes = if takes.is_empty() {
                "none".to_string()
            } else {
                takes.join(", ")
            };
            return Err(ProcessError::new(
                ErrorKind::Param,
                format!("{} has no param '{key}' — takes {takes}", op.name),
            ));
        }
        Ok(out)
    }

    /// Checks a spec's `inputs` against the op's declared inputs. `None`
    /// means the spec has no `inputs` key.
    pub fn check_arity(&self, op: &Def, inputs: Option<&Value>) -> Result<()> {
        let want = op.inputs.len();
        let fail = |m: String| Err(ProcessError::new(ErrorKind::Arity, m));
        match inputs {
            None => fail(format!(
                "{} takes {want} input(s), got none — 'inputs' is missing",
                op.name
            )),
            Some(Value::Array(items)) if items.len() == want => Ok(()),
            Some(Value::Array(items)) => fail(format!(
                "{} takes {want} input(s), got {}",
                op.name,
                items.len()
            )),
            Some(other) => fail(format!(
                "{} takes {want} input(s), got none — 'inputs' is {}",
                op.name,
                json_stringify(other)
            )),
        }
    }

    /// Every definition as a picker or a model is shown it, as JSON.
    pub fn describe(&self) -> Vec<Value> {
        self.defs
            .iter()
            .map(|op| {
                let params: Map<String, Value> = op
                    .params
                    .iter()
                    .map(|(k, d)| (k.clone(), d.to_json()))
                    .collect();
                let inputs: Vec<Value> = op
                    .inputs
                    .iter()
                    .map(|i| match &i.unit {
                        Some(u) => json!({ "role": i.role, "unit": u }),
                        None => json!({ "role": i.role }),
                    })
                    .collect();
                let outputs: Vec<Value> = op
                    .outputs()
                    .iter()
                    .map(|o| json!({ "suffix": o.id, "unit": o.unit }))
                    .collect();
                json!({
                    "name": op.name,
                    "family": op.family,
                    "summary": op.summary,
                    "params": params,
                    "inputs": inputs,
                    "kind": if op.is_fold() { "fold" } else { "op" },
                    "outputs": outputs,
                })
            })
            .collect()
    }
}

/// `String(p[key])` for a label, `"undefined"` when absent.
pub(crate) fn param_text(p: &Params, key: &str) -> String {
    p.get(key).map_or_else(|| "undefined".into(), js_string)
}
