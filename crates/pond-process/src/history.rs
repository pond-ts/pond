//! How many rows of history a plan needs (`history.ts`, [PND-PROCHIST]).
//!
//! Lookbacks add up along a chain (`sma(20)` over `sma(50)` needs 69 rows,
//! not 50) and take the largest across independent inputs and specs. An op
//! that declares no lookback makes the answer unknown, with the op named,
//! rather than a guess of zero.

use std::collections::HashMap;

use serde_json::{Map, Value, json};

use crate::error::{ErrorKind, ProcessError, Result};
use crate::identity::spec_of;
use crate::registry::Registry;

/// What [`required_history`] finds.
#[derive(Debug, Clone, PartialEq)]
pub struct History {
    /// Rows of history needed before a requested range; `None` when some
    /// op declared no lookback.
    pub rows: Option<usize>,
    /// Ops with no declared lookback, once each, in the order met.
    pub undeclared: Vec<String>,
    /// The deepest history any spec of each op needed, by op name, in the
    /// order first finished. A diagnostic, not a number to slice against.
    pub by_op: Vec<(String, usize)>,
}

impl History {
    /// As `requiredHistory` returns it.
    pub fn to_json(&self) -> Value {
        let by_op: Map<String, Value> = self
            .by_op
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect();
        match self.rows {
            Some(rows) => json!({ "known": true, "rows": rows, "undeclared": [], "byOp": by_op }),
            None => json!({ "known": false, "undeclared": self.undeclared, "byOp": by_op }),
        }
    }
}

/// The minimum safe tail for `plan`, in rows.
pub fn required_history(registry: &Registry, plan: &[Value]) -> Result<History> {
    let mut walk = Walk {
        registry,
        undeclared: vec![],
        by_op: vec![],
        depth: HashMap::new(),
    };
    let mut rows = 0;
    for spec in plan {
        rows = rows.max(walk.of(spec)?);
    }
    Ok(History {
        rows: walk.undeclared.is_empty().then_some(rows),
        undeclared: walk.undeclared,
        by_op: walk.by_op,
    })
}

struct Walk<'a> {
    registry: &'a Registry,
    undeclared: Vec<String>,
    by_op: Vec<(String, usize)>,
    /// By the spec's place in memory: a plan shares specs, and the same
    /// subtree is reached by many paths.
    depth: HashMap<*const Value, usize>,
}

impl Walk<'_> {
    fn of(&mut self, spec: &Value) -> Result<usize> {
        if let Some(d) = self.depth.get(&(spec as *const Value)) {
            return Ok(*d);
        }
        let name = spec
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let def = self.registry.get(&name)?.clone();
        let mut own = 0;
        if !def.is_fold() {
            match &def.lookback {
                None => {
                    if !self.undeclared.contains(&name) {
                        self.undeclared.push(name.clone());
                    }
                }
                Some(f) => {
                    let params = self.registry.resolve_params(
                        &def,
                        spec.get("params").and_then(Value::as_object),
                        true,
                    )?;
                    let n = f(&params);
                    if !n.is_finite() || n < 0.0 {
                        return Err(ProcessError::new(
                            ErrorKind::Process,
                            format!(
                                "op '{name}' declared a lookback of {}; it must be a non-negative finite row count",
                                pond_rs::js_number(n)
                            ),
                        ));
                    }
                    own = n.ceil() as usize;
                }
            }
        }
        let mut deepest = 0;
        if let Some(inputs) = spec.get("inputs").and_then(Value::as_array) {
            for input in inputs {
                if input.is_string() {
                    continue;
                }
                deepest = deepest.max(self.of(spec_of(input))?);
            }
        }
        let total = own + deepest;
        self.depth.insert(spec as *const Value, total);
        match self.by_op.iter_mut().find(|(k, _)| *k == name) {
            Some(slot) => slot.1 = slot.1.max(total),
            None => self.by_op.push((name, total)),
        }
        Ok(total)
    }
}
