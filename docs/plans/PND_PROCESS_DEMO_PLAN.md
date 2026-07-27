# PND_PROCESS_DEMO_PLAN — the process demo

> Breakout plan for the **process demo** roadmap section in
> [PLAN.md](../../PLAN.md). Sibling of
> [PND_PROCESS_PLAN.md](PND_PROCESS_PLAN.md), which carries the library
> tickets; design rationale is in [process.md](../rfcs/process.md).

## What this is for

A three-panel web app — **composer / request / results** — where you type
what you want to see, an agent emits a process plan as JSON, the plan is
resolved against a bound dataset, and the result is charted. Clicking a
node in the pipeline shows that node's output.

It is a demo, but its **primary job is to decide the library's shape**.
Six tickets in the sibling plan are open on questions that cannot be
settled by argument, and every one of them is a question this app asks
concretely:

| Milestone | Decides                                                     |
| --------- | ----------------------------------------------------------- |
| M0        | [PND-PROCSUB], [PND-PROCIDENT]                              |
| M1        | [PND-PROCTERM], and whether the warm-graph claim is real    |
| M2        | [PND-PROCREG] — is the registry schema enough for an agent? |
| M3        | [PND-PROCCOL]'s remainder — how a column reaches a chart    |
| M4        | Nothing new; it is the payoff that justifies the graph      |
| M5        | [PND-PROCCACHE], and [PND-PROCIDENT] again, empirically     |

This follows the repo's experiment method ([CLAUDE.md](../../CLAUDE.md) →
_Multi-agent experiments_): build like you are really building, let pain
surface where it falls, and land the result as a how-to guide.

---

## Decisions to pin before any code

**1. The graph is long-lived — wherever it lives.**

The invariant is that the bound graph **outlives requests**. A graph
constructed per request starts cold, and a cold graph is a fold with extra
steps: every measurement behind these tickets (1.34–1.40× on MCP flurries,
441× on memoized facts, 14.3× on the op cache) assumes a warm binding.
What is fatal is per-request construction, not any particular host.

Two topologies satisfy that, and they prove **different** things:

| Topology                      | Proves                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Long-lived **worker**         | pond runs entirely client-side; decode / ingest / resolve stay off the main thread |
| Long-lived **server** process | the MCP shape; one cache shared across sessions and clients                        |

The worker is the more interesting demo, and it has a measurable product
(`scripts/rfc543-worker-transfer.mjs`): while the worker computes for
600 ms, the main thread keeps **~90% of a free 10 ms timer**. A UI that
stays live through a 300 ms aggregate is a claim you can see.

**The worker topology is coupled to [PND-PROCCOL], and cannot ship
without it.** Every answer crosses a thread boundary, and the cost
depends entirely on how a node value is represented — 500k values:

| Crossing                         | per message |
| -------------------------------- | ----------- |
| boxed `Array<number\|undefined>` | 48.6 ms     |
| `Float64Array`, structured clone | 0.8 ms      |
| `Float64Array`, transferred      | 0.5 ms      |

**63× cloned, 99× transferred.** A boxed array is cloned element by
element and re-boxed on arrival; a packed column is one buffer, and a
transferred one changes owner with no copy at all. At 48.6 ms per answer
a worker would spend more time marshalling than computing, and the
topology would be a net loss. With columns it is nearly free.

That is a second argument for column-valued nodes, independent of the
memory one, and it only appears once execution crosses a thread.

Note the demo needs a server regardless — the agent call needs somewhere
to hold a key. So "worker or server" is about where **execution** lives,
not whether there is a backend.

**2. The envelope.**

```jsonc
{
  "from": "historical_5m_price", // dataset id — the binding key
  "process": {
    /* plan */
  },
  "as": "last_30m", // a NAME for the output, not a window
}
```

`as` names the result so a later prompt can refer to it. It is
deliberately **not** a time window: windowing is a selection and belongs
in the plan, or the request would have two places that slice time and
they would eventually disagree.

