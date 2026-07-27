# PND_PROCESS_PLAN — `@pond-ts/process`, the declarative processing graph

> Breakout plan for the **`@pond-ts/process`** roadmap section in
> [PLAN.md](../../PLAN.md). Design rationale lives in the RFC
> ([docs/rfcs/process.md](../rfcs/process.md)); this file carries the
> per-task detail, the measurements each task is sized against, and what
> "done" means.

## How the measurements were produced

Every number below came from a runnable script, not an estimate. The
scripts live on the `feat/process-graph` branch
([#544](https://github.com/pond-ts/pond/pull/544)) under
`packages/process/scripts/`, and each is self-contained:

| Script                    | Answers                                                        |
| ------------------------- | -------------------------------------------------------------- |
| `rfc543-plan-layer.mjs`   | Appendix A end-to-end; identity, units, JSON round trip        |
| `rfc543-step0.mjs`        | Proving-path step 0 — forked series, 2-input op, graph vs fold |
| `rfc543-mcp-workload.mjs` | MCP flurries at 1M rows; the assembly tax and its bridge       |
| `rfc543-ui-workloads.mjs` | Interactive params, hot leading edge, value representation     |
| `rfc543-multisource.mjs`  | Separate graphs vs one graph; invalidation at N sources        |
| `rfc543-ranged-dirty.mjs` | Join-as-a-node, dirty per column, dirty per range              |

If #544 is withdrawn (see [PND-PROCSUB]), these should be salvaged into
whatever package replaces it — they are the evidence base for every
decision here.

**One caveat that shaped several findings:** measuring two heap
representations inside one process gave GC-dominated, sometimes negative
deltas. Memory numbers below were taken one representation per process,
with `--expose-gc` and an explicit `global.gc()` before reading
`memoryUsage()`.

---

## Tasks

### [PND-PROCEVICT] — Node eviction. Blocking for any interactive consumer.

**Nothing evicts, and content addressing guarantees an unbounded key
space.** A user dragging a study's `period` from 21 to 40 creates 20 new
specs, therefore 20 new permanently-cached nodes. Measured at 500k rows:
28 nodes, **+457 MB** heap after gc. A parameter sweep across a realistic
range OOMs a long-lived server, which is exactly the shape of the
financial app and the MCP server the RFC targets.

The RFC's A.7 gives hosts "graph lifecycle" — one graph per binding — but
there is no story for node lifetime _within_ a binding.

**Shape:** LRU over nodes with no live selector, bounded by count or by
retained bytes. Wants a `graph.release(id)` / `graph.gc()` surface, and a
decision on whether a node referenced by a persisted plan is pinned.
Interacts with [PND-PROCCOL]: bytes-based bounds are only meaningful once
node values have a knowable size, which packed columns have and JS arrays
do not.

**Done when:** a 200-position parameter sweep at 1M rows holds steady-state
memory, with a documented policy for what survives.

---

### [PND-PROCCOL] — Node values are columns, not JS arrays

Ops already produce a `TimeSeries` whose column is packed; the current
adapter unpacks it into a boxed `Array` with `undefined` holes and pays
for that twice — space, and re-boxing on every later scan.

Measured, 20 columns × 500k rows, one representation per process:

|                           | heapUsed | rss    |
| ------------------------- | -------- | ------ |
| JS Array (holey)          | 160 MB   | 237 MB |
| `Float64Array` + validity | 3 MB     | 123 MB |

~2× smaller overall and **~50× less GC-managed heap** — the number that
shows up as pause time in an interactive UI.

This task is a force multiplier: it is a prerequisite for byte-bounded
eviction ([PND-PROCEVICT]) and for the ranged-recompute ceiling
([PND-PROCRANGE], where array reallocation, not compute, was 99% of the
remaining per-tick cost).

**Done when:** node values are a pond column type end to end, with no
`Array`-of-`undefined` on the hot path.

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

Three of the engine's headline properties are unavailable at this layer
and should not be cited in its favour: the version-stamp **cutoff** cannot
fire (every op returns a fresh series), connect-time **cycle rejection**
is unreachable (a content-addressed spec cannot be cyclic), and **typed
ports** are erased (params arrive as JSON). What remains — node identity,
a memoized value, a validity token, dirty propagation — is the small core
the plan layer actually needs.

**Decide:** publish vs internal module, and whether #544 merges, is
rebased into the plan package, or is closed with its scripts and tests
salvaged.

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
