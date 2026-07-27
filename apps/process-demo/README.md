# process-demo

Three panels — **composer**, **request**, **results**. You ask for a study
in plain English, a model turns it into a process plan as JSON, the plan
resolves against a long-lived bound graph, and you see both the plan and
what came back.

It is a demo, but its job is to **decide the library's shape**. This is M2
of [PND_PROCESS_DEMO_PLAN.md](../../docs/plans/PND_PROCESS_DEMO_PLAN.md),
and it exists to answer [PND-PROCSCHEMA]: is `registry.toJsonSchema()`
enough for a caller to compose valid plans with no prose hand-holding?
Charts are M3, the clickable pipeline is M4 — every panel here renders
raw JSON on purpose.

## Running it

The packages are linked with `file:` deps, so build them first:

```bash
npm install                                                    # repo root
npm run build --workspace=pond-ts --workspace=@pond-ts/process # repo root
cd apps/process-demo && npm install
npm run dev
```

`http://localhost:5173` for the UI, `http://localhost:8787` for the API.

To run the actual experiment rather than the offline fallback, export a
key first — see `.env.example`:

```bash
export ANTHROPIC_API_KEY=…
npm run dev
```

Without one, the composer falls back to a keyword matcher. That fallback
exists so the panels, the run path and the UI are exercisable with no
network, and it is labelled everywhere it appears, because **it settles
nothing about the registry**.

## What to look at

- **The badge row in Results.** Amber `computed`, green `cached`, per node,
  in dependency order. Hit **Re-run** and watch a 100 ms request become a
  5 ms one. That is the whole architectural claim from M1, made visible —
  the `Host` is module scope in `server/index.ts` and outlives every
  request, and a graph built per request would start cold every time.
- **The Skipped box.** The envelope is **editable**: break a plan on
  purpose and re-run it without going back through a model. An unknown op
  comes back naming every op that does exist; a typed-input violation names
  both sides. Those reasons are what a caller retries against, and how good
  they are is a registry finding.
- **`explain`, under each badge.** Never hand-built — it is the lineage the
  library derives, and it is what M4 will label pipeline nodes with.

## Shape

```
server/
  ops.ts       11 ops over 6 families — the vocabulary under test.
               Deliberately includes a multi-output op (bollinger) and a
               typed input (annualise demands 'variance').
  data.ts      Seeded 5m bars, 150k rows each, deterministic — no
               Math.random, so a number in a friction note reproduces.
  compose.ts   The agent seam. `anthropicComposer` is the experiment;
               `scriptedComposer` is the offline stand-in.
  index.ts     One long-lived Host. /api/context, /api/compose,
               /api/run, /api/ask.
web/           The three panels.
```

## Notes for anyone extending it

- **This app is outside the root `workspaces` on purpose**, following the
  `workers/` precedent, so a demo build can never gate a release. The cost
  is that the root `format:check` and `verify` do not cover it — run
  `npm run verify` in this directory.
- The demo's rolling ops are the naive O(rows × period) implementations.
  That is a demo artefact, not a library one; it makes cold runs slow
  enough that the warm/cold difference is unmistakable.
- The tool schema is assembled in `compose.ts:requestSchema`. Note the two
  `$ref`s into `#/properties/process/items` — one for nesting an input, one
  for a selector naming a spec inline. Both depend on
  `toJsonSchema({ base })`, because a `$ref` resolves against the document
  root and the projection is not at the root here.
