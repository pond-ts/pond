# RFC: `@pond-ts/process` — a declarative processing graph over a `TimeSeries`

**Status:** proposal, for discussion. Nothing built upstream yet.
**Author:** a consumer agent, on behalf of a consumer that has been running a
narrow version of this in application code and would rather not own it.

---

## Summary

Add a package that turns "compute these derived series" from **imperative calls**
into a **declarative, content-addressed graph**:

```
                          ┌──> resolve() ──> TimeSeries + appended columns
Plan (DAG of Specs) ──────┤
                          └──> reduce()  ──> Facts (plain JSON)
```

One plan, one cache, two terminals. `@pond-ts/financial` supplies the operations;
this package supplies **composition, identity, validation, and reduction**.

## Motivation

pond already has everything needed to *compute* a study — `sma`, `ema`,
`bollinger`, `rollingStdev/Min/Max/Percentile`, `zScore`, `envelope`,
`percentChange`, all column-appending `TimeSeries → TimeSeries`. What it has no
opinion about is what happens when a consumer wants **many of them, stacked, from
data rather than from code**.

That gap is currently filled by consumer-side glue. A consumer has already built
a narrow version — a `{op, params, source}` spec type, a content-addressed id
derived from the spec, and a dependency-ordered worklist fold that resolves
nested specs (a study of a study) against a series. It works and is in daily use,
but it is stuck at three operations, and every extension runs into the same four
walls (below). None of that glue is domain-specific; none of it belongs in an
application.

### Two consumer shapes, one engine

The forcing function for this RFC is that a second, quite different consumer
shape has appeared, and it wants the *same* graph with a *different exit*:

| | **Renderer** (chart / dashboard) | **Tool server** (LLM-facing, e.g. an MCP server) |
|---|---|---|
| Wants | whole columns — it draws every point | a **verdict** — a handful of labelled numbers |
| Volume | 10²–10⁶ points, in-process | tens of tokens, over a wire |
| Bad spec | must **skip** and keep rendering | must **report** a reason as data |
| Provenance | a label under a legend chip | a citation the model can quote |

These are the same computation with different terminals and different failure
policy. Building them separately would duplicate the graph, the ids, the
validation, and — expensively — the **cache**. Building them together means a
value already computed for a human on screen is a cache hit for the tool call
asking the same question, because both name it identically (see *Identity*).

### The four walls

The narrow consumer-side version cannot grow past these, and all four are
resolved by putting the graph in a library:

1. **One spec ⇒ one output column.** `bollinger` and `envelope` are multi-output
   (upper/mid/lower). They are unrepresentable, so they are unimplemented.
2. **No registry.** Operations are a hardcoded map, params are typed
   `Record<string, number>`. A consumer that wants a grouped operation picker, or
   a tool server that wants to advertise a schema, has nothing to read.
3. **Units are convention, not data.** The consumer copies the source series'
   unit onto the derived one by hand. That is wrong for `zScore` (→ σ) and
   `percentChange` (→ %), and unit is what axis-compatibility is computed from.
4. **Failures are silent.** Bad params are caught and the spec skipped — correct
   for a renderer with a stale persisted plan, useless for a caller that needs to
   be told why.

## Design

### Spec, Plan

```ts
interface Spec {
  op: string;                              // registry key
  params: Record<string, JsonValue>;       // not numbers-only: enums, columns, flags
  inputs: string[];                        // column names — plural, see below
}
type Plan = readonly Spec[];               // a DAG; order of declaration is free
```

`inputs` is plural from the start. Single-input ops are the common case, but
spreads, ratios, correlations and crossings are inherently 2-input, and widening
this later is a breaking change to every persisted plan.

