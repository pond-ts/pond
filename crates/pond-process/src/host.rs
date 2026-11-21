//! The long-lived host (`host.ts`) and named data sources (`source.ts`).
//!
//! A [`Host`] keeps one [`BoundGraph`] per dataset and outlives requests,
//! so a second request over the same data is served from what the first
//! one computed. Datasets arrive two ways: added by the host's author
//! ([`Host::add`]), or loaded on demand by a request that names a source
//! ([`Host::run_async`]).

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use pond_rs::TimeSeries;
use serde_json::{Map, Value};

use crate::error::{ErrorKind, ProcessError, Result};
use crate::graph::BoundGraph;
use crate::registry::Registry;
use crate::run::{RunResult, run};
use crate::source::{SourceRef, source_id};

/// What a loader hands back: the data, and a token that changes when the
/// data does. An equal revision keeps every cached node.
#[derive(Clone)]
pub struct LoadedSource {
    /// The loaded series.
    pub value: Arc<TimeSeries>,
    /// Changes when the data changes.
    pub revision: String,
}

/// A loader's answer, some time later.
pub type LoadFuture = Pin<Box<dyn Future<Output = Result<LoadedSource>> + Send>>;

/// A loader: the request's params, and the last load of the same source
/// (when there was one), in; the data out.
pub type LoadFn =
    Arc<dyn Fn(&Map<String, Value>, Option<&LoadedSource>) -> LoadFuture + Send + Sync>;

/// Named sources and how to load each.
#[derive(Clone, Default)]
pub struct SourceRegistry {
    sources: Vec<(String, LoadFn)>,
}

impl SourceRegistry {
    /// An empty registry.
    pub fn new() -> Self {
        SourceRegistry::default()
    }

    /// Adds (or replaces) a source.
    pub fn define(mut self, name: impl Into<String>, load: LoadFn) -> Self {
        let name = name.into();
        match self.sources.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = load,
            None => self.sources.push((name, load)),
        }
        self
    }

    /// Loads a source request.
    pub async fn load(
        &self,
        r: &SourceRef,
        previous: Option<&LoadedSource>,
    ) -> Result<LoadedSource> {
        let Some((_, load)) = self.sources.iter().find(|(n, _)| *n == r.source) else {
            let have = self
                .sources
                .iter()
                .map(|(n, _)| format!("'{n}'"))
                .collect::<Vec<_>>();
            let have = if have.is_empty() {
                String::new()
            } else {
                format!(" — have {}", have.join(", "))
            };
            return Err(ProcessError::new(
                ErrorKind::UnknownSource,
                format!("unknown source '{}'{have}", r.source),
            ));
        };
        load(&r.params, previous).await
    }
}

/// One dataset as [`Host::datasets`] reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct DatasetInfo {
    /// The dataset's id.
    pub id: String,
    /// Its row count.
    pub rows: usize,
    /// Its value columns.
    pub columns: Vec<String>,
    /// Nodes compiled against it so far.
    pub nodes: usize,
}

/// Holds datasets and their graphs across requests.
pub struct Host {
    registry: Arc<Registry>,
    units: Arc<HashMap<String, String>>,
    budget_bytes: Option<usize>,
    threads: usize,
    max_sources: Option<usize>,
    /// In the order they were first added.
    sources: Vec<(String, Arc<TimeSeries>)>,
    graphs: HashMap<String, BoundGraph>,
    source_registry: Option<SourceRegistry>,
    /// Least recently used first: the order the source cap evicts in.
    loaded: Vec<(String, LoadedSource)>,
}

impl Host {
    /// A host over a registry of ops. `units` gives a unit to raw columns
    /// (`{"close": "price"}`).
    pub fn new(registry: Arc<Registry>, units: HashMap<String, String>) -> Self {
        Host {
            registry,
            units: Arc::new(units),
            budget_bytes: None,
            threads: 1,
            max_sources: None,
            sources: vec![],
            graphs: HashMap::new(),
            source_registry: None,
            loaded: vec![],
        }
    }

    /// Caps what each graph keeps, in bytes. A host whose plans come from
    /// callers it does not control should set this.
    pub fn with_budget_bytes(mut self, bytes: usize) -> Self {
        self.budget_bytes = Some(bytes);
        self
    }

    /// Lets a run compute the steps that do not depend on each other at
    /// the same time, on up to `n` threads (1, the default, computes them
    /// one by one as TypeScript does). The answers are the same either way.
    pub fn with_threads(mut self, n: usize) -> Self {
        self.threads = n.max(1);
        for graph in self.graphs.values_mut() {
            graph.set_threads(self.threads);
        }
        self
    }

    /// Caps how many loaded sources are kept, dropping the least recently
    /// used. Datasets added with [`Host::add`] never count. A host whose
    /// source requests come from callers it does not control should set
    /// this, or every distinct request keeps another graph.
    pub fn with_max_sources(mut self, n: usize) -> Self {
        self.max_sources = Some(n);
        self
    }

