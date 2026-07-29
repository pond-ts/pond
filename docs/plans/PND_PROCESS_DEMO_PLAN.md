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
| M2        | [PND-PROCSCHEMA] — is the registry projection enough alone? |
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

**Decides [PND-PROCSCHEMA]:** whether the schema projection is sufficient
for a caller to compose valid plans unaided, and how much of JSON Schema is
worth projecting. If the caller needs prose hand-holding beyond `summary`
and param metadata, the registry is under-specified. It also **confirms
[PND-PROCREG]** in an app rather than a test: the envelope is JSON, and the
process that resolves it never saw the composer.

**Watch for:** how often the caller invents an op that does not exist, and
whether `skipped` reasons are good enough for it to self-correct on a
retry. Both are friction notes.

**Done when:** a plain-English prompt produces a plan that resolves,
including at least one nested spec.

**Landed** in `apps/process-demo` — deliberately outside the root
`workspaces`, following the `workers/` precedent, so a demo build can never
gate a release. Three findings and two library fixes are written up in
[PND-PROCSCHEMA]; the headline is that the projection's recursive `$ref`
was **not embeddable** in a tool schema, silently, because a `$ref`
resolves against the document root. `toJsonSchema({ base })` fixes it.

The composer sits behind a seam with two implementations — a real one and
an offline keyword matcher — so the panels, the run path and the UI are all
exercisable without a key. **The keyword matcher settles nothing about the
registry**, and says so in every response it returns; the schema question
is only answered by a run with `ANTHROPIC_API_KEY` set.

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

**Decided [PND-PROCCOL]'s remainder — and it was not a fork.** The
framing above assumed the layers' `TimeSeries` + column-name signature
pointed at assembly. It does not: charts already traverses columnar (the
key axis is a zero-copy `subarray`, values are a `Float64Array`, nothing
is boxed on the render path), so the signature is satisfied by a series
the **consumer** builds. What was wrong was assembling on the producer
side, where the result cannot cross a wire.

So: `run({ assemble: false })` plus `RunResult.columns`, and the browser
calls `TimeSeries.fromColumns`, which adopts buffers zero-copy and reads
NaN as a gap. Full write-up and numbers in [PND-PROCCOL]; the short
version is that **drawing costs transport, not compute** — 5.72 MB of
buffers for two studies at 150k rows against 5 ms to encode — and that is
a second argument for the worker topology, where the same buffers
transfer in 0.5 ms.

**Landed** as a `raw | viz` tab pair in the results panel. Columns are
fetched **lazily**, on switching to `viz`, because a column is ~1.2 MB
per study and a reduction is a few bytes; the side effect is the clearest
cache demonstration in the app, since every node comes back `cached` and
what you wait for is purely wire.

**The charts API needed nothing.** [PND-LIVELYR] did not bite here.

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

**Landed, and the claim held.** The label is `explain[id]`, the badge is
`nodes`, and clicking a node is one more `columns: true` selector on an id
the response already named — including a **nested** spec that never
appears at the plan's top level, because `select.on` accepts a string id
and a nested spec is in the graph the moment its parent compiled. No new
addressing concept was needed.

Two things did have to be added, and both were the response failing to
describe the graph it had resolved:

- **`NodeTiming.inputs`** — the edges. A consumer cannot derive them:
  the edges live in the specs, and turning a spec into an id means
  reimplementing `specId`'s canonicalization, which is exactly why a
  selector takes an inline spec in the first place.
- **`NodeTiming.pulled`** — `nodes` reported only the subset some
  selector reached, so the pipeline drew a plan with whole branches
  missing. It now reports every resolved node, with `pulled: false` and
  `ms: 0` for one nothing asked for. Reporting it is free: reading
  `node.dirty` produces no value, and a test pins that the unselected op
  never ran.

**App-level note, not a library one.** React Flow's default `minZoom` is
0.5, and a left-to-right DAG three nodes wide hit that floor in a side
panel and clipped. Top-to-bottom is the right layout for a tall narrow
column, and reads the way a pipeline is described anyway.

---

### M5 — Conversational refinement

Follow-up prompts that adjust an existing plan: "smoother", "try 50
instead", "add a slower one".