Resolution is a worklist fold: a spec runs once its inputs exist (raw column or
another spec's output), so a plan is order-independent and nesting is free. This
part exists already in consumer code and transfers directly.

### The registry is the schema

The load-bearing idea. One declaration, four readers:

```ts
defineOp({
  name: 'bollinger',
  family: 'bands',                                  // grouped pickers
  params: {
    period: int({ min: 2, default: 20 }),           // validation + tool schema
    k:      num({ min: 0.1, default: 2 }),
  },
  inputs:  [{ kind: 'number', role: 'source' }],
  outputs: [                                        // multi-output, declared
    { id: 'upper', unit: 'inherit' },
    { id: 'mid',   unit: 'inherit' },
    { id: 'lower', unit: 'inherit' },
  ],
  run: (ctx) => …,                                  // wraps the financial op
});
```

Read by: **param validation**; a **JSON-Schema emitter** (so a tool server can
advertise operations without hand-maintaining a parallel schema); a **UI picker**
(family + params + defaults is exactly what a grouped menu needs); and **unit
propagation** — `'inherit' | '%' | 'sigma' | 'ratio' | ((inputs) => unit)` — which
is what lets a consumer put `zScore` on its own axis without special-casing it.

Declaring `outputs` as a list is what makes a band a first-class citizen: one
spec, three columns, that a consumer can move, colour, and delete as a unit.

### Identity

`specId(spec)` → a canonical, escape-safe, **versioned** string:

```
p1:bollinger(iv21;k=2,period=20)      → columns p1:…#upper, #mid, #lower
```

Canonical param order so two spellings of one computation collide deliberately.
Escaped separators so string params cannot forge an id. Versioned prefix so the
encoding can change without colliding with ids already persisted or cached.

That one string is simultaneously the **column name**, the **cache key**, and the
**provenance citation**. Consumers get dedup for free: the same computation
requested twice, from different surfaces, resolves once. `planId(plan)` is the
same idea for a whole stack.

### Two terminals

```ts
resolve(series, plan, opts): Resolution        // series + column ids + diagnostics
reduce(resolution, reductions): Facts          // plain JSON
```

`reduce` is the part that does not exist anywhere today, and the part a renderer
never needed. A second small registry of **reductions**, over resolved columns:

- `last` — value + timestamp
- `extremes` — min/max **with when**
- `crossings` — where series A crossed B, as dated events
- `percentileRank` — where the current value sits in its own history
- `regimes` — run-lengths above/below a threshold
- `shape(n)` — a faithful ~n-point envelope for "show me the curve", via the
  existing column API `bin(width, 'minMaxFirstLast')` (M4). This is the honest
  answer to "return the series" for a token-metered caller: a few hundred tokens
  instead of a few hundred thousand, extremes preserved.

Every fact carries its **unit** and its **timestamp**, and the response echoes the
**resolved** spec (post-defaults) so a caller can cite what actually ran.

### Policy as a parameter

```ts
resolve(series, plan, { onError: 'skip' | 'collect' | 'throw' })
```

`skip` keeps a renderer alive against a stale persisted plan (today's behaviour in
the consumer implementation, and load-bearing there). `collect` returns
`{ spec, reason }[]` for a caller that must explain itself. Same engine; the
difference is an argument, not a fork.

### `explain`

`explain(plan) → string` falls out of the registry nearly free, and has two
immediate readers: a tool server describing what it computed, and a UI rendering a
lineage label. (In the existing consumer implementation, nested lineage is
currently rendered wrong — `ema(sma(x))` loses the inner `sma` — precisely because
the label is reconstructed by hand instead of derived from the plan.)

## Non-goals

- **No I/O.** Callers bring a `TimeSeries`. Bulk ingest already exists
  (`fromArrow`, `fromColumns`).
- **No protocol.** The registry *emits* a schema; it does not own a server,
  transport, or session.
- **No rendering.**
- **No new operation corpus.** Operations come from `@pond-ts/financial` and from
  consumers.
- **No Arrow egress.** Worth stating because it was the first assumption to fall:
  a tool-server terminal returns small JSON, not a re-serialized table. Arrow
  earns its keep on the *bulk inbound* hop; a `toArrow` is not needed for this
  design.

## Package boundaries

```
pond-ts (core)         TimeSeries, columns, fromArrow, rolling/smooth
@pond-ts/financial     the operation corpus + calendars
@pond-ts/process       specs, registry, ids, resolution, reductions   ← proposed
```

**`process` must not depend on `financial`.** If it does, the domain-neutral name
is a lie and a non-financial consumer (activity/fitness analytics, telemetry)
inherits an irrelevant dependency. Instead, operations are *registered into* it:

```ts
import { createRegistry } from '@pond-ts/process';
import { registerFinancialOps } from '@pond-ts/financial/process';

const registry = createRegistry();
registerFinancialOps(registry);      // corpus
registry.define(myDomainOp);         // consumer-local
```

This inversion has a second benefit: it gives a domain operation a **legitimate
place to live while it proves itself**. The existing consumer has one local op (an
annualized-volatility transform over a variance column) that today is effectively
a fork of library concerns. Registered locally, it is a citizen; if it proves
general, it graduates into `financial` with no consumer change.

## Proving path

Deliberately incremental, and each step is independently worth doing:

1. **A renderer migrates its local graph onto `process`.** This is not a
   refactor-for-its-own-sake: three features that consumer has already scoped
   become consequences rather than work — a grouped operation picker (reads the
   registry), band operations (multi-output), and correct lineage labels
   (`explain`). It also exercises identity and caching under a human who can see
   when a stack is wrong.
2. **Add the reduction terminal** once a real caller needs facts rather than
   columns. This is the only part with no renderer-side justification, so it
   should come last and be judged on its own.

## Open questions

1. **Streaming.** v1 is batch over a snapshot. The rolling reducers are already
   incremental internally, so live re-resolution is feasible — but the cache and
   invalidation story changes materially. Defer, or design now?
2. **Cache ownership.** Does `process` own an LRU keyed by `specId`, or only
   define the keys and let the host store? (Leaning: host stores, library names.)
3. **Reduction home.** Same package as the graph (they share the registry
   pattern), or a sibling? (Leaning: same package, separate registry.)
4. **Params as JSON Schema, or a small internal validator?** Emitting JSON Schema
   is the point of the registry for tool callers; owning a validator is a cost.
5. **Multi-output naming.** `id#output` (proposed above) vs a nested column
   namespace. The former is a string and survives persistence trivially; the
   latter is tidier in a schema.

## Alternatives considered

- **Leave it in application code.** What happens today. It works for one
  consumer, at three operations, and duplicates per consumer. Multi-output and a
  registry are the point at which "a bit of glue" becomes a component.
- **Fold it into `@pond-ts/financial`.** Tempting — the ops are there. But the
  graph is domain-neutral and a non-financial consumer should not depend on a
  financial package to compose operations.
- **Expose only a fluent builder** (`series.sma(20).ema(10)`). Ergonomic in code,
  but the whole motivation is plans that arrive as **data** — persisted in saved
  views, or constructed by a caller that is not a programmer. A builder can be
  sugar over a plan later; a plan cannot be recovered from a builder.
