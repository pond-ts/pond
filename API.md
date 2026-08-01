# API.md — public API map for agents

A fast-navigation map of every public export across the monorepo's six
packages, **for agents working in this repo**. Use it to find the right
primitive and the file it lives in without crawling `src/`. It is a map, not a
reference: one line per export, grouped by purpose, with the source path.
Verify exact signatures in the listed source file (or the generated typedoc)
before writing code against them.

- **Authority**: each package's `src/index.ts` is the export surface. If this
  file and `index.ts` disagree, `index.ts` wins — fix this file in the same PR.
- **Maintenance**: when a PR adds/removes/renames a public export, update the
  matching row here in that PR.
- **Human-facing docs**: `website/docs/` (narrative + per-feature reference)
  and `pathname:///generated-api/<pkg>/` (generated typedoc). This file is the
  agent-facing complement, not a replacement.

| Package              | npm name             | Entry points                                     | Docs hub                     |
| -------------------- | -------------------- | ------------------------------------------------ | ---------------------------- |
| `packages/core`      | `pond-ts`            | `.` and `./types` (zero-runtime schema contract) | `website/docs/pond-ts/`      |
| `packages/react`     | `@pond-ts/react`     | `.`                                              | `website/docs/react/`        |
| `packages/charts`    | `@pond-ts/charts`    | `.`                                              | `website/docs/charts/`       |
| `packages/financial` | `@pond-ts/financial` | `.` and `./fluent` (prototype augmentation)      | `website/docs/financial/`    |
| `packages/fit`       | `@pond-ts/fit`       | `.`                                              | `website/docs/fit/`          |
| `packages/process`   | `@pond-ts/process`   | `.` — **WIP, `private: true`, not published**    | `packages/process/README.md` |

---

## pond-ts (core) — batch

### Series classes & construction

| Export                  | Purpose                                                | Source                                               |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `TimeSeries`            | Immutable time-indexed collection, columnar storage    | `packages/core/src/batch/time-series.ts`             |
| `ValueSeries`           | Series keyed by a monotonic non-time value axis        | `packages/core/src/batch/value-series.ts`            |
| `PartitionedTimeSeries` | Scoped view for per-partition stateful transforms      | `packages/core/src/batch/partitioned-time-series.ts` |
| `Sequence`              | Infinite grid of time buckets (daily, hourly, every N) | `packages/core/src/sequence/sequence.ts`             |
| `BoundedSequence`       | Finite ordered list of explicit interval buckets       | `packages/core/src/sequence/bounded-sequence.ts`     |

Static constructors on `TimeSeries`: `fromJSON()` (row tuples/objects),
`fromColumns()` (struct-of-arrays; `number` + `string` value columns),
`fromArrow()` (bring-your-own Apache Arrow `Table`; zero-copy Float64 adopt +
BigInt-free int64 time; numeric + `Utf8` string columns), `fromEvents()`,
`fromPoints()` (wide rows with `ts`), `concat()`, `joinMany()`. On
`ValueSeries`, the same three shapes keyed on the axis instead of time:
`fromJSON()`, `fromColumns()`, `fromArrow()` (`{ axis }` is required — no
`'time'` field convention to fall back on, and no unit scaling). Arrow-ingest
types (`ArrowTableLike`, `ArrowVectorLike`, `ArrowDataLike`, `ArrowFieldLike`,
`ArrowSchemaLike`, `ArrowTimeUnit`, `FromArrowOptions`,
`FromArrowValueOptions`) live in
`packages/core/src/batch/operators/from-arrow.ts`.

Both classes also export **columnar JSON** — `toColumns()`, one plain array
per column with gaps as `null`, the exact `{ name, schema, columns }` envelope
`fromColumns()` takes back (`packages/core/src/batch/operators/to-columns.ts`).
A **two-edged key** (`timeRange` / `interval`) flattens into extra columns
named off it — `timeRange` + `timeRangeEnd`, `interval` + `intervalEnd` +
`intervalLabel` — the convention `toArrow` already emitted, now read by
`fromColumns` and by `fromArrow({ keyKind })` as well
(`packages/core/src/batch/operators/flat-keys.ts` owns the naming + collision
rules). Columnar wire types live beside their row siblings:
`TimeSeriesJsonColumns` / `FlatKeyColumns` / `TimeSeriesColumnarInput` /
`TimeSeriesColumnarOutput` in `packages/core/src/schema/json.ts`.

Going the other way, `TimeSeries.toArrow()` / `ValueSeries.toArrow()` export
the columns **in Arrow's memory layout with no copy** — pond's validity bitmap
is already LSB-first one-bit-per-value, numerics are a contiguous
`Float64Array`, booleans a packed bitmap, dict-encoded strings `Int32Array`
indices plus a dictionary. It returns `{ length, fields }` rather than an Arrow
`Table` (pond doesn't depend on `apache-arrow`; the caller assembles with
`makeData`/`makeVector`), so another columnar engine is a buffer handoff
instead of a re-ingest. Arrow-export types (`ArrowExport`, `ArrowExportField`,
`ArrowExportType`, `ToArrowOptions`) live in
`packages/core/src/batch/operators/to-arrow.ts`.

`ValueSeries` also exports rows (`toRows()`, `toObjects()`, `toJSON()`).
Value-axis wire types
(`ValueSeriesJsonInput`, `ValueSeriesJsonRow`, `ValueSeriesJsonObjectRow`,
`ValueSeriesJsonOutputArray`, `ValueSeriesJsonOutputObject`,
`ValueSeriesJsonCell`, `ValueSeriesRow`, `ValueSeriesObjectRow`,
`ValueSeriesJsonColumns`, `ValueSeriesColumnarInput`,
`ValueSeriesColumnarOutput`) live in `packages/core/src/schema/value-io.ts`.

