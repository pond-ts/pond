//! One event of a live node: a key and a value per column, sharing its
//! schema with every other event of that node. Cheap to clone (two
//! reference counts), so every output of one push shares the same event.
//! Series and views store their events by column (`buffer.rs`) and build a
//! `LiveEvent` when one is read.

use std::sync::Arc;

use crate::column::{Scalar, Value};
use crate::error::{PondError, Result};
use crate::query::EventKey;
use crate::series::{ColumnDef, ColumnKind};

/// A node's schema, key column first.
#[derive(Debug)]
pub(crate) struct LiveSchema {
    pub(crate) columns: Vec<ColumnDef>,
}

impl LiveSchema {
    pub(crate) fn new(columns: Vec<ColumnDef>) -> Arc<Self> {
        Arc::new(Self { columns })
    }

    /// The value column `name`'s position among the values (the key not
    /// counted).
    pub(crate) fn value_index(&self, name: &str) -> Option<usize> {
        self.columns[1..].iter().position(|c| c.name == name)
    }

    pub(crate) fn values(&self) -> &[ColumnDef] {
        &self.columns[1..]
    }
}

#[derive(Debug)]
struct EventData {
    key: EventKey,
    values: Vec<Option<Value>>,
}

/// One event: a key ([`EventKey`]) and one cell per value column, `None`
/// for a gap. Values are read by column name, as on a
/// [`Row`](crate::Row); a name the node does not have, or a column of
/// another kind, is an error.
#[derive(Debug, Clone)]
pub struct LiveEvent {
    data: Arc<EventData>,
    schema: Arc<LiveSchema>,
}

impl PartialEq for LiveEvent {
    /// Same key and the same cells (numbers by value, so `0` equals `-0`).
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.data, &other.data)
            || (self.data.key == other.data.key && self.data.values == other.data.values)
    }
}

impl LiveEvent {
    pub(crate) fn new(schema: Arc<LiveSchema>, key: EventKey, values: Vec<Option<Value>>) -> Self {
        Self {
            data: Arc::new(EventData { key, values }),
            schema,
        }
    }

    /// Whether another clone of this event exists.
    pub(crate) fn is_shared(&self) -> bool {
        Arc::strong_count(&self.data) > 1
    }

    /// The key and cells, moved out when nothing else holds this event.
    pub(crate) fn into_parts(self) -> (EventKey, Vec<Option<Value>>) {
        match Arc::try_unwrap(self.data) {
            Ok(data) => (data.key, data.values),
            Err(shared) => (shared.key.clone(), shared.values.clone()),
        }
    }

    /// The key.
    pub fn key(&self) -> &EventKey {
        &self.data.key
    }

    /// The key's start, epoch milliseconds.
    pub fn begin(&self) -> i64 {
        self.data.key.begin()
    }

    /// The key's end (the start, for a point in time).
    pub fn end(&self) -> i64 {
        self.data.key.end()
    }

    /// Every value cell, in schema order (the key not included).
    pub fn values(&self) -> &[Option<Value>] {
        &self.data.values
    }

    /// The shared schema handle (cheap to clone).
    pub(crate) fn schema_arc(&self) -> &Arc<LiveSchema> {
        &self.schema
    }

    /// The node's schema, key column first.
    pub fn schema(&self) -> &[ColumnDef] {
        &self.schema.columns
    }

    /// The cell in column `name`, whatever its kind.
    pub fn value(&self, name: &str) -> Result<Option<&Value>> {
        let i = self.index(name)?;
        Ok(self.data.values[i].as_ref())
    }

    /// A number cell.
    pub fn number(&self, name: &str) -> Result<Option<f64>> {
        match self.typed(name, ColumnKind::Number)? {
            Some(Value::Number(v)) => Ok(Some(*v)),
            _ => Ok(None),
        }
    }

    /// A text cell.
    pub fn string(&self, name: &str) -> Result<Option<&str>> {
        match self.typed(name, ColumnKind::String)? {
            Some(Value::String(v)) => Ok(Some(v)),
            _ => Ok(None),
        }
    }

    /// A true/false cell.
    pub fn boolean(&self, name: &str) -> Result<Option<bool>> {
        match self.typed(name, ColumnKind::Boolean)? {
            Some(Value::Boolean(v)) => Ok(Some(*v)),
            _ => Ok(None),
        }
    }

    /// An array cell's elements.
    pub fn array(&self, name: &str) -> Result<Option<&[Scalar]>> {
        match self.typed(name, ColumnKind::Array)? {
            Some(Value::Array(v)) => Ok(Some(v)),
            _ => Ok(None),
        }
    }

    fn index(&self, name: &str) -> Result<usize> {
        self.schema
            .value_index(name)
            .ok_or_else(|| PondError::UnknownColumn {
                call: "LiveEvent",
                column: name.to_string(),
                available: self
                    .schema
                    .values()
                    .iter()
                    .map(|c| c.name.clone())
                    .collect(),
            })
    }

    fn typed(&self, name: &str, want: ColumnKind) -> Result<Option<&Value>> {
        let i = self.index(name)?;
        let kind = self.schema.values()[i].kind;
        if kind != want {
            return Err(PondError::WrongKind {
                call: "LiveEvent",
                column: name.to_string(),
                kind: kind.as_str(),
                reason: format!("this is a {} column, not {}", kind.as_str(), want.as_str()),
            });
        }
        Ok(self.data.values[i].as_ref())
    }
}
