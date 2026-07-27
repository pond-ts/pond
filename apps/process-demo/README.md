# process-demo

Three panels — **composer**, **request**, **results**. You ask for a study
in plain English, a model turns it into a process plan as JSON, the plan
resolves against a long-lived bound graph, and you see both the plan and
what came back.

It is a demo, but its job is to **decide the library's shape**, per
[PND_PROCESS_DEMO_PLAN.md](../../docs/plans/PND_PROCESS_DEMO_PLAN.md).
M2 asked whether `registry.toJsonSchema()` is enough for a caller to
compose valid plans with no prose hand-holding ([PND-PROCSCHEMA]); M3
asked how a column value reaches a chart ([PND-PROCCOL]); M4 is the
payoff the first three were staging; M5 answers [PND-PROCIDENT] by
watching a conversation rather than arguing about identity.

## Running it

The packages are linked with `file:` deps, so build them first:

```bash
npm install                                                    # repo root
npm run build --workspace=pond-ts --workspace=@pond-ts/process # repo root
cd apps/process-demo && npm install
npm run dev
```

`http://localhost:5173` for the UI, `http://localhost:8787` for the API.

To run the actual experiment rather than the offline fallback, put a key
in `apps/process-demo/.env` (gitignored; see `.env.example`). The server
loads it itself via `process.loadEnvFile`, so the key reaches only this
process:

```
ANTHROPIC_API_KEY=…      # preferred, if you have one
OPENAI_API_KEY=…         # otherwise
```

Anthropic wins when both are set. **An empty value counts as absent** —
`.env.example` ships empty placeholders, and treating `''` as "present"
routes to a provider with no credential.

Without either, the composer falls back to a keyword matcher. That fallback
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
- **The `graph` tab, and clicking a node.** This is the point of the whole
  demo. The pipeline is drawn from the response: the label is the lineage
  the library derived, the badge is the same warm/cold data the raw tab
  shows, and the edges come from `node.inputs`. Click a node — _any_ node,
  including an intermediate the plan never named at its top level — and
  Results draws that node's output. It is one more selector on an id the
  response already gave you. In a fold you would have had to retain that
  intermediate deliberately and invent a name for it.
- **The `viz` tab.** Columns are fetched _lazily_, only when you switch to
  it, because a column is ~1.2 MB per study here and a reduction is a few
  bytes. The side effect is the clearest cache demo in the app: every node
  comes back `cached` and what you wait for is purely the wire. A
  multi-output op draws as a band rather than three lines, and nothing in
  `Viz.tsx` inspects op names to work that out — it reads
  `outputs[id].length`.

## Shape

```
server/
  ops.ts       11 ops over 6 families — the vocabulary under test.
               Deliberately includes a multi-output op (bollinger) and a
               typed input (annualise demands 'variance').
  data.ts      Seeded 5m bars, 150k rows each, deterministic — no
               Math.random, so a number in a friction note reproduces.
  compose.ts   The agent seam, and the Claude implementation;
               `scriptedComposer` is the offline stand-in.
  compose-openai.ts
               The second vendor. A finding that holds across two
               independent tool-calling implementations is evidence
               about the projection rather than about one API.
  frames.ts    Columns → base64 `Float64Array` for the wire, and the
               reasoning for why that rather than an assembled series.
  index.ts     One long-lived Host. /api/context, /api/compose,
               /api/run, /api/ask.
web/
  App.tsx      The three panels.
  Viz.tsx      The `viz` tab — decode, `TimeSeries.fromColumns`, chart.
  Pipeline.tsx The `graph` tab — dagre layout over `nodes` + `inputs`.
```

## The two scripts

- `scripts/refinement-run.mjs` — M5's experiment. Four turns ending in
  "back to how it was"; prints the warm/cold badge for every node and the
  resident node count afterwards. Needs a key.
- `scripts/strict-schema-probe.mts` — runs the registry's projection
  through the OpenAI SDK's own `toStrictJsonSchema`. No API calls, and
  worth knowing it is **more permissive than the server**: it accepted a
  `oneOf` and a body-pointer `$ref` that live calls rejected.

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