### Temporal keys & events

| Export        | Purpose                                       | Source                                 |
| ------------- | --------------------------------------------- | -------------------------------------- |
| `Time`        | Point-in-time event key                       | `packages/core/src/core/time.ts`       |
| `TimeRange`   | Interval event key (start/end)                | `packages/core/src/core/time-range.ts` |
| `Interval`    | Labeled time-interval event key               | `packages/core/src/core/interval.ts`   |
| `Event`       | Immutable event: temporal key + typed payload | `packages/core/src/core/event.ts`      |
| `toTimeRange` | Coerce temporal values to `TimeRange`         | `packages/core/src/core/time-range.ts` |

### TimeSeries methods (all in `packages/core/src/batch/time-series.ts`)

- **Query**: `at()`, `first()`, `last()`, `bisect(key)`, `includesKey(key)`,
  `atOrBefore(key)`, `atOrAfter(key)`, `nearest(key)`, `find()`, `some()`,
  `every()`
- **Export/access**: `column(name)`, `keyColumn()`, `toRows()`, `toObjects()`,
  `toArray()`, `toJSON()`, `toColumns()`, `toArrow()`, `toPoints()`
- **Temporal range**: `timeRange()`, `overlaps()`, `contains()`,
  `intersection()`, `overlapping(range)`, `containedBy(range)`, `trim(range)`,
  `after()`, `before()`, `within()`, `tail(duration)`
- **Key-type conversion**: `asTime({ at })`, `asTimeRange()`, `asInterval()`
- **Filter/slice**: `filter()`, `sample(strategy)`, `slice(begin, end)`
- **Column reshape**: `select()`, `rename()`, `map()`, `mapColumns()`,
  `withColumn()`, `collapse()`
- **Array columns**: `arrayContains()`, `arrayContainsAll()`,
  `arrayContainsAny()`, `arrayAggregate()`, `arrayExplode()`
- **Gap fill / dedupe**: `fill()`, `materialize()`, `dedupe()`
- **Aggregate/group**: `aggregate(sequence, spec)`, `reduce()`, `groupBy()`,
  `partitionBy()`, `byColumn()` (order-free, by column value),
  `rollingByColumn()`, `byValue(axis)` (project onto a `ValueSeries`)
- **Windowing/smoothing**: `rolling(window, spec, opts)`, `smooth(column,
method)` (EMA / Butterworth / Savitzky-Golay), `align(method, opts)`
- **Differential/statistical**: `diff()`, `rate()`, `pctChange()`,
  `cumulative()`, `scan()` (custom stateful reducer), `shift()`, `baseline()`
  (rolling avg/sd/bands), `outliers()` (deviation from baseline)
- **Join/pivot**: `join(other, opts)`, `pivotByGroup(group, opts)`

### ValueSeries methods (all in `packages/core/src/batch/value-series.ts`)

Deliberately small — the ordering-based slice of the algebra, no calendar ops
(see `docs/rfcs/value-axis.md`) — except for ingest/export, which is at full
`TimeSeries` parity.

- **Query/read**: `length`, `axisName`, `axisValues()`, `axisAt(i)`,
  `column(name)`, `nearestIndex(value)`, `sliceByValue(lo, hi)`
- **Export**: `toRows()`, `toObjects()`, `toJSON({ rowFormat })`,
  `toColumns()`, `toArrow(opts)`

### Columnar layer & support

| Export                                                                                         | Purpose                                    | Source                                         |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| `Float64Column` / `StringColumn` / `BooleanColumn` / `ArrayColumn`                             | Packed value-column storage per kind       | `packages/core/src/columnar/`                  |
| `ChunkedFloat64Column` / `ChunkedStringColumn` / `ChunkedBooleanColumn` / `ChunkedArrayColumn` | Chunked variants (variable-length buffers) | `packages/core/src/columnar/chunked-column.ts` |
| `TimeKeyColumn` / `TimeRangeKeyColumn` / `IntervalKeyColumn` / `ValueKeyColumn`                | Key-column storage per key kind            | `packages/core/src/columnar/key-column.ts`     |
| `top`                                                                                          | Reducer factory: top-N values              | `packages/core/src/reducers/top.ts`            |
| `ValidationError`                                                                              | Error class thrown on invalid input        | `packages/core/src/core/errors.ts`             |

### Key exported types (batch)

| Type group        | Names                                                                                                                                              | Source                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Schema contract   | `SeriesSchema`, `RowForSchema`, `EventForSchema`, `EventDataForSchema`, `EventKeyForSchema`, `TimeSeriesInput`, `TimeSeriesJsonInput`              | `packages/core/src/schema/index.ts`                                |
| Aggregation specs | `AggregateReducer`, `AggregateMap`, `AggregateOutputMap`, `AggregateSchema`, `BinReducerName`, `BinOutput`                                         | `packages/core/src/schema/index.ts`, `packages/core/src/column.ts` |
| Operation schemas | `RollingSchema`, `RollingAlignment`, `AlignSchema`, `DiffSchema`, `SmoothSchema`, `SmoothMethod`, `FillStrategy`, `FillMapping`                    | `packages/core/src/schema/index.ts`                                |
| Column/data kinds | `Column`, `KeyColumn`, `ColumnKind`, `ScalarKind`, `ScalarValue`, `ColumnValue`, `ArrayValue`, `ValidityBitmap`                                    | `packages/core/src/columnar/`                                      |
| JSON wire format  | `JsonRowFormat`, `JsonRowForSchema`, `JsonObjectRowForSchema`, `JsonValueForKind`, `JsonTimestampInput`, `JsonTimeRangeInput`, `JsonIntervalInput` | `packages/core/src/schema/index.ts`                                |
| Temporal utility  | `TemporalLike`, `DurationInput`, `CalendarUnit`, `TimeZoneOptions`, `KeyLike`, `BatchSampleStrategy`                                               | `packages/core/src/core/`, `packages/core/src/sequence/`           |

