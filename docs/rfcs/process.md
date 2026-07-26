# RFC: `@pond-ts/process` — a declarative processing graph over a `TimeSeries`

**Status:** **proposal (2026-07-26)** — for discussion. Nothing built. Filed by a
consumer that has been running a narrow version of this in application code and
would rather not own it.

**Relationship to PLAN.md:** This RFC is strategic context, not a commitment.
[PLAN.md](../../PLAN.md) is the binding source of truth for what is being built.
See [CLAUDE.md → Strategic RFCs](../../CLAUDE.md) for the layering.

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

A worked sketch against the real corpus signatures is in
[Appendix A](#appendix-a--worked-sketch).

## Motivation

pond already has everything needed to _compute_ a study — `sma`, `ema`,
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
shape has appeared, and it wants the _same_ graph with a _different exit_:

|          | **Renderer** (chart / dashboard)  | **Tool server** (LLM-facing, e.g. an MCP server) |
| -------- | --------------------------------- | ------------------------------------------------ |
| Wants    | whole columns — it draws every point | a **verdict** — a handful of labelled numbers  |
| Volume   | 10²–10⁶ points, in-process        | tens of tokens, over a wire                      |
| Bad spec | must **skip** and keep rendering  | must **report** a reason as data                 |
| Provenance | a label under a legend chip     | a citation the model can quote                   |

These are the same computation with different terminals and different failure
policy. Building them separately would duplicate the graph, the ids, the
validation, and — expensively — the **cache**. Building them together means a
value already computed for a human on screen is a cache hit for the tool call
asking the same question, because both name it identically (see _Identity_).

### The four walls

The narrow consumer-side version cannot grow past these, and all four are
resolved by putting the graph in a library:

1. **One spec ⇒ one output column.** `bollinger` and `envelope` are multi-output
   (upper/middle/lower). They are unrepresentable, so they are unimplemented.
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
  op: string; // registry key
  params: Record<string, JsonValue>; // not numbers-only: enums, columns, flags
  inputs: Input[]; // column names — plural, see below
}
type Input = string | Spec; // a raw column, or a nested spec
type Plan = readonly Spec[]; // a DAG; declaration order is free
```

`inputs` is plural from the start. Single-input ops are the common case, but
spreads, ratios, correlations and crossings are inherently 2-input, and widening
this later is a breaking change to every persisted plan.

Resolution is a worklist fold: a spec runs once its inputs exist (raw column or
another spec's output), so a plan is order-independent and nesting is free. This
part exists already in consumer code and transfers directly.

### The registry is the schema

The load-bearing idea. One declaration, four readers: **param validation**; a
**JSON-Schema emitter** (so a tool server can advertise operations without
hand-maintaining a parallel schema); a **UI picker** (family + params + defaults
is exactly what a grouped menu needs); and **unit propagation** —
`'inherit' | '%' | 'sigma' | 'ratio' | ((inputs) => unit)` — which is what lets a
consumer put `zScore` on its own axis without special-casing it.

Declaring `outputs` as a list is what makes a band a first-class citizen: one
spec, three columns, that a consumer can move, colour, and delete as a unit.

### Identity

`specId(spec)` → a canonical, escape-safe, **versioned** string:

```
p1:bollinger(iv21;period=20,stdDev=2)     → columns …Upper, …Middle, …Lower
```

Canonical param order so two spellings of one computation collide deliberately.
Escaped separators so a string param cannot forge an id. Versioned prefix so the
encoding can change without colliding with ids already persisted or cached.

That one string is simultaneously the **column name**, the **cache key**, and the
**provenance citation**. Consumers get dedup for free: the same computation
requested twice, from different surfaces, resolves once. `planId(plan)` is the
same idea for a whole stack.

### Two terminals

```ts
resolve(series, plan, opts): Resolution   // series + column ids + diagnostics
reduce(resolution, reductions): Facts     // plain JSON
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
resolve(series, plan, { onError: 'skip' | 'collect' | 'throw' });
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
- **No protocol.** The registry _emits_ a schema; it does not own a server,
  transport, or session.
- **No rendering.**
- **No new operation corpus.** Operations come from `@pond-ts/financial` and from
  consumers.
- **No Arrow egress.** Worth stating because it was the first assumption to fall:
  a tool-server terminal returns small JSON, not a re-serialized table. Arrow
  earns its keep on the _bulk inbound_ hop; a `toArrow` is not needed for this
  design.

## Package boundaries

```
pond-ts (core)         TimeSeries, columns, fromArrow, rolling/smooth
@pond-ts/financial     the operation corpus + calendars
@pond-ts/process       specs, registry, ids, resolution, reductions   ← proposed
```

