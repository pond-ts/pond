# Handoff: LiveView column-read spike → dashboard agent

> _From the pond-ts library agent (Claude) to the dashboard agent
> (Claude). Branch: `spike/liveview-column-read`. This is the §A prong-2
> prototype your 0.18.0 report ranked #1 ("column API on `LiveView`")._

## TL;DR

Read columns straight off a live view — no `useWindow` `TimeSeries`
snapshot, no per-partition `TimeSeries`. In a clean-room pond bench the
shipped method is **5.6–10× faster** than today's
`snapshot.partitionBy().toMap()` chain. **Your job: wire it into the real
dashboard memo and measure the in-situ A/B** — that number, not the
in-pond one, decides whether this becomes real API. Nothing merges
without it + a human sign-off.

## What the branch gives you

**Core (`pond-ts`), on `LiveView`:**

```ts
view.column(name); // Float64Column | ChunkedFloat64Column (schema-narrowed)
view.keyColumn(); // TimeKeyColumn — .begin is a Float64Array
view.partitionBy(col).toMap(fn); // Map<partitionValue, ReturnType<fn>>
//   fn receives a LiveColumnGroup with .length / .column(name) / .keyColumn()
```

`partitionBy().toMap()` is **walk-now**: it buckets the view's _current_
events by `col` and gathers only the columns `fn` reads — no
`TimeSeries`, no per-partition `TimeSeries`. Same call shape as
`TimeSeries.partitionBy().toMap()`, so the callback is unchanged. (This
is **not** `LiveSeries.partitionBy`, which is the subscription-oriented
live sub-series — different shape, same name on a different class.)

**React (`@pond-ts/react`):**

```ts
useLiveVersion(source, { throttle }): number
```

The change signal. `LiveView`/`LiveSeries` mutate in place, so a
`useMemo([view])` never re-runs — this gives React a version that bumps
(at most once per `throttle` ms) when the source appends. Built on
`useSyncExternalStore` (tearing-safe). The version bumps _immediately_ on
append; `throttle` only bounds the React notification (no buffering).

## Install the pinned build

The spike isn't published. Local-link the branch:

```bash
# in your pond-ts checkout
git fetch && git checkout spike/liveview-column-read
npm install && npm run build          # builds both packages' dist/

# in pond-ts-dashboard, point deps at the local checkout
#   "pond-ts": "file:../pond-ts/packages/core",
#   "@pond-ts/react": "file:../pond-ts/packages/react"
npm install
```

(If `file:` linking fights your bundler, ping me and I'll cut a
`0.19.0-spike.0` prerelease you can `npm install` from the registry.)

## The migration (near-mechanical)

Keep **both** paths behind a flag so you can A/B them. Before:

```tsx
const snap = useWindow(baseline, '5m', { throttle: 200 });
const series = useMemo(
  () =>
    snap?.partitionBy('host').toMap((g) => ({
      xs: g.keyColumn().begin,
      cpu: g.column('cpu').toFloat64Array(),
      avg: g.column('avg').toFloat64Array(),
      sd: g.column('sd').toFloat64Array(),
    })) ?? new Map(),
  [snap],
);
```

After (no snapshot):

```tsx
const view = useMemo(() => baseline.window('5m'), [baseline]);
const v = useLiveVersion(view, { throttle: 200 });
const series = useMemo(
  () =>
    view.partitionBy('host').toMap((g) => ({
      xs: g.keyColumn().begin,
      cpu: g.column('cpu').toFloat64Array(),
      avg: g.column('avg').toFloat64Array(),
      sd: g.column('sd').toFloat64Array(),
    })),
  [view, v],
);
```

The `.partitionBy('host').toMap(g => …)` body is identical. Only the
source (`view` not `snap`) and the memo key (`v` not `snap`) change.

## What to measure (the gating number)

Run the A/B in the **real dashboard memo**, both paths, at:

- the current cell (~8 hosts / 12k events), and
- a stress cell (push toward 256 hosts / 384k events).

Report:

1. **Per-tick memo time**, snapshot vs live-view, at each cell.
2. **GC / allocation behavior** at the stress cell — does it stop scaling
   with window length? (The whole point of skipping the snapshot +
   per-partition `TimeSeries`.)
3. **Anything that didn't compose** — type friction, an ergonomic that
   fought you, a missing accessor.

## Honest framing to carry back

- The in-pond **~8.4×** (256-host cell) is the **primitive** win
  (snapshot-build + partition + gather, all skipped). **Your memo's win =
  that chain's share of your per-tick cost.** The sigma-band arithmetic
  is unchanged in both paths, so Amdahl applies — if sigma dominates,
  your in-situ number is smaller than 8×. That's expected and fine;
  report what you actually see.
- This is the **allocation-skip cut**: `column()` still _builds_ the
  typed array from events each tick (it just skips the `TimeSeries`
  machinery). True zero-copy ingest→canvas needs `LiveView` to hold the
  window structurally (chunk slices) — that's increment 2, not this.

## Limits of the prototype (by design)

- **Number / boolean value columns + time keys only.** `column()` on a
  string/array column throws a clear message pointing at `toTimeSeries()`;
  non-time keys throw. (Read the partition key as a scalar via
  `at(i).get(col)` — that's what `partitionBy` does internally.)
- Shape is **not stable** — names (`partitionBy` on `LiveView`,
  `useLiveVersion`) and the surface are exactly what the sign-off will
  decide. If a name reads wrong while you use it, that's useful feedback.

## Report back as

Per the experiment model: (1) friction notes (library-actionable), (2)
the bench/A-B numbers, (3) the working memo diff. Drop them wherever your
friction notes live and ping the library agent — the in-situ number
gates the real implementation + API sign-off, and feeds whether increment
2 (structural/zero-copy) is worth building.

## References

- Brief: `docs/briefs/column-on-liveview-spike.md` (the why + the four
  decisions + the Codex review).
- In-pond bench: `packages/core/scripts/perf-liveview-columns.mjs`
  (`node --expose-gc …`).
- Prototype: `packages/core/src/live/live-view.ts` (`column` / `keyColumn`
  / `partitionBy` + `LiveColumnGroup`), `packages/react/src/useLiveVersion.ts`.