The `pond-ts/types` subpath re-exports the schema-as-contract types with zero
runtime (`packages/core/src/schema/public.ts`).

---

## pond-ts (core) — live / streaming

### Classes

| Export                        | Purpose                                                      | Source                                                     |
| ----------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `LiveSeries`                  | Bounded in-memory buffer of time-keyed events with retention | `packages/core/src/live/live-series.ts`                    |
| `LiveView`                    | Stateful transformation view over a live source              | `packages/core/src/live/live-view.ts`                      |
| `LivePartitionedSeries`       | Routes events into per-partition sub-buffers by column value | `packages/core/src/live/live-partitioned-series.ts`        |
| `LivePartitionedView`         | Derived per-partition view over a partitioned series         | `packages/core/src/live/live-partitioned-series.ts`        |
| `LiveAggregation`             | Emits aggregated buckets when `Sequence` boundaries cross    | `packages/core/src/live/live-aggregation.ts`               |
| `LiveRollingAggregation`      | Single-window rolling aggregation, configurable trigger      | `packages/core/src/live/live-rolling-aggregation.ts`       |
| `LiveFusedRolling`            | Multi-window rolling, shared deque, single ingest pass       | `packages/core/src/live/live-fused-rolling.ts`             |
| `LivePartitionedFusedRolling` | Fused rolling per partition, synchronized emission           | `packages/core/src/live/live-partitioned-fused-rolling.ts` |
| `LiveReduce`                  | Reduce over current buffer; emits per trigger                | `packages/core/src/live/live-reduce.ts`                    |
| `LiveColumnGroup`             | Zero-copy column gather over a view slice                    | `packages/core/src/live/live-view.ts`                      |

### Triggers

`Trigger` factory (`packages/core/src/live/triggers.ts`): `Trigger.event()`
(per-event, default), `Trigger.clock(sequence)` (boundary crossing),
`Trigger.every(duration)` (fixed cadence sugar), `Trigger.count(n)`. Types:
`EventTrigger`, `ClockTrigger`, `CountTrigger`.

### Methods

- **`LiveSeries`** — static: `LiveSeries.fromJSON()`; ingest: `push()`,
  `pushMany()`, `pushJson()`; query: same
  key-query set as `TimeSeries` (`at`/`first`/`last`/`find`/`bisect`/
  `atOrBefore`/`atOrAfter`/…); operators: `window()`, `aggregate()`,
  `rolling()`, `reduce()`, `diff()`, `rate()`, `pctChange()`, `fill()`,
  `cumulative()`, `partitionBy()`; snapshots: `toTimeSeries()`, `toRows()`;
  subscription: `on()` (event/batch/evict) → unsubscribe fn; utilities:
  `stats()`, `clear()`, `timeRange()`, `eventRate()`, `length`.
- **`LiveView`** — transform: `filter()`, `map()`, `select()`, `sample()`;
  plus the same operator/query/snapshot/subscription surface as `LiveSeries`
  (minus ingest).
- **`LivePartitionedSeries`** — `toMap()` (spawn all partitions), `apply()`
  (per-partition factory), `collect()` (fan-in unified series), `sample()`,
  `stats()`, `on()` (spawn callback).

### Key exported types (live)

`LiveSeriesOptions` (`name`, `schema`, `ordering: 'strict' | 'drop' |
'reorder'`, `graceWindow`, `retention: { maxEvents?, maxAge? }`),
`LivePartitionedOptions`, `LiveAggregationOptions`, `LiveRollingOptions`,
`RollingWindow`, `LiveFillStrategy`, `LiveFillMapping` — all under
`packages/core/src/live/`.

---

## @pond-ts/react

All hooks in `packages/react/src/<hookName>.ts`.

| Export           | Signature gist                          | Purpose                                                                            |
| ---------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `useLiveSeries`  | `useLiveSeries(opts, hookOpts?)`        | Create + own a `LiveSeries` for the component lifetime; returns it with a snapshot |
| `useTimeSeries`  | `useTimeSeries(input, key?)`            | Memoized `TimeSeries.fromJSON` for static/fetched data                             |
| `useSnapshot`    | `useSnapshot(source, opts?)`            | Subscribe to a live source, return a throttled `TimeSeries` snapshot               |
| `useWindow`      | `useWindow(source, size, opts?)`        | Windowed view of a live source + throttled snapshot                                |
| `useDerived`     | `useDerived(series, transform)`         | Batch transform of a snapshot, recomputed on change                                |
| `useLiveQuery`   | `useLiveQuery(build, deps, opts?)`      | Build a derived live view, subscribe, return view + snapshot                       |
| `useLatest`      | `useLatest(source, opts?)`              | Only the latest event                                                              |
| `useCurrent`     | `useCurrent(source, mapping, opts?)`    | Current value of a reducer over the source                                         |
| `useEventRate`   | `useEventRate(source, duration, opts?)` | Events-per-second over a trailing window                                           |
| `useLiveVersion` | `useLiveVersion(source, opts?)`         | Change signal for reading columns without a snapshot                               |
| `takeSnapshot`   | `takeSnapshot(source)`                  | Non-hook: snapshot any live source to a `TimeSeries`                               |

Types: `UseSnapshotOptions`, `SnapshotSource` (structural — covers
`LiveSeries`, `LiveView`, …), `UseCurrentOptions`, `UseLiveVersionOptions`.

---

## @pond-ts/charts