**Decided [PND-PROCIDENT] empirically. Motivated [PND-PROCCACHE] without
building it.** Say "smoother", then "back to how it was" — does the second
return instantly? **Yes: 75.071 ms cold, 2.811 ms on the return, and the
node itself a straight cache hit at 0.004 ms.** `sma(50)` was never
invalidated by the detour through `ema(200)`; it was simply not asked for.
That is content-addressing's whole case, and under params-as-Ins the same
conversation recomputes on the fourth turn.

The bill shows up in the same run: **three nodes resident afterwards**,
one per distinct spec the conversation passed through, and nothing evicts
the detour. So this shape wants content-addressing _and_ an engine-wide
budget — which is [PND-PROCCACHE], still unbuilt.

**The capacity dial is not here, deliberately.** The plan wanted it
exposed and tuned badly on purpose, but there is no node cache to tune:
[PND-PROCCACHE] is open, and rushing a first cut of it to make a demo
slider work would be letting the demo design the library. M5 answers what
it can answer and leaves PROCCACHE to land on its own evidence — with one
more piece of it, measured here.

Reproducible: `apps/process-demo/scripts/refinement-run.mjs`.

---

### M6 — The agent answers

The app asked a question and showed the material for an answer: a z-score
of `-1.94 σ`, a percentile, a chart. The last step — the one the person
actually asked for — was left to the reader. M6 closes the loop. The
model composes a plan, the engine runs it, **the facts go back to the
model**, and it replies in prose.

Two tools, `emit_request` and `answer`, and a loop of up to four rounds
with the last forced to answer. The reading handed back is **facts only**
— a reduction is a few numbers with a unit; the column behind it is
150,000 points, and `select` exists precisely so a consumer can ask the
graph a question instead of downloading it. A model is that consumer,
several orders of magnitude more expensive per point.

**The reply lands in the composer, not in Results.** It was built into
the Results panel first, which put the answer to a question two panels
away from the question. The composer is a transcript now: prompt, reply,
and the cost line under it, with the selected turn still driving the
plan and evidence panels to its right.

**The engine is 2% of the wall clock.** A seven-fact analysis of
volatility, trend and momentum: **196.03 ms in the engine of 8,825 ms
total**. A follow-up turn is starker still — **`0 computed, 2 cached`,
43.22 ms** against the first turn's 215.3 ms, the whole plan served from
nodes an earlier question built. Everything this library has been optimised for is a rounding
error next to one model call — which is the argument for caching
aggressively and for answering from reductions rather than columns, not
against it. The 8.6 seconds are the budget; the way to spend fewer of
them is to need fewer calls, and that is what a rich `select` buys.

**One round almost always suffices.** The loop was built expecting the
model to look, then look again. It rarely does — because it does not need
to. Asked "whichever of RSI or the 50-bar z-score is more extreme, dig
into that one", it fetched **all four facts in one request** and chose,
rather than fetching two and coming back. That is a result about the
reduction vocabulary: `select` is expressive enough that the branch
collapses into a single plan. The rounds that do happen are the narrow
cases — a rejected plan to retry against, or a value from an earlier turn.

**Zero rounds is a real outcome.** Asked to annualise the price series
directly, the model read the op table, saw the `variance` unit
`annualise` demands, and declined **without running anything** — naming
the chain that would work. The typed input the schema projection cannot
express still did its job, one layer earlier than expected.

#### Friction note: the cache is invisible until you mention it

The sharpest finding, and it is not about the engine. Asked a follow-up —
"is that high or low compared with the rest of the history?" — the model
replied that it _could not_ compare against the previous turn's value
because it did not have that result in hand. The nodes were **still
resident and still free**. It simply had no reason to believe re-asking
was cheap.

Adding one line to the brief — "the cache outlives the turn; if an
earlier result would help, ask for it again" — changed the same follow-up
from a refusal to a full comparison at **`computed=2, cached=3`**. The
capability was there the whole time; nothing exposed it.

So: a response reports `cached` per node _after the fact_, and there is
no way for a caller to ask **what is already resident** before composing.
An agent that could see the resident set would plan differently — reach
for the study it already has rather than the one it would have to build.
That is a registry-adjacent gap worth a ticket, and it is the one thing
this milestone found that a person driving the UI could never have.

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