    /// Lets requests name sources to load.
    pub fn with_sources(mut self, sources: SourceRegistry) -> Self {
        self.source_registry = Some(sources);
        self
    }

    /// The op registry.
    pub fn registry(&self) -> &Arc<Registry> {
        &self.registry
    }

    /// Adds a dataset, or gives an existing one new data. An existing
    /// graph keeps its nodes; they recompute when next asked for.
    pub fn add(&mut self, id: impl Into<String>, series: Arc<TimeSeries>) -> &mut Self {
        let id = id.into();
        match self.sources.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = series.clone(),
            None => self.sources.push((id.clone(), series.clone())),
        }
        if let Some(graph) = self.graphs.get_mut(&id) {
            graph.set_source(series);
        }
        self
    }

    /// Whether a dataset is held.
    pub fn has(&self, id: &str) -> bool {
        self.sources.iter().any(|(k, _)| k == id)
    }

    /// Every dataset held, in the order first added.
    pub fn datasets(&self) -> Vec<DatasetInfo> {
        self.sources
            .iter()
            .map(|(id, series)| DatasetInfo {
                id: id.clone(),
                rows: series.len(),
                columns: series
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect(),
                nodes: self.graphs.get(id).map_or(0, |g| g.ids().len()),
            })
            .collect()
    }

    /// The graph for a dataset, built on first use and kept.
    pub fn graph_for(&mut self, id: &str) -> Result<&mut BoundGraph> {
        if !self.graphs.contains_key(id) {
            let Some((_, series)) = self.sources.iter().find(|(k, _)| k == id) else {
                let have = self
                    .sources
                    .iter()
                    .map(|(k, _)| format!("'{k}'"))
                    .collect::<Vec<_>>();
                let have = if have.is_empty() {
                    String::new()
                } else {
                    format!(" — have {}", have.join(", "))
                };
                return Err(ProcessError::new(
                    ErrorKind::UnknownDataset,
                    format!("unknown dataset '{id}'{have}"),
                ));
            };
            let mut graph = BoundGraph::new(
                series.clone(),
                self.registry.clone(),
                self.units.clone(),
                self.budget_bytes,
            );
            graph.set_threads(self.threads);
            self.graphs.insert(id.to_string(), graph);
        }
        Ok(self.graphs.get_mut(id).expect("just inserted"))
    }

    /// Forgets a dataset, its graph and everything cached in it. Returns
    /// whether it was held.
    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.sources.len();
        self.sources.retain(|(k, _)| k != id);
        self.graphs.remove(id);
        self.loaded.retain(|(k, _)| k != id);
        self.sources.len() != before
    }

    /// Runs a request whose `from` names a dataset already held.
    pub fn run(&mut self, request: &Value) -> Result<RunResult> {
        let from = request
            .get("from")
            .map(crate::js::js_string)
            .unwrap_or_default();
        let graph = self.graph_for(&from)?;
        run(graph, request)
    }

    /// Runs a request whose `from` is a dataset id or a source request
    /// (`{ "source": "feed", "params": {…} }`), loading the source first.
    /// The same revision keeps the graph as it was; a new one replaces the
    /// data and its nodes recompute.
    pub async fn run_async(&mut self, request: &Value) -> Result<RunResult> {
        let Some(Value::Object(from)) = request.get("from") else {
            return self.run(request);
        };
        let r = SourceRef {
            source: from
                .get("source")
                .map(crate::js::js_string)
                .unwrap_or_default(),
            params: from
                .get("params")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        };
        let Some(registry) = self.source_registry.clone() else {
            return Err(ProcessError::new(
                ErrorKind::Process,
                format!(
                    "source '{}' cannot load — this host has no source registry",
                    r.source
                ),
            ));
        };
        let id = source_id(&r);
        let at = self.loaded.iter().position(|(k, _)| *k == id);
        let previous = at.map(|i| self.loaded[i].1.clone());
        let loaded = registry.load(&r, previous.as_ref()).await?;
        if let Some(i) = at {
            self.loaded.remove(i);
        }
        match previous {
            Some(p) if p.revision == loaded.revision => self.loaded.push((id.clone(), p)),
            _ => {
                self.loaded.push((id.clone(), loaded.clone()));
                self.add(id.clone(), loaded.value);
            }
        }
        self.enforce_source_cap(&id);
        let mut request = request.clone();
        request["from"] = Value::String(id);
        self.run(&request)
    }

    fn enforce_source_cap(&mut self, current: &str) {
        let Some(max) = self.max_sources else { return };
        while self.loaded.len() > max {
            let oldest = self.loaded[0].0.clone();
            if oldest == current {
                break;
            }
            self.remove(&oldest);
        }
    }
}