### Components — layout & axes

| Component                   | Key props                                                                                                                               | Purpose                                          | Source                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| `ChartContainer`            | `width`, `range?`, `theme?`, `cursor?`, `panZoom?`, `bounds?`, `showAxis?`, `calendar?`, `origin?`, `onTrackerChanged?`, `onDrawStats?` | Root: shared x-scale, interactions, annotations  | `packages/charts/src/ChartContainer.tsx`               |
| `ChartRow`                  | `height`, `cursor?`                                                                                                                     | One stacked plot band; owns its y-axes           | `packages/charts/src/ChartRow.tsx`                     |
| `Layers`                    | children                                                                                                                                | Mandatory z-stack inside a row (back-to-front)   | `packages/charts/src/Layers.tsx`                       |
| `YAxis`                     | `id` (req), `side?`, `min?`/`max?`, `format?`, `width?`                                                                                 | Y-axis gutter; layers bind via their `axis` prop | `packages/charts/src/YAxis.tsx`                        |
| `XAxis`                     | `side?`, `label?`, `format?`, `ticks?`, `transform?`, `dateStyle?`                                                                      | Placeable x-axis strip; kind inferred from data  | `packages/charts/src/XAxis.tsx`                        |
| `TimeAxis` / `CategoryAxis` | (XAxis props)                                                                                                                           | Thin `XAxis` presets                             | `packages/charts/src/TimeAxis.tsx`, `CategoryAxis.tsx` |
| `Canvas`                    | `width`, `height`, `draw`                                                                                                               | Low-level DPR-aware canvas primitive             | `packages/charts/src/Canvas.tsx`                       |

### Components — draw layers

All take `series` plus an `as?` style identifier (theme lookup) and `axis?`
scale id — style and scale are separate channels; there are no per-component
color props (see Theming).

| Component      | Data props                                                     | Purpose                                            | Source                                 |
| -------------- | -------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- |
| `LineChart`    | `column`, `gaps?`, `sessionBreaks?`                            | Gap-aware line                                     | `packages/charts/src/LineChart.tsx`    |
| `AreaChart`    | `column`, `baseline?`, `gaps?`                                 | Filled area                                        | `packages/charts/src/AreaChart.tsx`    |
| `BandChart`    | `lower`, `upper`                                               | Variance-band envelope                             | `packages/charts/src/BandChart.tsx`    |
| `ScatterChart` | `column`, `id?` (selection), radius/color encodings            | Points; data-driven size/colour                    | `packages/charts/src/ScatterChart.tsx` |
| `BarChart`     | `column` \| `columns` \| `bins` \| `categories`, `horizontal?` | Bars, stacked bars, histograms, categorical        | `packages/charts/src/BarChart.tsx`     |
| `BoxPlot`      | `lower`/`q1?`/`median?`/`q3?`/`upper`, `shape?`                | Box-and-whisker from quantile columns              | `packages/charts/src/BoxPlot.tsx`      |
| `Candlestick`  | OHLC columns, `variant?`, `colorBy?`, `showOHLC?`              | First-class OHLC candles (TimeSeries only)         | `packages/charts/src/Candlestick.tsx`  |
| `Legend`       | `placement?`, `items?`, `onRowClick?`, `onRowHover?`           | Series key from registered layers' resolved styles | `packages/charts/src/Legend.tsx`       |

### Components — annotations & indicators

| Component        | Key props                                             | Purpose                                        | Source                                |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| `Region`         | `from`, `to`, `label?`, `id?`, `onChange?`            | Shaded x-span; draggable when `onChange` given | `packages/charts/src/annotations.tsx` |
| `Baseline`       | `value`, `axis?`, `label?`, `indicator?`, `onChange?` | Horizontal value line                          | `packages/charts/src/annotations.tsx` |
| `Marker`         | `at`, `label?`, `indicator?`, `onChange?`             | Vertical x line                                | `packages/charts/src/annotations.tsx` |
| `YAxisIndicator` | `value?` \| `source?`, `axis?`, `format?`             | Live value pill pinned to a y-axis edge        | `packages/charts/src/indicators.tsx`  |

### Data adapters (all in `packages/charts/src/data.ts`)

| Export               | Signature gist                                         | Feeds                             |
| -------------------- | ------------------------------------------------------ | --------------------------------- |
| `fromTimeSeries`     | `(series, column) → ChartSeries`                       | Line/Area/Scatter                 |
| `bandFromTimeSeries` | `(series, lower, upper) → BandSeries`                  | BandChart                         |
| `boxFromTimeSeries`  | `(series, BoxColumns) → BoxSeries`                     | BoxPlot                           |
| `barsFromTimeSeries` | `(series, column) → BarSeries`                         | BarChart                          |
| `ohlcFromTimeSeries` | `(series, OhlcColumns) → OhlcSeries`                   | Candlestick                       |
| `stacksFromGroups`   | `(Map<string, TimeSeries>, column) → StackedBarSeries` | Stacked bars from grouped series  |
| `stacksFromColumns`  | `(series, columns[]) → StackedBarSeries`               | Stacked bars from wide columns    |
| `stacksFromBins`     | `(bins, columns[], opts?) → StackedBarSeries`          | Histograms from `byColumn` output |
| `categoryStack`      | `(CategoryDatum[]) → StackedBarSeries`                 | Categorical bars                  |
| `transposeRow`       | `(series, opts?) → CategoryDatum[]`                    | One row read across as categories |

Series shapes (same file): `ChartSeries`, `BandSeries`, `BoxSeries`,
`BarSeries`, `OhlcSeries`, `StackedBarSeries`; option types `BoxColumns`,
`OhlcColumns`, `BinRecord`, `StacksFromBinsOptions`, `CategoryDatum`, `RowAt`,
`TransposeRowOptions`.