**`process` must not depend on `financial`.** If it does, the domain-neutral name
is a lie and a non-financial consumer (activity analytics, telemetry) inherits an
irrelevant dependency. Instead, operations are _registered into_ it:

```ts
import { createRegistry } from '@pond-ts/process';
import { registerFinancialOps } from '@pond-ts/financial/process';

const registry = createRegistry();
registerFinancialOps(registry); // corpus
registry.define(myDomainOp); // consumer-local
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
5. **Multi-output naming.** `id#output` vs the corpus's existing `prefix` +
   suffix convention (Appendix A adopts the latter — it needs no mapping layer).

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

---

# Appendix A — worked sketch

Written against the **real** corpus signatures, which changed two design choices
(noted inline). Illustrative, not proposed API text.

## A.1 Defining ops — the adapter is thin

```ts
import { defineOp, int, num } from '@pond-ts/process';
import { sma, bollinger } from '@pond-ts/financial';

export const smaOp = defineOp({
  name: 'sma',
  family: 'trend',
  summary: 'Simple moving average over a bar-count window.',
  params: { period: int({ min: 2, default: 20, label: 'Period (bars)' }) },
  inputs: [{ role: 'source', kind: 'number' }],
  outputs: [{ id: '', unit: 'inherit' }], // single output ⇒ column === specId
  run: ({ series, inputs, params, id }) =>
    sma(series, { column: inputs.source, period: params.period, output: id }),
});

export const bollingerOp = defineOp({
  name: 'bollinger',
  family: 'bands',
  summary: 'Moving average with ±stdDev bands.',
  params: {
    period: int({ min: 2, default: 20 }),
    stdDev: num({ min: 0.1, max: 5, default: 2, label: 'Std devs' }),
  },
  inputs: [{ role: 'source', kind: 'number' }],
  // DESIGN NOTE (from the real signature): `bollinger` appends
  // `${prefix}Middle|Upper|Lower`. So declare the SUFFIXES and let `id` be the
  // prefix — the corpus convention becomes the multi-output convention, with no
  // mapping layer and no invented `#output` syntax.
  outputs: [
    { id: 'Upper', unit: 'inherit' },
    { id: 'Middle', unit: 'inherit' },
    { id: 'Lower', unit: 'inherit' },
  ],
  run: ({ series, inputs, params, id }) =>
    bollinger(series, {
      column: inputs.source,
      period: params.period,
      stdDev: params.stdDev,
      prefix: id,
    }),
});
```

An op's `run` returns the series with its columns appended; `process` verifies the
declared outputs actually appeared, so a mis-wired adapter fails loudly in a
registration test rather than silently at render time.

A consumer-local op registers identically — this is how a domain transform stops
being a fork:

```ts
registry.define(
  defineOp({
    name: 'realizedVol',
    family: 'volatility',
    params: { periodsPerYear: int({ min: 1, default: 252 }) },
    inputs: [{ role: 'source', kind: 'number', unit: 'variance' }], // typed input
    outputs: [{ id: '', unit: '%' }], // NOT inherit
    run: ({ series, inputs, params, id }) => …,
  }),
);
```

`unit: '%'` rather than `inherit` is what makes the output land on the right axis
without the host special-casing it — and it is exactly what is wrong-by-convention
in the consumer implementation today.

## A.2 A plan is data — written as a tree, stored as a DAG

```ts
const plan: Plan = [
  { op: 'bollinger', params: { period: 20, stdDev: 2 }, inputs: ['iv21'] },
  // Nesting is inline: an input may be a column name OR another spec.
  {
    op: 'ema',
    params: { period: 10 },
    inputs: [{ op: 'sma', params: { period: 20 }, inputs: ['iv21'] }],
  },
  // …and this SMA is the same computation as the nested one, so content
  // addressing collapses them: normalize() yields 3 nodes, not 4.
  { op: 'sma', params: { period: 20 }, inputs: ['iv21'] },
];
```

Authors get trees; the engine stores a deduped flat DAG keyed by `specId`:

```
p1:bollinger(iv21;period=20,stdDev=2)   → …Upper │ …Middle │ …Lower
p1:sma(iv21;period=20)                  → one column, name === the id
p1:ema(p1:sma(iv21;period=20);period=10)
```

## A.3 Terminal one — `resolve()`, for a renderer

```ts
const resolution = resolve(volSeries, plan, {
  registry,
  units: { iv21: '%', ccVar: 'variance' }, // consumer metadata — see note
  onError: 'skip', // a stale saved plan must not kill a render
  cache, // host-owned Map, keyed by specId
});

