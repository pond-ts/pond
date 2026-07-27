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

| Script                    | Answers                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `rfc543-plan-layer.mjs`   | Appendix A end-to-end; identity, units, JSON round trip         |
| `rfc543-step0.mjs`        | Proving-path step 0 — forked series, 2-input op, graph vs fold  |
| `rfc543-mcp-workload.mjs` | MCP flurries at 1M rows; the assembly tax and its bridge        |
| `rfc543-ui-workloads.mjs` | Interactive params, hot leading edge, value representation      |
| `rfc543-multisource.mjs`  | Separate graphs vs one graph; invalidation at N sources         |
| `rfc543-ranged-dirty.mjs` | Join-as-a-node, dirty per column, dirty per range               |
| `rfc543-param-ins.mjs`    | Content-addressed vs params-as-Ins; selective Out invalidation  |
| `rfc543-op-cache.mjs`     | Two modes of In; node-level cache; per-op vs engine-wide budget |

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