### Theming

| Export                         | Purpose                                                                                      | Source                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `ChartTheme`                   | The one styling channel: role-keyed slots per draw layer + fixed chrome slots                | `packages/charts/src/theme.ts`                         |
| `defaultTheme` / `estelaTheme` | Built-in themes (neutral light / dark estela palette)                                        | `packages/charts/src/theme.ts`                         |
| `cssVarTheme`                  | `(base, resolve, opts?) → ChartTheme` — static CSS-custom-property overlay                   | `packages/charts/src/css-theme.ts`                     |
| `useChartTheme`                | Hook: re-resolves on `data-theme`/`class` flips (MutationObserver)                           | `packages/charts/src/useChartTheme.ts`                 |
| Style types                    | `LineStyle`, `AreaStyle`, `BandStyle`, `ScatterStyle`, `BarStyle`, `BoxStyle`, `CandleStyle` | `packages/charts/src/theme.ts`                         |
| Helper types                   | `ChartThemeOverrides`, `VarReader`, `UseChartThemeOptions`                                   | `packages/charts/src/css-theme.ts`, `useChartTheme.ts` |

### Live values, scales & key types

| Export                                     | Purpose                                                                          | Source                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------- |
| `createLiveValue` / `LiveValue`            | Imperative push channel for high-frequency indicator updates (isolated repaint)  | `packages/charts/src/indicators.tsx`      |
| `scaleTradingTime` / `TradingTimeScale`    | Discontinuous time scale collapsing closed-market gaps                           | `packages/charts/src/tradingTimeScale.ts` |
| `DiscontinuityProvider`                    | Gap topology consumed by the trading-time scale                                  | `packages/charts/src/tradingTimeScale.ts` |
| `scaleBand` / `ScaleBand`                  | Ordinal slot scale for the category axis                                         | `packages/charts/src/bandScale.ts`        |
| `GapMode`                                  | `'none' \| 'empty' \| 'dashed' \| 'step' \| 'fade'` (Line/Area `gaps` prop)      | `packages/charts/src/gaps.ts`             |
| `DecimateOption`                           | `<LineChart decimate>` — M4 viewport decimation (`bool \| { threshold }`)        | `packages/charts/src/decimate.ts`         |
| `CursorMode`                               | `'none' \| 'line' \| 'point' \| 'inline' \| 'flag' \| 'crosshair' \| 'region'`   | `packages/charts/src/context.ts`          |
| `TrackerInfo` / `TrackerSample`            | Hover readout payload (`onTrackerChanged`)                                       | `packages/charts/src/context.ts`          |
| `AnnotationKind` / `CreateSpec`            | Annotation identity + draw-gesture payload (`onCreate`)                          | `packages/charts/src/context.ts`          |
| `SelectInfo`                               | Selection/hover payload (`ChartContainer` `onSelect`/`onHover`)                  | `packages/charts/src/context.ts`          |
| `DrawStatsFrame` / `LayerDrawInfo`         | Per-repaint draw-cost + decimation stats (`ChartContainer` `onDrawStats`)        | `packages/charts/src/context.ts`          |
| `TimeGrain`                                | Coarse time unit for grain-aware formatting                                      | `packages/charts/src/tickLadder.ts`       |
| `SwatchSpec` / `LegendItemInput`           | Legend swatch vocabulary + explicit-rows input (`<Legend items>`)                | `packages/charts/src/swatch.ts`           |
| `useChartLegend`                           | Headless legend hook: rows (items grouped by chart row) + `hover`/`select` verbs | `packages/charts/src/useChartLegend.ts`   |
| `ChartLegend` / `LegendRow` / `LegendItem` | The hook's return shape (`rows` group `items`; items carry `selected`/`hovered`) | `packages/charts/src/useChartLegend.ts`   |
| `LegendPlacement`                          | `'top-left' \| 'top-right' \| 'bottom-left' \| 'bottom-right'`                   | `packages/charts/src/Legend.tsx`          |
| `Curve`                                    | Path interpolation: `'linear' \| 'monotone' \| 'natural' \| 'basis' \| 'step'`   | `packages/charts/src/curve.ts`            |
| `RadiusEncoding` / `ColorEncoding`         | Data-driven scatter size/colour                                                  | `packages/charts/src/encoding.ts`         |
| `CandleVariant` / `ColorBy`                | OHLC mark shape / colouring strategy                                             | `packages/charts/src/ohlc.ts`             |
| `AxisFormat` / `CursorFormat`              | Tick and cursor-readout formatting (d3 specifier or fn)                          | `packages/charts/src/format.ts`           |
| `AxisTransform`                            | Monotonic `to`/`from` pair for derived-unit x-axis relabeling                    | `packages/charts/src/derivedTicks.ts`     |
| `Orientation`                              | Bar growth direction                                                             | `packages/charts/src/bars.ts`             |

---

## @pond-ts/financial

### Studies (each also a fluent method after `import '@pond-ts/financial/fluent'`)

All are pure `(series, options) → TimeSeries` appending output columns;
`column` defaults to `'close'`; periods are bar counts; warm-up is
length-preserving (`undefined` head rows).