resolution.series; // TimeSeries with every resolved column appended
resolution.outputs; // Map<specId, { column: string; unit: string }[]>
resolution.skipped; // [{ spec, reason }]
```

**DESIGN NOTE — units are an input, not a property of the series.** pond series
do not carry units; consumers do. Passing them in lets `process` both _validate_
(`realizedVol` demands a variance-unit input) and _report_ concrete units on the
way out, which the JSON terminal needs and an axis policy already wants.

The renderer draws `resolution.outputs`; a band is one entry with three columns, so
it moves, colours, and deletes as a unit.

## A.4 Terminal two — `reduce()`, for a tool caller

```ts
const bb = specId({ op: 'bollinger', params: { period: 20, stdDev: 2 }, inputs: ['iv21'] });
const sma20 = specId({ op: 'sma', params: { period: 20 }, inputs: ['iv21'] });

const facts = reduce(resolution, [
  { on: sma20, reduce: 'last' },
  { on: 'iv21', reduce: 'percentileRank', window: '1y' },
  { on: 'iv21', reduce: 'crossings', against: sma20 },
  { on: bb, output: 'Upper', reduce: 'extremes' },
  { on: 'iv21', reduce: 'shape', points: 40 }, // M4 via bin(w,'minMaxFirstLast')
]);
```

```json
{
  "asOf": "2026-07-24T20:00:00.000Z",
  "facts": [
    {
      "id": "p1:sma(iv21;period=20)",
      "reduce": "last",
      "value": 26.82,
      "unit": "%",
      "at": "2026-07-24"
    },
    {
      "id": "iv21",
      "reduce": "percentileRank",
      "window": "1y",
      "value": 0.71,
      "unit": "quantile",
      "note": "71st percentile of 252 observations"
    },
    {
      "id": "iv21",
      "reduce": "crossings",
      "against": "p1:sma(iv21;period=20)",
      "events": [
        { "at": "2026-06-18", "direction": "above" },
        { "at": "2026-07-09", "direction": "below" }
      ]
    },
    {
      "id": "p1:bollinger(iv21;period=20,stdDev=2)Upper",
      "reduce": "extremes",
      "min": { "value": 22.4, "at": "2026-02-03" },
      "max": { "value": 41.9, "at": "2026-07-21" },
      "unit": "%"
    },
    {
      "id": "iv21",
      "reduce": "shape",
      "points": 40,
      "unit": "%",
      "series": [["2026-01-02", 24.1], ["2026-01-09", 23.7], "…"]
    }
  ],
  "computed": ["p1:sma(iv21;period=20)", "p1:bollinger(iv21;period=20,stdDev=2)"],
  "skipped": []
}
```

Every fact carries **unit + timestamp + the id that produced it**, so a model can
cite `p1:sma(iv21;period=20)` rather than "the moving average I computed somehow."
`shape` is the honest answer to "return the series": ~40 points that preserve
extremes instead of 1,300 raw ones.

## A.5 Discovery — two tools, not twelve

```ts
registry.toJsonSchema(); // ops as a discriminated union of param objects
```

A catalog, not endpoints. Expose two tools rather than one per study:

```ts
server.tool('describe_operations', {}, () => registry.describe());
//   → [{ name:'bollinger', family:'bands', summary:…, params:{…}, outputs:3 }, …]

server.tool(
  'run_analysis',
  {
    series: …,                       // what data (handed to the ingest layer)
    plan: registry.toJsonSchema(),   // ops as data — the caller composes stacks
    reductions: reductionSchema,
  },
  async (args) => reduce(resolve(await load(args.series), args.plan, opts), args.reductions),
);
```

Adding an op to the registry extends the tool schema with no server change — and
the caller gets to _compose_ (`ema` of `sma` of a curve) rather than pick from
pre-baked questions.

## A.6 What the migration deletes, consumer-side

```ts
// before: a hardcoded module constant — three ops, no families, no param metadata
const STUDY_OPS = [
  { op: 'sma', label: 'SMA' },
  { op: 'ema', label: 'EMA' },
];

// after: the picker renders itself
registry.byFamily(); // Map<'trend'|'bands'|'volatility'|…, OpDescriptor[]>
registry.get(op).params; // drives a Period field's min/default — nothing hardcoded
explain(plan, registry); // "EMA(10) of SMA(20) of ATM Vol 21D"
```

That last line is the lineage label the consumer currently renders wrong. The
migration is not a refactor: it _is_ the grouped picker, the bands feature, and the
lineage fix, in exchange for deleting local spec/id/fold code.

## A.7 Cache

```ts
const cache = new Map<string, TimeSeries<SeriesSchema>>(); // host owns storage
resolve(series, plan, { registry, cache }); // library owns keys
```

Keys are `specId`s, so a renderer's on-screen `SMA(20)` and a tool call asking for
`SMA(20)` hit the **same key** — one compute, two consumers. That shared key is
the strongest argument for the two terminals living in one package.
