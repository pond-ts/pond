# PND_PROCESS_PLAN — `@pond-ts/process`, the declarative processing graph

> Breakout plan for the **`@pond-ts/process`** roadmap section in
> [PLAN.md](../../PLAN.md). Design rationale lives in the RFC
> ([docs/rfcs/process.md](../rfcs/process.md)); this file carries the
> per-task detail, the measurements each task is sized against, and what
> "done" means.

## How the measurements were produced

Every number below came from a runnable script, not an estimate. They are
on `main` under `packages/process/scripts/` (landed with
[#544](https://github.com/pond-ts/pond/pull/544)), and each is
self-contained — run them after `npm run build --workspaces`:

| Script                       | Answers                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `rfc543-plan-layer.mjs`      | Appendix A end-to-end; identity, units, JSON round trip         |
| `rfc543-step0.mjs`           | Proving-path step 0 — forked series, 2-input op, graph vs fold  |
| `rfc543-mcp-workload.mjs`    | MCP flurries at 1M rows; the assembly tax and its bridge        |
| `rfc543-ui-workloads.mjs`    | Interactive params, hot leading edge, value representation      |
| `rfc543-multisource.mjs`     | Separate graphs vs one graph; invalidation at N sources         |
| `rfc543-ranged-dirty.mjs`    | Join-as-a-node, dirty per column, dirty per range               |
| `rfc543-param-ins.mjs`       | Content-addressed vs params-as-Ins; selective Out invalidation  |
| `rfc543-op-cache.mjs`        | Two modes of In; node-level cache; per-op vs engine-wide budget |
| `rfc543-column-values.mjs`   | Boxed arrays vs columns as node values; read-path timings       |
| `rfc543-worker-transfer.mjs` | Cost of crossing a worker boundary per representation           |
| `demo-m3-render-path.mjs`    | What it costs to get a node's column onto a chart (M3)          |

If the package is restructured or withdrawn (see [PND-PROCSUB]), these
should move with it — they are the evidence base for every decision here.

**Two measurement traps, both hit while producing these numbers**, worth
knowing before trusting or extending them:

1. Comparing two representations inside one process gives GC-dominated,
   sometimes negative deltas. Run one configuration per process, with
   `--expose-gc` and an explicit `global.gc()` before reading
   `memoryUsage()`.
2. `Float64Array` backing stores are **not** in `heapUsed` — they land in
   `arrayBuffers` / `external`. Reading heap alone once reported an
   identical 21 MB for two configurations that actually differed by
   300 MB. Report `heapUsed` when the question is GC pressure and
   `arrayBuffers` / `rss` when it is footprint; they answer different
   questions and the gap between them is the whole point of
   [PND-PROCCOL].

---

## Tasks

### [PND-PROCIDENT] — Node identity and lifetime: content-addressed, or params-as-Ins?

_Supersedes an earlier "add an LRU eviction policy" framing, which
misdiagnosed the cause. Recorded here rather than silently rewritten,
because the wrong diagnosis is instructive._

**The original observation:** a user dragging a study's `period` through
20 positions left 20 permanently-cached nodes and +457 MB. **The wrong
conclusion:** the graph needs eviction.

**What review established.** That leak was not the graph. It was the plan
layer's global `specId -> node` map, in which every slider position is a
new id and nothing is ever dropped. The engine itself already localizes
caching to a node's products — `Outlet` holds its own `#value` /
`#version` and `produce()` bumps only on change (`src/port.ts`). There is
no global store in the engine to leak; the prototype added one.

**The real question is how identity is assigned**, and the two answers
have different lifetimes:

- **Content-addressed** (params are part of the id). Accumulates by
  design: a later question repeating an earlier one _should_ hit cache.
  Correct for the MCP shape, where questions pile up and overlap.
- **Params-as-Ins** (a param arrives through an inlet; changing it
  invalidates the node's Outs rather than minting a node). Bounded by the
  plan's shape rather than the history of values passed through. Correct
  for the interactive shape, where a superseded slider position is
  worthless.

Measured, 200-position sweep at 200k rows, one mode per process:

|                   | nodes | heap  | arrayBuffers | rss    |
| ----------------- | ----- | ----- | ------------ | ------ |
| content-addressed | 200   | 21 MB | 310 MB       | 452 MB |
| params-as-Ins     | 1     | 21 MB | 6 MB         | 234 MB |

~50× less buffer memory, and **flat in sweep length instead of linear**.

**The opposition dissolves — two modes of In.** Review proposed keeping
params as Ins _and_ letting a node hold an internal cache keyed by them,
bounded by a preallocated capacity rather than by history:

- a **value In** holds a value and drives downstream invalidation;
  superseded values are discarded;
- a **cache-key In** additionally keys a node-level cache, because
  repeats are expected, and is evicted under a budget.

That gives the MCP shape its repeat hits and the interactive shape its
bounded memory, without choosing. Measured on a repeat-heavy access
pattern (120 accesses over 7 distinct periods, 200k rows):

| mode                 | time  | computes | hits | evictions |
| -------------------- | ----- | -------- | ---- | --------- |
| value In only        | 57 ms | 98       | 0    | 0         |
| cache-key In (cap 8) | 4 ms  | 7        | 91   | 0         |
| cache-key In (cap 3) | 30 ms | 56       | 42   | 53        |

**14.3× when capacity covers the working set**, and the capacity-3 row is
the warning: undersized, it thrashes back to 1.9×.

A cache hit does **not** cut the downstream cascade, and should not —
going back to `period=20` genuinely changes what a consumer must see, so
rerunning is correct. What the cache saves is the study recompute, which
is the expensive half.

So a plan with `sma(20)` and `sma(50)` has two entries and two nodes
either way, while a slider passing through 30 values has one node and at
most `capacity` cached results.

**Measurement trap, for whoever picks this up:** `Float64Array` backing
stores are not in `heapUsed`. Reading heap alone reported 21 MB for both
modes and hid a 300 MB difference. Use `arrayBuffers` / `rss`, one
configuration per process. This gets sharper under [PND-PROCCOL].

**Decided for the conversational shape, by watching (M5).** A four-turn
refinement against a real model, 150k bars, one long-lived host
(`apps/process-demo/scripts/refinement-run.mjs`):

| turn                       | plan       | node                   | total     |
| -------------------------- | ---------- | ---------------------- | --------- |
| "a 50-bar moving average…" | `sma(50)`  | **computed** 64.729 ms | 75.071 ms |
| "smoother"                 | `ema(50)`  | **computed** 16.001 ms | 21.225 ms |
| "try 200 instead"          | `ema(200)` | **computed** 17.999 ms | 25.892 ms |
| "back to how it was"       | `sma(50)`  | **cached** 0.004 ms    | 2.811 ms  |

**27× end to end on the return trip, and the node itself is a straight
cache hit.** That is the whole argument for content-addressing in one
run: `sma(50)` was never invalidated by the detour through `ema(200)` —
it was simply not asked for — so coming back is free. Under
params-as-Ins the same conversation is one node whose param changed
twice, and the fourth turn recomputes.

And the bill is visible in the same run: **three nodes resident
afterwards**, one per distinct spec the conversation passed through.
Nothing evicts the detour. So the conversational shape wants
content-addressing _and_ [PND-PROCCACHE]'s engine-wide budget; it does
not want params-as-Ins.

The interactive-slider shape still wants the opposite, which is what the
two-modes-of-In proposal above is for. M5 does not overturn that — it
establishes that the two shapes are genuinely different, with a measured
case for each.

**Done when:** identity and node lifetime are a stated, tested policy, and
a 200-position sweep at 1M rows holds steady-state memory under whichever
policy the interactive consumer gets.

---

### [PND-PROCCACHE] — Op-level result cache under an engine-wide budget

Falls out of [PND-PROCIDENT]'s two modes of In. An op that expects repeat
values on a param should memoize on it — but **where the budget lives is
not the op's call.**

Measured, 20 nodes each holding 5 entries of a 200k-row result:

| policy      | entries | arrayBuffers |
| ----------- | ------- | ------------ |
| per-op cap  | 100     | 157 MB       |
| engine-wide | 10      | 35 MB        |

A per-op capacity is a per-op promise; nothing supervises the total, so
memory scales with node count. The split that works:

- **The decision to cache is per-op.** Only the op knows what is
  expensive and which Ins genuinely key the result (a `period` does, a
  display flag does not).
- **The capacity is engine-wide.** One LRU shared across nodes, so the
  process has a bound rather than a sum of promises.

**Shape:** declare it on the port — `port({ cacheKey: true })` — plus a
graph-level budget, and have the engine build the key and consult the LRU
around `compute`. That keeps every op from hand-rolling the same cache,
and each hand-rolled one is a place to leak. Prototype in
`rfc543-op-cache.mjs` (`withOpCache` + `CacheBudget`) is ~40 lines and
sized the numbers above.

**Open:** bound by entry count or by bytes. Bytes is the meaningful unit
and only becomes knowable under [PND-PROCCOL].

**Done when:** an op opts in by declaration, the budget is graph-level and
configurable, and a repeat-heavy sweep holds steady-state memory while
still hitting cache.

---

### [PND-PROCSEL] — Selective Out invalidation: document it, and give ops the hook

**Already works on the engine as it stands**, which was not expected and
should be written down before someone "fixes" it away.

A node may decide, per-Out, what a change touched. Worked example: a
bollinger-shaped node where `middle` depends only on `period`, and
`upper`/`lower` on `period` + `stdDev`. Changing `stdDev` alone:

    middle version 1 -> 1   (unchanged — its consumer did not rerun)
    upper  version 1 -> 2   (changed — its consumer reran)

The mechanism is that the op returns the **same array instance** for
`middle` when `period` did not move, so `produce()`'s `Object.is` check
declines the version bump and everything downstream of that Out skips.

**This sharpens the RFC's v3 correction.** "The version-stamp cutoff
cannot fire" holds for whole-series values compared by identity. Per-Out,
with a cooperating op, the cutoff **is** the mechanism that expresses
selective invalidation — so it should be described that way rather than
written off at this layer.

**Shape:** the registry should let an op declare which params each output
depends on, so the plan layer can do this for the corpus instead of every
op hand-rolling an instance-reuse cache. `outputs: [{ id: 'Middle',
dependsOn: ['period'] }, …]` is enough to generate it. Composes with
[PND-PROCJOIN]'s per-column dirty, which is the same idea one level up.

**Done when:** the corpus's multi-output studies (bollinger, envelope)
invalidate per-output, driven by declaration rather than by hand.

---

### [PND-PROCCOL] — Node values are columns, not JS arrays

**Partly landed.** `packColumn` / `columnBytes` / `appendColumn` ship in
`src/column.ts` with 11 tests. What remains is the plan layer using them,
which waits on [PND-PROCSUB].

An op computes a study by calling the corpus, which returns a
`TimeSeries` whose new column is already packed. The naive adapter
unpacks that into a boxed `Array<number | undefined>` as the node value.
Keeping the `Column` instead avoids the unpack.

Measured on **real study output** — 20 SMAs over 500k rows, one mode per
process. This supersedes an earlier synthetic figure (160 MB vs 3 MB
heap) which overstated the effect:

|              | heapUsed | arrayBuffers | rss    |
| ------------ | -------- | ------------ | ------ |
| boxed arrays | 271 MB   | 39 MB        | 466 MB |
| columns      | 42 MB    | 93 MB        | 353 MB |

**6.5× less GC-managed heap** (which is what becomes pause time) and
**1.3× smaller overall** — the bytes move to `arrayBuffers` rather than
vanishing. Both framings matter; neither alone is honest.

**A read-speed claim in the original ticket was wrong.** It asserted the
boxed form "re-boxes on every later scan". Measured, folding a max over
500k cells:

    max over boxed array        0.91 ms
    max over column.scan        4.27 ms
    max over buffer + bitmap    0.96 ms

The representation is **not** faster to read — a direct buffer walk only
reaches parity with the boxed array. And `Column.scan()` is **4.7×
slower than either**, because it takes a callback per cell. So the case
for columns here is memory and sizeability, not read throughput, and any
reduction on the hot path should walk `toFloat64Array()` plus the
validity bits rather than call `scan`. Worth carrying to core, whose
design principles recommend `scan` as the columnar read path.

**Why it is still a force multiplier.** A boxed array has no knowable
retained size, so a bytes-bounded cache ([PND-PROCCACHE]) cannot exist
over it; `columnBytes` reported 77 MB across the 20 values above. And
preallocated packed buffers are what lift the ranged-recompute ceiling
([PND-PROCRANGE], where reallocation was 99% of residual per-tick cost).

**A third argument, which only appears once execution crosses a thread.**
If the graph lives in a worker ([PND-DEMOM1]), every answer is
marshalled. 500k values: **48.6 ms** boxed, **0.8 ms** as a
structured-cloned `Float64Array`, **0.5 ms** transferred — 63× and 99×.
A boxed array is cloned element by element and re-boxed on arrival; a
packed column is one buffer, and a transferred one changes owner without
a copy. At 48.6 ms per answer the worker topology would spend more time
marshalling than computing, so **that topology cannot ship without this
ticket**.

**Core gap found while building this.** `withColumn` takes values, not a
column, and rejects non-finite cells — so a **gapless** column
round-trips through `toFloat64Array()` with no boxing, but a column with
a warm-up gap must be boxed on the way back in. Core appends columns
directly (`withColumnAppended`) but does not expose it. Until it does,
`appendColumn` pays one boxing pass for gapped columns, which is most
studies — another reason assembly should be requested rather than assumed
([PND-PROCTERM]). Also note `createValidityBitmap` is internal;
`ValidityBitmap` is a structural interface, so `packColumn` implements it
outside core rather than reaching in.

**The remainder, decided in M3.** The demo plan framed the last open
question as a fork — an assembled `TimeSeries` versus per-column arrays
into a chart layer. **It is not a fork, and the framing was wrong.**

`@pond-ts/charts` already traverses columnar: the key axis is a zero-copy
`subarray` over the key buffer (`charts/src/data.ts:244`), values land in
a `Float64Array`, d3-shape passes typed arrays through untouched, and no
per-row object is allocated anywhere on the render path. The layers'
`series` + `column` signature was never the problem.

What was wrong was assembling on the **producer** side. A `TimeSeries`
cannot cross a wire, so a server that builds one has done work its
consumer can never use. The answer is that **columns are the wire shape
and the assembled series is the in-process convenience**:

- `run({ assemble: false })` skips `appendColumn` entirely;
- `RunResult.columns` hands back the resolved columns by name;
- the consumer calls `TimeSeries.fromColumns`, which **adopts a
  `Float64Array` zero-copy** and reads NaN as a gap — so reassembly on
  the far side costs nothing.

Measured (`scripts/demo-m3-render-path.mjs`), per column:

| rows | `appendColumn` gapless | `appendColumn` gapped | charts' `read(i)` walk |
| ---- | ---------------------- | --------------------- | ---------------------- |
| 150k | 1.16 ms                | 2.38 ms               | 0.73 ms                |
| 1M   | 7.64 ms                | 22.44 ms              | 5.24 ms                |

**2.9× for the gapped path at 1M, and every rolling study is gapped** —
the boxing fallback is the common case, not the edge, and it exists only
because core's `withColumn` takes values rather than a column. Exposing
`withColumnAppended` would remove it; until then `assemble: false` avoids
it altogether for a wire consumer.

**What actually dominates is transport, and that is the new finding.** A
bollinger plus an RSI at 150k rows is 5.72 MB of buffers — ~7.6 MB once
base64'd into JSON — against 5 ms to encode and ~0 ms to resolve warm.
Drawing costs transport, not compute. And it is **forced by charts
decimating client-side**: the layer needs the whole column to choose which
pixels survive, so the whole column has to arrive.

That is a second, independent argument for the worker topology, parallel
to the one already recorded here: the same buffers _transfer_ in 0.5 ms
with no copy. Over HTTP they are 7.6 MB of base64 per redraw. The
alternative for a server topology is decimating server-side to viewport
resolution, which is a real option ([PND-PROCTERM]'s `shape` reduction is
the token-metered version of it) but changes who owns the zoom.

**Core gap, seen from a second direction.** `toFloat64Array()` writes `0`
for a missing cell, so a producer cannot use the bulk reader for a gapped
column _even in Node_ — a warm-up would draw as a plunge to zero rather
than as absent. The `missing` option charts F-2 asks for is needed by
anything that materializes a column, not just charts.

**Done when:** the plan layer's node values are columns, and no
`Array`-of-`undefined` sits on a hot path.

---

### [PND-PROCTERM] — Assemble only when asked; facts and plots read node values

The terminal currently rebuilds a `TimeSeries` so a reduction has a
column to read. That is pure overhead for both real consumers, and two
independent workloads say so:

- **MCP / agent**, 60 questions at 1M rows:

  |                           | total   | median    |
  | ------------------------- | ------- | --------- |
  | assemble, then reduce     | 9539 ms | 67.245 ms |
  | reduce off cached values  | 184 ms  | 3.260 ms  |
  | + memoize by node version | 22 ms   | 0.004 ms  |

  **52× from skipping assembly, 441× with fact memoization.** Answers
  verified identical across all three paths.

- **Interactive UI**, per slider tick at 500k rows: arrays-out median
  48.1 ms / p95 179 ms, versus assembled 51.6 ms / p95 375 ms.

**The fact-cache key is `node.out.value.version`,** and it invalidates
correctly on data change (asserted). This is worth stating precisely
because the RFC's v3 correction is right that the version-stamp _cutoff_
cannot fire for series values — but the version is still an ideal
_validity token_ for anything derived from that node. Different job, same
mechanism. A fold can emulate it with a hand-maintained generation
counter; the graph derives it, and hand-maintained invalidation is the
class of bookkeeping that produced both cache bugs found in v1.

**Shape:** `select` entries resolve against node values directly.
Assembly into one `TimeSeries` becomes an explicit request
(`columns: true`), and A.3's "every resolved column appended" contract
holds only for that path.

**Sharp edge already found:** "needed" is not the same as "selected with
`columns: true`". A reduction reads a column, so its spec must be
resolved too, and `crossings`'s `against` names a second one. An earlier
prototype assembled only the column-selectors and produced a fact with
_no value_ rather than an error — silent, which is worse than a throw.
The terminal must compute the closure of every id any selector mentions.

**Done when:** a facts-only request touches no `TimeSeries` construction,
and a mixed request assembles exactly the closure it needs.

---

### [PND-PROCJOIN] — Join as a node; alignment policy in the id

"One graph per binding" is right for independent plans and has one
specific failure: **it cannot hold a spec whose inputs come from two
sources.** Spread, ratio, beta-vs-benchmark are ordinary finance, not a
corner. Under separate graphs the combination has nowhere to live, so the
consumer does it by hand — and that hand-rolled version has no `specId`,
no cache, no `explain`, no units. Exactly the glue the RFC exists to
delete.

Worse, the obvious hand-roll is **wrong**: two instruments do not share a
time base (halts, holidays, venues). With MSFT missing two sessions,
`AAPL[5]` is 2026-01-10 while `MSFT[5]` is 2026-01-11, so index-wise
combination silently pairs different dates and returns plausible numbers.

**Two findings that shape the design:**

1. **No engine change is needed for multi-source.** `Graph` is a
   read-only view with no per-graph boundary, so nodes already connect
   across bindings; `Graph.from` discovered all 6 nodes spanning two
   sources. Multi-source is a plan-layer decision — `bind({ AAPL: …,
MSFT: … })` with `SOURCE:column` refs, which keeps `specId`
   content-addressed and gives the cross-source spec a real identity:
   `p1:ratio(AAPL:close+MSFT:close;how=inner,period=3)`.
2. **Alignment is semantic and must be a parameter in the id**, because
   it changes the answer: inner join left 4 undefined, as-of left 2. A
   library that picks a default silently picks wrong for someone.

Making the join a **node** (n series in, one aligned column set out) means
alignment happens once, is cached, has an id, and appears in `explain` —
instead of every 2-input op re-implementing it. Per-column dirty then
falls out: a tick in B recomputed `sma(B)` and the ratio and left
`sma(A)` untouched, though both read the same join node.

**Trap for the implementer:** `toRows()` boxes each key as a `Time`
object, so a `Map` keyed on it never matches and a join silently yields
all-`undefined`. Use `keyColumn()`, which yields raw numbers and is the
columnar path regardless.

**Done when:** a cross-source spec resolves, caches, and explains like any
other, with the join policy visible in its id.

---

### [PND-PROCHIST] — `requiredHistory(plan)`

The hot leading edge is the design's worst performance cliff: an 8-study
stack over 500k rows costs **765 ms/tick**, saturating at ~1.3 ticks/sec.
The same stack over a 5,000-row tail runs at **5.4 ms/tick**.

The RFC frames the window as the consumer's call. It should not be a
guess: **the registry knows every op's lookback, so the minimum safe tail
is derivable.** For the measured stack the plan maximum is 200 bars, so
`display range + 200` is provably sufficient.

**Shape:** fold lookbacks over the spec tree, taking the max across the
plan and summing along nesting. IIR ops (`ema`) have no exact finite
warm-up; 4× period is the usual engineering answer and should be declared
per-op rather than assumed by the folder.

**Done when:** `requiredHistory(plan)` returns a bar count a consumer can
slice against, with per-op lookback declared in the registry.

---

### [PND-PROCRANGE] — Dirty per range, and per column

The largest available win, and the one that makes the graph categorically
better than a fold plus a memo. A source records _which rows_ changed; a
node declares its lookback, so an upstream dirty range `[a,b)` becomes
`[a-lookback, b)` here and only that slice recomputes.

Measured, 500k rows, 5 studies, 20 ticks:

|                 | median         |
| --------------- | -------------- |
| full recompute  | 319.5 ms/tick  |
| dirty-per-range | 12.485 ms/tick |

**26×, identical results**, cells recomputed 52,501,050 → 2,507,700.
Verified on a 2-deep chain (sma-of-sma, 25 appends) against a
from-scratch pass.

**The ceiling is far higher than 26×.** Most of the residual 12.5 ms was
the prototype reallocating its output array as length grew; with
preallocated capacity buffers the same five studies run at **0.044
ms/tick**, i.e. ~7000× — which is why [PND-PROCCOL] should land first.

**Locality must be a declared per-op property.** A windowed op (`sma20`)
costs 0.286 ms/tick; a global one (`percentileRank` over all history)
costs 773 ms/tick because its lookback is genuinely `Infinity`. That is
the correct default: an op that declines to declare a lookback gets a
full pass and simply no speedup, never a wrong answer.

**Cost, stated plainly:** the engine's `markDirty()` carries no payload
today, and a node's `compute` is a pure function of its inputs rather
than an incremental update over its previous output. The second is the
deeper change — it makes nodes accumulators rather than views, which is a
real shift in the contract and should be weighed against pond's
"transforms are views or accumulators" principle rather than slipped in.

**Blocked by [PND-PROCKERN].**

---

### [PND-PROCKERN] — A ranged entry point for the financial kernels

Gating dependency for [PND-PROCRANGE]. The kernels are whole-series —
`rollingValues(series, column, reducer, period)`,
`emaValues(series, column, period)` — with no range parameter, so **no
existing op can fill a slice** and none of the ranged speedup is
reachable through the corpus.

**Shape:** a range-aware kernel entry (`rollingValuesInto(out, src,
reducer, period, lo, hi)` or similar) that writes into a caller-owned
buffer. Lands in `@pond-ts/financial`, not here, and is worth doing on
its own merits — it removes a full-array allocation per study call.

**Done when:** at least one corpus study can recompute `[lo, hi)` and
match a from-scratch pass exactly.

---

### [PND-PROCREG] — Plan rehydration across processes

Ids round-trip as strings; a compiled node graph does not. For the
tool-server shape this is fine (plans arrive as specs and compile per
request). For persisted saved views it means recompiling from the stored
plan, which is cheap but should be stated rather than discovered.

Deliberately **not** a `Graph.toJSON`/`fromJSON` pair: half a
serialization format is worse than none. If it lands, the shape is a
`kind` → factory registry plus per-node config in the dump.

**Verified already:** a plan parsed from a JSON string resolves; ids are
stable across param key order and a stringify/parse cycle; an omitted
param collides with its explicit default. Those last two are load-bearing
and should be **requirements, not accidents** — a persisted saved view and
a freshly composed request must land on the same cache entry, which means
`specId` canonicalizes post-defaults with sorted keys.

**Confirmed in an app (M2).** `apps/process-demo` posts a JSON envelope to
a process that never saw the composer, and the plan compiles against a
graph the request did not build. Nothing here needed adding — which is the
result. The remaining half of "plans as data across a boundary" is whether
the _schema_ travels as well as the plan does: see [PND-PROCSCHEMA].

---

### [PND-PROCSCHEMA] — The schema projection is the agent's contract

`registry.toJsonSchema()` is what a caller composes against. If it is
under-specified the caller needs prose hand-holding, and the registry has
failed at its fourth job. M2 put a model-shaped caller in front of it —
the tool schema is the projection, nothing more — and turned up three
things, two already fixed.

**1. `$ref` is root-relative, so the projection was not embeddable.**
`landed` — `toJsonSchema({ base })`. The recursion that makes nesting
expressible (`#/items`, so an input may be a column name _or_ another
spec) resolves against the **document root**. Dropping the projection into
a tool's `input_schema` under `properties.process` left `#/items` pointing
at nothing, and nothing complains: JSON Schema does not require a `$ref`
to resolve, so the failure is silent and shows up as a caller that cannot
express nesting. `base` names the pointer the subschema will live at, and
`$schema` is now emitted only at the root. The demo's own request schema
`$ref`s a _second_ time into `#/properties/process/items` so a selector
names a spec inline, which is the same recursion paying off twice.

**2. The projection does not carry units — in either direction.** Not the
unit an output produces, and not the unit an input _demands_. So a caller
reading only the schema cannot know that `annualise` refuses a raw price,
and will emit a plan that fails the typed-input check. The demo works
around it by rendering `describe()` as a table in the prompt, which is
exactly the "prose hand-holding" this ticket exists to detect. **Open
question, and the real decision:** projecting units into JSON Schema means
either a `description` string per property (advisory, unvalidated, but
free) or a discriminated encoding a validator could enforce (expensive,
and JSON Schema is a projection, not the authority). The measured cost of
_not_ doing it is one skipped spec and one retry, and the reason it
produces is good — see 3.

**3. The reasons are self-correctable; the cascade is noise.** Three
deliberate errors in one plan came back as three distinct entries, each
naming both sides:

```
annualise needs a 'variance' input for 'source', but 'px' is 'USD'
sma.period=1 is below minimum 2
unknown op 'hullMA' — have 'sma', 'ema', 'delta', 'roc', 'rsi', 'stddev', …
```

`unknown op` listing the alternatives is the one that matters most and was
already right. The wart: when a _selector_ names a spec that failed to
compile, the caller gets a second entry — `'p1:annualise(px;…)' is not in
this plan` — for one mistake. It is accurate, and it may still mislead a
caller into fixing two things. Deferred rather than changed mid-milestone;
the fix, if it lands, is to mark the second entry as a consequence of the
first rather than to suppress it.

Also landed alongside, both found by having a UI render the response:

- **`explain` covered only the plan's top level**, while `nodes` covers
  the whole closure — so a nested node's badge rendered a raw id. Now
  populated for every id in `nodes`. M4's pipeline labels read the same
  map, so this would have surfaced there anyway, later.
- **`skipped.spec` dropped `inputs`.** A plan may hold two specs of the
  same op; `{op, params}` alone does not say which one to fix.

### Answered (M5): yes for nesting, after three tries at the recursion

Run against a real model with a real key. **The projection is sufficient
for the thing it was built for**: given the schema and nothing teaching it
a nesting concept, the caller composed `ema(sma(px))` unaided, and later
`annualise(variance(roc(px)))`. The recursive `$ref` does its job.

Getting that recursion to _travel_ took three shapes, and only the third
works:

| ref                           | outcome                                          |
| ----------------------------- | ------------------------------------------------ |
| `#/items`                     | dangles once nested — silently (M2)              |
| `#/properties/process/items`  | passes local validators, **API rejects it** (M5) |
| `#/$defs/spec` + hoisted defs | travels                                          |

The middle row is the instructive one: _"reference can only point to
definitions defined at the top level of the schema."_ So `base` was the
wrong idea and is gone; `toJsonSchema({ defs })` emits the definition and
the caller lifts `$defs` to its own root.

**Three portability rules, none caught by a client-side validator.** Each
came back as a 400 from a live call, and each had passed the SDK's own
`toStrictJsonSchema` locally (`scripts/strict-schema-probe.mts` records
that probe):

- unions must be `anyOf`, not `oneOf` (_"'oneOf' is not permitted"_);
- a `const` must carry its `type` (_"schema must have a 'type' key"_);
- a `$ref` must point at a top-level definition.

**Optionality is where the projection and strict mode genuinely
disagree.** Strict structured outputs require every declared property to
be listed in `required`; the registry's defaults live in _optionality_
("params you omit take their declared defaults"). The resolution is the
one strict mode intends — every param **required and nullable**, `null`
meaning "use the default" — so the default survives as a value the caller
can name rather than a property it can leave out. Handled in the adapter
rather than the projection, because the projection is not strict-mode's
to shape.

**Two prose rules the schema could not express, and the caller broke
both.** This is the finding that generalizes:

- _"every spec you name in `select` must also appear in `process`"_ — it
  selected a `zscore` it had not listed, and got a skip instead of an
  answer;
- _`columns` and `reduce` are exclusive_ — it asked for both, and the
  reduction was silently dropped, so a question got no fact rather than
  an error.

Both are now **fixed in code rather than documented in prose**: an inline
spec resolves whether or not the plan also lists it, and a selector asking
for both gets both. A constraint a schema cannot express will be
violated; the answer is to remove the constraint, not to write it down.

**Still open:** units. The projection carries none, in either direction,
so the demo still renders `describe()` as a table in the prompt. Nothing
in M5 forced a decision, so it stays as recorded above.

**Done when:** a caller composes a plan with at least one nested spec from
the projection alone, with no unit table in the prompt — or the decision is
recorded that units stay out of the projection and belong in `describe()`.

---

### [PND-PROCSLOT] — Caller-assigned slots: separate topology from value

**The observation, from reading a composed plan:** params are part of a
node's id, but they do not change the topology. Move a `period` from 20 to
50 and the plan is structurally identical — same ops, same edges, same
shape — yet every id downstream of the change is different. The format is
using **one identity for two jobs**.

This is [PND-PROCIDENT] restated as a _format_ question rather than an
engine one, which is the more useful framing: the conflation originates in
how a plan is written, not in how the graph stores things.

**Two identities, and they want to be separate:**

|           | Example                               | Stable under a param edit? | Job                              |
| --------- | ------------------------------------- | -------------------------- | -------------------------------- |
| **Slot**  | `bb`                                  | yes                        | names a position in the topology |
| **Value** | `p1:bollinger(px;period=20,stdDev=2)` | no                         | keys the cache                   |

Today only the second exists, and it does both jobs.

**What slots fix, concretely.**

- **`on` stops restating whole specs.** A selector on a three-deep chain
  currently repeats the entire nested structure, and twice over if it wants
  both a column and a fact. `{ "on": "bb" }` replaces it.
- **Refinement becomes a patch.** "Make it 50" is
  `nodes.bb.params.period = 50` rather than a regenerated plan — a diff
  that can be validated against what is already resolved, and far cheaper
  for a model to emit.
- **Sharing becomes declared rather than coincidental.** Two identical
  inline specs dedupe today _because their hashes collide_. That works, but
  it is emergent; `["sma1", "sma1"]` states it.
- **The pipeline view stops re-laying-out on a param change.** Same slots →
  same dagre layout → the badge flips amber and nothing moves. That is a
  far better rendering of "only this recomputed" than the whole graph
  jumping, and M4's view currently does the jumping.
- **Named outputs make a response directly consumable.** Facts come back
  keyed `p1:bollinger(px;period=20,stdDev=2)Upper`, so a requester parses
  an id to find what it asked for. Naming the surfaced outputs removes
  that step — and maps exactly onto the consumer: a Tidal **card** is a
  named output, and on a data refresh it keeps its identity and updates in
  place instead of being re-keyed.

**What must not break.** Content addressing is what makes the cache work
_across_ requests, sessions and callers: a saved view composed months ago
and a freshly composed one land on the same node because the id is
derived, not assigned. Slots are session-local — one caller's `bb` means
nothing to another's.

M5 measured what that is worth. "Back to how it was" returned in
**2.811 ms against 75.071 ms cold**, and only because the original node was
still resident under its content-addressed id. If slots _replaced_ content
addressing, that return would recompute.

So: **slots are an alias layer; `specId` stays the cache key.** Both
belong in the response, so a consumer can key its UI on the slot and its
cache reasoning on the id.

**Proposed shape:**

```jsonc
{
  "from": "ACME_5m",
  "as": "bands_and_stretch",
  "nodes": {
    "bb": { "op": "bollinger", "params": { "period": 20 }, "in": ["px"] },
    "z": { "op": "zscore", "params": { "period": 20 }, "in": ["px"] },
  },
  "outputs": {
    "upper_band": { "on": "bb", "output": "Upper", "reduce": "last" },
    "stretch": { "on": "z", "reduce": "percentileRank" },
    "band_series": { "on": "bb", "columns": true },
  },
}
```

`as` names the request; `outputs` names its parts.

**Decision — connections live on the node, not in a separate `edges`
list.** A separate edge list can express graphs the ops cannot accept
(wrong input count, edges to nowhere), so it has to be validated against
the node definitions anyway; arity is a per-op property and belongs where
it can be checked once. The case for a standalone edge list is a **full
node editor**, where a user drags connections independently of nodes —
and the consumer does not want one. Tidal adds studies onto raw metrics
and adds cards over facts; it does not rewire a DAG by hand. Revisit only
if that changes.

**Open — how an input reference is disambiguated.** An input string is a
source column name today. With slots it could be either, and a slot named
`px` would shadow the column. Cheapest resolution is to reject slot ids
that collide with a bound source's column names at compile time, with a
reason naming both sides. A sigil (`"@bb"`) also works but introduces
syntax to a format that currently has none. Prefer the validation.

**Migration.** Additive: `nodes` + `outputs` alongside the existing
`process` + `select`, with the old form retained until the composer and
the demo have moved. `specId` and the whole resolution path are unchanged
— this is a naming layer over them, not a replacement.

**Done when:** a plan authored with slots resolves to the same node ids as
the equivalent nested plan; a param edit changes an id but not a slot; the
response reports both; and a follow-up expressed as a patch hits cache
exactly as the full re-compose does.

**Landed.** Expansion only — a slot graph becomes the nested `Spec` form
the resolver already handles, so ids match by construction and neither
`compile` nor `specId` learned anything. Verified at 150k bars
(`apps/process-demo/scripts/slots-equivalence.mts`): a nested plan
computes in 52.8 + 13.8 ms, and the slot form of the same graph returns
**every node cached at 0.002 ms** — the cache one built is the cache the
other hits. A `period` edit from 50 to 80 moves both ids and leaves the
slots `avg` / `smooth` untouched.

The collision decision was taken as written: a slot may not take a
column's name, and the reason names both sides. Cycles report as a path
(`slot cycle: a → b → a`) rather than a stack overflow. `on` still
accepts an id string, so a follow-up can cite what the last response
returned without re-deriving it.

---

### [PND-PROCBUILD] — A programmable API that emits a plan

Plans-as-data is right for a wire format and required for a cache key, but
it is not how an application wants to _author_ a graph. A consumer
building studies over its own metrics in application code should not be
assembling nested JSON by hand.

**Slots are what make this possible**, which is why it depends on
[PND-PROCSLOT] rather than standing alone: a builder needs a stable handle
to refer back to, and a content-addressed id cannot be one — it changes
the moment a param does. A slot is exactly a handle.

```ts
const g = plan('ACME_5m');
const bb = g.add('bb', 'bollinger', { period: 20 }, ['px']);
const z = g.add('z', 'zscore', { period: 20 }, ['px']);

g.expose('upper_band', bb.output('Upper').last());
g.expose('stretch', z.percentileRank());
g.expose('band_series', bb.columns());

await host.run(g.toJSON()); // the same envelope a model would emit
```

**The builder emits the plan; it does not replace it.** One resolution
path, one cache, one thing to test — and a graph built in code and one
composed by a model land on the same nodes. That is also the cheapest way
to keep the two honest: the builder's output is a plan, so the existing
plan tests cover it.

**Open questions.**

- **How typed?** The registry already carries `ParamDef` per op, so
  `params` could be typed per op name via a generated or inferred map.
  That is the difference between a convenience wrapper and something worth
  the dependency — but it constrains how ops are registered, and the
  registry is currently a runtime object.
- **Where it lives.** A builder that imports the registry is a different
  dependency shape from one that takes a registry as an argument. The
  latter keeps `@pond-ts/process` free of the op corpus; see
  [PND-PROCSUB].
- **Does it need to resolve?** A builder that can answer "what id will
  this be" locally would let a consumer pre-compute cache keys — but that
  means shipping `specId` to the client, which may be fine and may be a
  compatibility surface nobody wants to own.

**Done when:** a graph built in application code and the equivalent
model-composed JSON resolve to identical node ids, and the builder has no
resolution logic of its own.

**Landed**, both conditions met and pinned by tests: `toJSON()` is
compared field-for-field against the hand-written envelope, and the two
are run against the same graph to confirm identical ids and facts. The
builder holds no registry reference, so op names and params are still
diagnosed in exactly one place.

`add` returns a handle rather than a name, and a handle is what you pass
as another node's input — which is the compile-time half of the argument
for slots. Slot names are required rather than derived: a counter would
renumber the moment a node is inserted above it, destroying the stability
the slot exists to provide.

**Typed authoring landed in the follow-up pass.** `Registry.define()` now
accumulates each definition's literal type and `process(registry, from)` reads
that type into a fluent facade:

```ts
const graph = process(
  registry,
  marketBars.ref({
    symbol: 'ACME',
    interval: '5m',
  }),
);
const bands = graph.column('close').bollinger({
  as: 'bands',
  period: 20,
  stdDev: 2,
});
const request = graph.outputs({
  bands: bands.columns(),
  upper: bands.output('Upper').columns(),
  latest: bands.output('Upper').last(),
});
```

Op names are methods, params are inferred from `ParamDef`, extra inputs use
their declared role names, output suffixes are a literal union, and folds are
terminal handles. The facade still emits the exact slot envelope: no ids,
resolution, or cache logic moved into authoring. The emitted declarations pin
invalid params, suffixes, and missing secondary inputs with
`@ts-expect-error` consumer tests.

The implementation uses a small proxy on a column reference to project the
runtime registry as methods. This was chosen over generating a second financial
API because the registry is already the vocabulary authority; a generated
facade would recreate the drift risk this package is meant to remove. Unknown
wire plans still validate at runtime. `specId` deliberately does not move into
the builder: a caller that needs ids reads the resolved response, keeping the
encoding free to evolve behind its version prefix.

---

### [PND-PROCSOURCE] — Harden opaque asynchronous source bindings

The fluent pass exposed that `from: 'ACME_5m'` assumed a dataset had already
been loaded into the host. Application code wants the same graph over a remote
call without putting a URL, token, callback, or executable loader in the plan.

**First slice landed.** `defineSource` produces a typed `{ source, params }`
reference and keeps its async loader on a `SourceRegistry`; `Host.runAsync`
loads it, keys a long-lived graph by canonical source identity, and only calls
`setSource` when the loader's required `revision` changes. Equal revisions
therefore revalidate remotely while preserving all node caches. Param key order
does not affect source identity, and value types are encoded so `1` and `"1"`
cannot collide. Local string datasets and synchronous `Host.run` are unchanged.
An end-to-end tutorial covering the registry, fluent graph, remote binding,
column/fact selection, cache diagnostics, and refinement now lives at
`website/docs/process/tutorial.mdx`; it is deliberately unlisted and absent
from the sidebar until the package is published.

The revision is intentionally supplied by the adapter — ETag, cursor, object
version, or another stable token — because the host cannot cheaply or honestly
derive freshness from a `TimeSeries`.

**Remaining before this is a durable remote-execution surface:**

- coalesce concurrent loads of one source identity and thread cancellation;
- separate caller freshness policy (`cache-only`, max-age, revalidate, reload)
  from the processing plan;
- project source names and param schemas for a remote/model composer without
  exposing loaders;
- measure polling and refresh workloads, and state what a loader promises when
  a revision is equal.

**Done when:** concurrent callers produce one load, freshness is explicit and
tested, the source catalog is embeddable beside the op schema, and equal
revisions are demonstrated to keep both source and node work flat.

---

### [PND-PROCSUB] — Substrate and packaging decision

The RFC's v3 concludes **one package**, with the engine relocated to
`src/engine/` and dropped from `index.ts`. [#544](https://github.com/pond-ts/pond/pull/544)
currently proposes it as a published package, and its own framing is that
it should be "reconsidered or withdrawn if the RFC lands on a different
substrate."

Evidence for keeping the graph substrate, now that it has been measured
against real workload shapes rather than assumed:

- **MCP flurries, 1M rows:** graph 3058 ms vs fold+memo 4153 ms over a
  60-question session — 1.34–1.40× across runs. The crossover is real:
  0.86× at 200k rows, 1.40× at 1M.
- **Interactive params:** graph 48.1 ms median/tick vs fold 73.0 ms.
- **Multi-source:** a tick in one of N sources dirties 1/N of the
  studies, against N/N for a generation counter. Measured at N = 2, 5, 20.

And the honest counterweight: **the advantage is exactly 1/N and is zero
at N = 1.** A single-binding, single-source workload sees no invalidation
benefit at all — which is why an earlier single-binding benchmark found
none and wrongly concluded the substrate did not earn its keep. The graph
earns its keep in proportion to how many sources share a cache.

Two of the engine's headline properties really are unavailable here and
should not be cited in its favour: connect-time **cycle rejection** is
unreachable (a content-addressed spec cannot be cyclic, since an id
containing itself is unconstructible), and **typed ports** are erased
(params arrive as `JsonValue` off a wire).

A third — the **version-stamp cutoff** — was listed alongside them, and
that was too strong. It cannot fire for whole-series values compared by
identity, which is what the RFC's v3 correction says and is right. But
per-Out, with an op that returns the same instance for an output a change
did not touch, the cutoff is exactly the mechanism that expresses
selective invalidation, and it is demonstrated working
([PND-PROCSEL]). So the small core is node identity, per-Out memoized
values, a validity token, dirty propagation, **and a working per-Out
change test** — more than the original framing credited.

Note also that the +457 MB once cited against the graph was a plan-layer
artifact, not an engine property — see [PND-PROCIDENT].

**Decide:** publish vs internal module. #544 has since merged as a
**WIP, `private: true`, unpublished** package, explicitly to iterate in
the open rather than to ship; this ticket still owns whether it stays a
package or relocates under the plan layer as `src/engine/`.

---

### [PND-LIVESRC] — `LiveAggregation` does not satisfy core's `LiveSource`

Core-side, surfaced by building the live binding. `LiveAggregation` has
`name` / `schema` / `length` / `at`, but its `on('event', fn)` overload
hands the listener a widened `ClosedEvent` rather than a schema-narrowed
`EventForSchema<Out>`, so assigning one to `LiveSource<Out>` is a type
error. The binding currently declares its own looser contract to accept
both raw buffers and incremental operators.

Either narrow the `'event'` overload on the aggregation classes, or
document that `LiveSource` is the buffer/view contract only and give the
incremental operators a named contract of their own. Touches a public
type, so it needs human sign-off per [CLAUDE.md](../../CLAUDE.md).

**Related measurement:** binding a live _aggregation_ rather than the
buffer is ~229× per pull at 50k events, because a pull materializes
bucket count rather than event count. That path exposes **closed buckets
only** — the in-progress bucket is invisible until an event crosses its
end — so it must remain a documented consumer choice, never a default.

---

### [PND-PROCHELD] — A caller cannot ask what is already resident

Found by closing the demo's answer loop (M6). Asked a follow-up — "is
that high or low compared with the rest of the history?" — the model
replied that it **could not** compare against the previous turn's value,
because it did not have that result in hand. Those nodes were still
resident and would have cost nothing to re-read. It simply had no reason
to believe re-asking was cheap.

One line of prompt — "the cache outlives the turn; if an earlier result
would help, ask for it again" — turned the same follow-up from a refusal
into a full comparison at **`computed=2, cached=3`**. That fix works and
is also the evidence that something is missing: the capability was there
the whole time, and the only way to reach it was to tell a model it
existed.

**The gap.** A response reports `cached` per node _after_ the work is
requested. Nothing lets a caller ask, before composing, **what the host
already holds**. An agent that could see the resident set would plan
differently — reach for the study it already has rather than the
equivalent one it would have to build, and stop treating a comparison
against last turn as unavailable.

**What it is not.** Not a cache API, and not the eviction budget — that
is [PND-PROCCACHE], and this ticket must not quietly become it. This is a
read-only view: names, and enough lineage to recognise one.

**Open questions.**

- **What is a name here?** A `specId` is exact and unreadable; a `label`
  is readable and ambiguous. The demo's slots are caller-local and mean
  nothing across sessions, so they cannot be it.
- **Whose residency?** `host.datasets` already reports a node _count_ per
  dataset. The natural home is the same place, but a count was enough for
  a badge and is not enough for this.
- **Does it scale?** After a slider drag the demo held 55 nodes; a long
  session holds far more, and a list of every resident node is not a
  thing to put in a context window. Some projection — by op, by family,
  by what a plan would reuse — is probably the real shape, and finding it
  is most of the work.

**Done when:** a composing agent, given the resident view and no prompt
instruction about caching, re-reads an earlier turn's node instead of
declining to compare.

---

### [PND-PROCFOLD] — Reductions are nodes

**Landed.** `last`, `extremes`, `percentileRank` and `shape` were a fixed
`reduce` enum on the selector, computed after the graph had finished.
That put the one thing every caller actually reads outside the memo:

```
warm, 3 studies + 3 facts, 150k rows   11.60 ms
warm, zero facts                        0.75 ms
                                       ────────
the reductions                         10.85 ms   every request, forever
  last          0.89 ms
  extremes      1.21 ms
  percentileRank 6.57 ms
```

Every node cached, and `percentileRank` still densified 150,000 values
and filtered them twice. The library's whole claim is memoization, and it
stopped one step short of the output.

A **fold** is now an ordinary registry entry — `{kind: 'fold', inputs,
unit, fold}` — compiled into a node with a fact outlet instead of column
outlets. Same `specId`, same version check, same badge row. It is always
a leaf: a fact cannot feed anything, and naming a fold as an op's input
is rejected at compile time with both sides named.

```
warm, same 3 facts   0.13 ms
the facts now cost   0.09 ms   (was 10.85)
```

**120× on the warm path**, and `percentileRank` from 6.57 ms to 0.01 ms.
In the demo a repeated question went from 199.31 ms to **0.664 ms, `0
computed, 8 cached`** — a number that was previously impossible to reach
because three of those eight were not cacheable at all.

**What else it fixed, which is the better argument.**

- **One vocabulary.** A consumer adds a reduction with `define`, not by
  editing this library. `describe()` reports `kind`, so a picker knows
  what can be wired onward.
- **Provenance.** A fact's id is now
  `p1:percentileRank(p1:annualise(…);)`. Two callers asking the same
  question share the answer; before, the reduction appeared in no id at
  all.
- **`outputs` means what it says.** A selector is `{on, output?}` — it
  points at a node and names it. No `reduce`, no `points`, no
  `columns: true`. What comes back is whatever that node produces.
- **`shape`'s `points` is a param**, so it lands in the id and two
  callers asking for 40 points share one node rather than computing it
  twice.

**A gap it exposed, fixed alongside.** Removing `select.output` left no
way to read a band's middle or lower line — a nested input had always
read output 0, so `sma` of a Bollinger could only ever smooth `Upper`.
Nobody hit it while a selector could pick at the end. `Input` now admits
`{from, output}`, spelled `slot#Output` in the flat slot form, and it is
in the id: reading a different output is a different computation.

**And a second-order one.** The first live plan using it wrote
`bb.Upper`, which threw a 500 — slot expansion runs before the error
policy, so a mistyped input was the one class of bad plan an agent could
not read and retry against. It is collectable now, the message names the
`#` spelling when a reference looks like an attempt at one, and the
convention is in the **schema description** rather than only the system
prompt. With that in place the model composed `bb#Upper`, `bb#Middle` and
`bb#Lower` in one plan, first try.

---

### [PND-PROCDRAW] — Surfacing carries no intent

Found by reading an answer that said _"I also included the band series
output for plotting."_ It had not. It had added three `shape` folds — one
each over `bb#Upper`, `bb#Middle` and `bb#Lower`, forty points apiece —
and called 120 numbers a plot. Nothing draws a `shape`.

The band **was** on screen, because the demo adds a `columns` selector for
every non-fold slot behind the agent's back, and `Figure` renders three
outputs as a `BandChart` without being told an op name. So the claim was
wrong and accidentally true at once, which is the worst version.

**The gap.** A selector says _what to surface_; it cannot say _why_.
`{on: 'bb'}` means "give me what this node produces", and whether that
becomes a chart, a table or nothing is entirely the consumer's business.
An agent that wants a curve on screen has no way to ask for one, so it
reaches for the nearest thing it can name — and `shape` is a sampled list
that exists for a completely different reason.

Half of this is a prompt bug and is fixed: the brief had conflated "I
cannot read a column" with "do not ask for one", when the server strips
columns before the agent sees them and surfacing a study is free. With
that corrected the same request produces two nodes rather than five, and
the band reaches the output panel rather than only the workbook.

The other half is real and unbuilt.

**Why it is worth more than it looks.** Today `outputs` serves two
readers with opposite appetites — an agent that wants a few numbers, and
a renderer that wants every row — and the server reconciles them by
quietly dropping columns on the way to the model. That reconciliation
stops working when the two readers are **the same party**: an MCP client
whose responses may carry markup, rendering pond charts in the reply
itself. Then "surface this so it can be seen" is something the requester
genuinely means, and there is nowhere to put it.

**Open questions.**

- **Where does intent live?** `{on, draw: true}` is the obvious spelling
  and probably too binary — "as a band", "against this other series",
  "the last 200 bars" are all things a requester means by "show me".
  A flag that immediately wants three modifiers is a flag in the wrong
  place.
- **Who renders?** `Figure` deciding band-vs-line from `outs.length`
  proves the response already carries enough to draw correctly without op
  knowledge. That argues the renderer can stay a consumer. But if a
  response is to _contain_ a chart, something has to own that, and
  `@pond-ts/process` depending on `@pond-ts/charts` is a dependency
  direction worth refusing on purpose.
- **What crosses the wire?** Not rendered pixels and not 150,000 points
  of JSON. The frames path already answers this — base64 `Float64Array`
  plus a validity bitmap, adopted zero-copy by `TimeSeries.fromColumns`
  ([PND-PROCCOL]) — so a renderable response is the existing wire shape
  plus a rendering shell, not a new transport.
- **Does `shape` survive?** It exists because a model pays per point. If
  the model can hand back a chart instead of describing one, `shape`
  narrows to its honest use — _the agent itself_ needing a trajectory to
  reason about — which is a smaller job than it currently advertises.

**Done when:** a requester can express "show this" without the consumer
having to guess, and an agent that wants a band on screen names one
rather than approximating it with a fold.