| Study                       | Output column(s)                    | Options gist                                        | Source                                             |
| --------------------------- | ----------------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| `sma`                       | `sma`                               | `{ period, column?, output? }`                      | `packages/financial/src/studies/moving-average.ts` |
| `ema`                       | `ema`                               | `{ period, column?, output? }` (α = 2/(period+1))   | `packages/financial/src/studies/moving-average.ts` |
| `bollinger`                 | `bbMiddle`, `bbUpper`, `bbLower`    | `{ period, stdDev?, column?, prefix? }`             | `packages/financial/src/studies/bollinger.ts`      |
| `envelope`                  | `envMiddle`, `envUpper`, `envLower` | `{ period, percent?, maType?, column?, prefix? }`   | `packages/financial/src/studies/envelope.ts`       |
| `rollingStdev`              | `stdev`                             | `{ period, column?, output? }` (population, ddof=0) | `packages/financial/src/studies/rolling-stat.ts`   |
| `rollingMin` / `rollingMax` | `min` / `max`                       | `{ period, column?, output? }` (Donchian edges)     | `packages/financial/src/studies/rolling-stat.ts`   |
| `rollingPercentile`         | `p{q}` (e.g. `p90`)                 | `{ period, q, column?, output? }`                   | `packages/financial/src/studies/rolling-stat.ts`   |
| `zScore`                    | `zscore`                            | `{ period, column?, output? }`                      | `packages/financial/src/studies/z-score.ts`        |
| `percentChange`             | `pctChange`                         | `{ periods?, column?, output? }`                    | `packages/financial/src/studies/percent-change.ts` |

Adding a study? Follow `packages/financial/src/studies/README.md` (uniform
shape + pandas oracle case + fluent method are all REQUIRED).

### Trading calendars & sessions

| Export                                                           | Purpose                                                                                                                                                                              | Source                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| `TradingCalendar`                                                | Query API: `.sessions()`, `.sessionOn()`, `.isTradingDay()`, `.isOpen()`, `.sessionsInRange()`, `.sessionSequence()`, `.barSequence(period)`, `.tagSessions()`, `.discontinuities()` | `packages/financial/src/calendar/` |
| `generateSessions`                                               | `Session[]` from `SessionRules` over a date range (DST-correct)                                                                                                                      | `packages/financial/src/calendar/` |
| `normalizeSessions`                                              | Validate + sort an explicit session list                                                                                                                                             | `packages/financial/src/calendar/` |
| `identityDiscontinuity` / `segmentDiscontinuity` / `weekendSkip` | `DiscontinuityProvider`s for the trading-time axis                                                                                                                                   | `packages/financial/src/calendar/` |
| Types                                                            | `Session`, `SessionBreak`, `SessionRules`, `DateRange`, `InstantRange`, `TaggedSchema`, `LiveSegment`, `DiscontinuityProvider`                                                       | `packages/financial/src/calendar/` |

### Contract & constants

`OhlcvColumns` (column-name contract), `DEFAULT_OHLCV`
(`{ open, high, low, close, volume }`), `DEFAULT_SOURCE` (`'close'`) —
`packages/financial/src/contract/`. `RollingReducer` (reducer-name union used
by studies) — `packages/financial/src/kernels/rolling.ts`.

---

## @pond-ts/fit

| Group                | Exports                                                                                                                                                                                                                                                                                                                      | Source                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Activity model types | `ImportedActivity`, `ActivityMeta`, `ActivityStreams`, `Lap`, `GeoPoint`, `ActivitySource`                                                                                                                                                                                                                                   | `packages/fit/src/types.ts`                        |
| Activity façade      | `Activity` (`Activity.fromStreams(imported)`), `Section`, `ProfiledActivity`, `ProfiledSection`, `Sample`, `SectionMetrics`                                                                                                                                                                                                  | `packages/fit/src/activity/`                       |
| Summary pipeline     | `computeActivitySummary`, `prepareActivity` → `summaryFromPrepared` (reuse decode), `windowChannels` (zoom re-bucketing), `buildTrackFromStreams` (pond series from streams); types `ActivitySummary`, `PreparedActivity`, `ChannelProfile`, `ChannelSample`, `ChannelKey`                                                   | `packages/fit/src/summary/`                        |
| Track & geo          | `Track` (`Track.of(points)`), `polylineCumulative`, `interpolateAtDistance`, `polylineSlice`, `boundsOf`, `bestEffortsByDistance`, `segmentsInRange`                                                                                                                                                                         | `packages/fit/src/track/`, `packages/fit/src/geo/` |
| Power analytics      | `computePower` (NP/IF/TSS/zones; `{ binWatts }` sets the histogram bucket width), `powerBestEfforts`; types `PowerSummary`, `PowerZone`, `PowerBin`, `PowerCurvePoint`, `PowerEffort`, `ComputePowerOptions`. `PowerBin`/`PowerZone` carry pond's canonical `start`/`end` bin edges, so they feed `@pond-ts/charts` unmapped | `packages/fit/src/power/`                          |
| Profile & zones      | `Profile`, `hydrateProfile`, `profileAsOf`, `hrZonesFrom`, `paceZonesFrom`, `powerZonesFrom` (Coggan from FTP)                                                                                                                                                                                                               | `packages/fit/src/profile/`                        |
| Zone distribution    | `zoneDistributionByValue`, `hrZoneDistribution`, `paceZoneDistribution`, `ZoneTime` (canonical `start`/`end` edges + `openEnded`; chart-ready)                                                                                                                                                                               | `packages/fit/src/zones/`                          |
| Quantities           | Value objects with canonical units: `Distance`, `Elevation`, `Duration`, `Speed`, `Pace`, `Power`, `HeartRate`, `Cadence`                                                                                                                                                                                                    | `packages/fit/src/quantities.ts`                   |
| Units                | `convertDistance` / `convertElevation` / `convertTemperature` / `convertSpeed`, `metersToMiles`, `metersToFeet`, `formatDuration`, `formatPace`, `*UnitLabel` helpers, `DEFAULT_UNITS`                                                                                                                                       | `packages/fit/src/units.ts`                        |

---

### `@pond-ts/financial/parallel` (Node-only, opt-in)