`from` is the multi-source hook. Widening it to `["AAPL_5m", "SPY_5m"]`
later is [PND-PROCJOIN]; shape the envelope so that is an addition rather
than a break.

**3. The registry's JSON Schema is the agent's contract.**

Not a hand-maintained prompt. `registry.toJsonSchema()` with a recursive
`$ref: '#/items'` on `inputs` is what lets an agent express _EMA of SMA of
px_ without being taught a nesting concept. Prototyped and working in
`scripts/rfc543-plan-layer.mjs`.

**4. `onError: 'collect'` everywhere in the demo.**

An agent will emit invalid plans. They must come back as `skipped`
entries with reasons the agent can read and retry against — never an
opaque failure. The failure policy already covers selection as well as
resolution.

---

## Milestones

### M0 — The plan layer, headless

**No UI, no server.** The library surface the rest depends on.

- `bind(source, { registry, units })` → a graph bound to one dataset
- `registry` — `defineOp`, `byFamily()`, `describe()`, `toJsonSchema()`
- `specId(spec)` — canonical, versioned, param-order invariant
- `run(graph, { plan, select, onError })` → `{ series?, outputs, facts, explain, skipped, computed }`
- `explain(plan)`

Most of this exists as prototype in
`packages/process/scripts/rfc543-plan-layer.mjs` and
`rfc543-step0.mjs`; M0 is making it real, typed, and tested.

**Decides [PND-PROCSUB]** by forcing the question: once the plan layer
exists, is the engine still worth exporting separately? The answer will
be obvious from whether anything outside `src/plan/` imports it.

**Decides [PND-PROCIDENT]** the same way — a param is either part of
`specId` or an inlet, and `run()` cannot be written without choosing.

**Carry forward from the investigation:** node values are **columns**
([PND-PROCCOL], landed); the terminal must resolve the **closure** of every
id a selector mentions, not just the `columns: true` ones; and `specId`
must be invariant under param key order and collide with explicit
defaults, or a saved plan and a fresh one miss each other in cache.

**Done when:** the Appendix A plan resolves from a JSON **string**, ids
are stable across a round trip, and an invalid plan yields reasons.

---

### M1 — A long-lived host, one dataset, raw results

One bound graph in a long-lived host — a worker or a server process, per
decision 1. Submit the envelope, get JSON back. Still no UI.

- `Map<datasetId, BoundGraph>`, built on first use, outliving requests
- If the worker topology: node values cross as transferred buffers, never
  boxed arrays (63–99×, see decision 1)
- One seeded dataset (5m bars, enough rows that caching is visible —
  100k+)
- Response includes **per-node `computed` vs `cached` and a duration**

That last bullet is not decoration. The entire architecture is invisible
without it, and it is the thing that turns a nice UI into a demo that
explains itself. The graph already knows; surface it.

**Decides [PND-PROCTERM]:** the response shape falls out of what the
server actually needs to send. Expect facts to read node values directly
and assembly to be requested — measured at 52× and 441×.

**Done when:** the same plan posted twice shows every node `cached` on the
second call, with a visible time difference.

---

### M2 — Three panels, raw only

The UI, with `raw` tabs and no charts yet.

- **Composer** — prompt box, clear button, history
- **Request** — the emitted JSON, pretty-printed
- **Results** — the response JSON

The agent turns a prompt into `{ from, process, as }` using
`registry.toJsonSchema()` and `registry.describe()`.

**Decides [PND-PROCREG]:** whether the schema projection is sufficient for
an agent to compose valid plans unaided, and how much of JSON Schema is
worth projecting. If the agent needs prose hand-holding beyond `summary`
and param metadata, the registry is under-specified.

**Watch for:** how often the agent invents an op that does not exist, and
whether `skipped` reasons are good enough for it to self-correct on a
retry. Both are friction notes.

**Done when:** a plain-English prompt produces a plan that resolves,
including at least one nested spec.

---

### M3 — Results visualisation