`withWorkers(series, { workers })` — opts a series into partitioned rolling
studies and returns it unchanged; `shutdownWorkers()`; `parallelDispatches()`;
`MIN_ROWS`; type `WithWorkersOptions`. Chosen **once at ingest**: the studies keep their
signatures and stay synchronous, and derived series inherit it (registration is
keyed on the key-column buffer). **Single-threaded remains the default** — the
main package never imports this. Node-only by construction: `Atomics.wait` on
the main thread is what keeps the studies synchronous, and browsers forbid it.

Accelerates any rolling study asking for `avg`/`stdev` off one column — `sma`,
`envelope`, `bollinger` — at 1.85×/1.35×/1.92×. **Partitioning does not change
the answer**: since [PND-PROCKERN] the kernel's accumulator rebuilds are pinned
to absolute row index, so a chunk reconstructs exactly the state a whole-column
pass held and the partitioned result is bit-identical. **`zScore` is not
accelerated**: [PND-SHIFTFRAME] moved it onto a shifted-frame kernel this pool
does not hook, so opting in neither speeds it up nor changes its answer. It used
to be the fastest entry here at 2.44×, and the only one whose error had no bound.
Below `MIN_ROWS` a registered series still runs sequentially and is
bit-identical. `parallelDispatches()` returns how many passes have actually run
on workers — acceleration is otherwise invisible, since a declined pass returns
the same answer, only slower than you expected. Source:
`packages/financial/src/parallel/`.

## @pond-ts/process

**Work in progress — `private: true`, not published, public shape expected to
change** (RFC [process.md](docs/rfcs/process.md) concludes the declarative plan
layer is the consumer surface with this engine internal beneath it; tracked as
[PND-PROCSUB]). Listed here because agents work in this repo, not because it is
a stable surface. Tickets: [PND_PROCESS_PLAN.md](docs/plans/PND_PROCESS_PLAN.md).

Typed dataflow graphs for pipelines whose **shape is data** (runtime-assembled,
user-edited, one computation fanned out to several consumers). Chaining stays
the default for pipelines known at authoring time — see the package README.

| Group                   | Exports                                                                                                                                                                                                                                                                                                                                                                              | Source                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Worker pool (Node)      | `HostPool` (`start`, `run`, `close`, `size`, `inFlight`); types `HostPoolOptions`, `PoolSetup`, `PoolSetupConfig`; `toWire` / `fromWire`, types `WireResult`, `WireColumn` — subpath `@pond-ts/process/pool`                                                                                                                                                                         | `packages/process/src/pool/index.ts`                 |
| Ports                   | `Inlet`, `Outlet` (typed fields on `node.in` / `node.out`; `get()`, `peek()`, `version`, `connect`, `disconnect`)                                                                                                                                                                                                                                                                    | `packages/process/src/port.ts`                       |
| Nodes                   | `Node` (`in`, `out`, `dirty`, `error`, `invalidate()`), `defineNode` (reusable multi-output node type), `derive` (single-output, wired inline)                                                                                                                                                                                                                                       | `packages/process/src/node.ts`                       |
| Port declaration        | `port<T>({ equals, defaultValue })`; types `PortSpec`, `PortSpecMap`, `PortValue`, `PortValues`                                                                                                                                                                                                                                                                                      | `packages/process/src/types.ts`                      |
| Sources                 | `source<T>()` → `SourceNode` (`set()`), `fromLive(liveSource)` → `LiveSourceNode` (`dispose()`); `GraphSource` (bind contract — looser than core's `LiveSource`, accepts `LiveAggregation`), `SnapshotSource`, `NoInputs`                                                                                                                                                            | `packages/process/src/source.ts`                     |
| Graph view              | `Graph` (`Graph.from(...roots)`, `nodes`, `order()`, `edges()`, `toJSON()`); types `GraphEdge`, `GraphJson`, `GraphNodeJson`, `GraphEdgeJson`                                                                                                                                                                                                                                        | `packages/process/src/graph.ts`                      |
| Node budget             | `bind(series, { registry, budgetBytes })` — engine-wide cap on retained node values, LRU, enforced after each `run`; `graph.retainedBytes` / `graph.evictions` / `graph.enforceBudget()`. Unbounded when omitted. Skips a node whose consumer still holds its outlet                                                                                                                 | `packages/process/src/plan/graph.ts`                 |
| Plan history            | `requiredHistory(registry, plan)` → `{ known, rows?, undeclared, byOp }` — the minimum safe tail in rows, folded from per-op `OpDef.lookback`. Sums along nesting, maxes across siblings. `known: false` names ops with no declared lookback rather than defaulting to zero (type `HistoryResult`)                                                                                   | `packages/process/src/plan/history.ts`               |
| Column values           | `packColumn` (values → packed `Float64Column`, NaN = missing), `columnBytes` (retained size, for a byte budget), `appendColumn` (column → series; boxing-free when gapless), `columnBuffers` / `columnFromBuffers` (the buffer pair a column is, for an isolate boundary; type `ColumnBuffers`), `columnView` (zero-copy borrowed read view for in-process folds; type `ColumnView`) | `packages/process/src/column.ts`                     |
| Plan — registry         | `createRegistry({ folds })` / `Registry` (`define`, `get`, `foldFor`, `outputsOf`, `resolveParams`, `byFamily`, `describe`, `toJsonSchema`), param builders `int` / `num` / `choice` / `flag`, `UnknownOpError`, `ParamError`                                                                                                                                                        | `packages/process/src/plan/registry.ts`, `params.ts` |
| Plan — identity         | `specId` (content-addressed, param-order invariant, defaults materialized), `refToId`, `explain`, `unitOf`, `columnsOf`, `dependsOn`, `outputKey`                                                                                                                                                                                                                                    | `packages/process/src/plan/identity.ts`              |
| Plan — types            | `Spec`, `Plan`, `Input` (column name \| `Spec` \| `PickedOutput`), `SpecRef`, `Def` (`OpDef` \| `FoldDef`), `OpContext`, `OpResult`, `FoldContext`, `FactBody`, `isFold`, `ParamDef`, `Params`, `Units`, `InputDef`, `OutputDef`                                                                                                                                                     | `packages/process/src/plan/types.ts`                 |
| Plan — bind / run       | `bind(series, { registry, units })` → `BoundGraph` (`compile`, `setSource`, `ids`, `series`, `columnOf`), `run(graph, { plan, select, onError })` → `RunResult`, `UnitError`                                                                                                                                                                                                         | `packages/process/src/plan/graph.ts`, `run.ts`       |
| Plan — request/response | `RunRequest` (`PlanRequest` \| `SlotRequest`), `RunOptions`, `RunResult`, `Select` (`{ on, output?, name? }` — points at a node; what comes back is what that node produces), `ErrorPolicy`, `Fact` (carries `op`), `OutputInfo`, `Skipped`, `NodeTiming` (`slot`, `pulled`, `cached`, `ms`, `inputs`)                                                                               | `packages/process/src/plan/run.ts`                   |
| Plan — host             | `createHost({ registry, units, sources })` → `Host` (`add`, `has`, `datasets`, `graphFor`, `run`, `runAsync`), `toWire`, `UnknownDatasetError`; local-string `Envelope` (`PlanEnvelope` \| `SlotEnvelope`), remote-capable `AsyncEnvelope` (`AsyncPlanEnvelope` \| `AsyncSlotEnvelope` \| `Envelope`), `DatasetInfo`, `WireResult`                                                   | `packages/process/src/plan/host.ts`                  |
| Plan — slots            | `expandSlots(slots, columns)` → `Map<slot, Spec>` (expands to the nested form, so ids match by construction; `slot#Output` picks one output), `SlotError`; types `SlotDef` (`{ op, params, in }`), `Slots`                                                                                                                                                                           | `packages/process/src/plan/slots.ts`                 |
| Plan — builder          | `plan(from)` → low-level `PlanBuilder`; `process(registry, from)` → typed fluent `ProcessBuilder` (`column`, op methods, `outputs`), `BuilderError`; types `NodeHandle`, `OutputHandle`, `FluentColumnRef`, `SingleColumnNode`, `MultiColumnNode`, `ColumnSelection`, `FactRef`, `BuiltRequest`                                                                                      | `packages/process/src/plan/builder.ts`, `fluent.ts`  |
| Plan — async sources    | `defineSource({ name, load })`, `createSourceRegistry()` / `SourceRegistry`, `sourceId`, `UnknownSourceError`; types `SourceRef`, `SourceParams`, `LoadedSource` (value + revision), `SourceLoadContext`, `SourceDef`                                                                                                                                                                | `packages/process/src/plan/source.ts`                |
| Plan — folds            | `STANDARD_FOLDS` and the four it holds — `last`, `extremes`, `percentileRank`, `shape` — pre-registered by `createRegistry()`; each a plain `FoldDef`, so a consumer can `define` over one                                                                                                                                                                                           | `packages/process/src/plan/folds.ts`                 |
| Errors                  | `ProcessError` (base), `CycleError`, `UnconnectedInputError`, `MissingOutputError`, `UnsetSourceError`                                                                                                                                                                                                                                                                               | `packages/process/src/errors.ts`                     |
| Node type helpers       | `NodeSpec`, `NodeFactory`, `InletsFor`, `OutletsFor`, `OutletValue`, `SpecsForOutlets`, `DerivedOutput`                                                                                                                                                                                                                                                                              | `packages/process/src/node.ts`                       |

Note: this package's `npm test` includes a `test:dts` step that typechecks the
**emitted** `dist/*.d.ts` from a consumer's perspective (`test-dts/`,
`skipLibCheck: false`). The package's own build sets `skipLibCheck: true` and
never checks its own output, so a declaration referencing a type `stripInternal`
deleted builds green and breaks only downstream. If you mark something
`@internal`, confirm no public signature names it.

---

## Cross-package seams (where agents most often need the joint)

- **Batch → charts**: a draw layer takes a pond `series` + `column` directly;
  the `data.ts` adapters are the explicit versions of what layers do
  internally. Histogram path: `series.byColumn(...)` → `stacksFromBins(...)` →
  `<BarChart bins>`.
- **Live → react → charts**: `LiveSeries` → `useSnapshot`/`useWindow` →
  the same layer props a batch chart uses (no separate live-mode API).
- **Financial → charts**: `TradingCalendar.discontinuities()` →
  `ChartContainer calendar` (trading-time axis); studies append columns that
  `LineChart`/`BandChart` draw (`bbUpper`/`bbLower` → `BandChart`).
- **Core → financial**: studies compose on core kernels; fluent methods mutate
  `TimeSeries.prototype` (runtime import of `@pond-ts/financial/fluent`
  required).
- **Live → process**: `fromLive(liveSeries)` binds a live source as a graph
  input. Events only mark the node dirty; the snapshot runs once at the next
  pull, so per-event incremental work stays in the live layer and the graph
  composes batch transforms over snapshots. The graph has **no partial
  invalidation** — a dirty node recomputes from a whole snapshot — so for
  windowed work bind the _aggregation_ (`fromLive(live.aggregate(...))`),
  which materializes bucket count rather than event count (235x per pull on
  a 50k buffer). Tradeoff: a live aggregation exposes closed buckets only,
  so the in-progress bucket is invisible until it closes.