Charts, via `@pond-ts/charts`, chosen by key kind:

| Key kind             | Chart |
| -------------------- | ----- |
| `time`               | line  |
| `interval` / `range` | bar   |
| multi-output op      | band  |
| non-series           | JSON  |

The band case is worth calling out: a bollinger is **one** `outputs` entry
with three columns, so the renderer knows to draw a band rather than three
unrelated lines. That is the multi-output naming decision paying off.

**Decides [PND-PROCCOL]'s remainder:** how a column value reaches a chart.
`appendColumn` (landed) assembles a series; per-column arrays avoid
assembly entirely. The chart layers currently take a `TimeSeries` plus a
column name, which points at assembly — but assembly is the expensive
path, so this is a real fork and the UI is where it gets decided.

**Sharp edge:** `@pond-ts/charts` layers take only `TimeSeries`, which is
[PND-LIVELYR] in the charts section. If it bites here, it is the same
issue from a new direction and should be reported there.

---

### M4 — Request visualisation, and node output inspection

The pipeline as a graph, with clickable nodes.

**Library: [React Flow](https://reactflow.dev) (`@xyflow/react`) plus
[dagre](https://reactflow.dev/examples/layout/dagre) for layout.** React
Flow ships no layout engine deliberately; dagre is the simpler choice for
DAG shapes and elkjs the more configurable one. React Flow is chosen for
**clickable nodes and zoom/pan out of the box**, which is a hard
requirement here rather than a nicety. Their
[playground](https://xyflow.com/labs/react-flow-playground) compares the
layout options.

- Node label = `explain(spec)` — the lineage string, already derived
- Node badge = `cached` / `Nms` from M1
- Click a node → the results panel shows **that node's output**, through
  the same M3 rendering

**This is the demo's payoff and it costs almost nothing**, because every
intermediate is already a named, cached, addressable value. In a fold you
would have to deliberately retain intermediates and invent names. That
asymmetry is the clearest argument the graph has, and it is worth staging
the demo to land on it.

---

### M5 — Conversational refinement

Follow-up prompts that adjust an existing plan: "smoother", "try 50
instead", "add a slower one".

**Decides [PND-PROCCACHE] and re-decides [PND-PROCIDENT] empirically.**
Say "smoother", then "back to how it was" — does the second return
instantly? That is precisely the content-addressed vs params-as-Ins
question, answered by watching rather than arguing. Measured cold: 14.3×
when the cache covers the working set, 1.9× when it thrashes at capacity 3
— so the demo should expose the capacity and let it be tuned badly on
purpose.

---

## Risks worth naming up front

- **Cold-graph demo.** Covered by decision 1; it is listed again because
  it is the failure mode that would quietly gut the whole thing.
- **Hot leading edge.** If the demo uses live-updating data, an 8-study
  stack over 500k rows is ~765 ms/tick and saturates at ~1.3 ticks/sec.
  Use `requiredHistory(plan)` ([PND-PROCHIST]) to slice a sufficient tail
  — 5.4 ms/tick over 5k rows — rather than discovering this on stage.
- **Naive assembly.** Assembling a `TimeSeries` per request costs ~O(rows)
  even on a pure cache hit. Facts must read node values directly
  ([PND-PROCTERM]).
- **Agent-invented ops.** Guaranteed. The registry schema plus
  `onError: 'collect'` is the answer; the friction note is how well it
  self-corrects.
- **Scope.** M0 + M1 are library and server work with no visible output.
  Resisting the urge to start at M2 is the main discipline here — the UI
  cannot decide anything the plan layer has not yet exposed.

## Outputs

Per the repo's experiment method, three:

1. **Friction notes** — driving tickets in
   [PND_PROCESS_PLAN.md](PND_PROCESS_PLAN.md).
2. **Measurements** — extending `packages/process/scripts/`, especially
   the warm-vs-cold numbers M1 makes visible.
3. **A how-to guide** in `website/docs/how-to-guides/`, first-person and
   grounded in the working app.
