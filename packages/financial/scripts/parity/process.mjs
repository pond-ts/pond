/**
 * Process-bridge parity fixture: what `@pond-ts/financial/process` makes of
 * the study catalog, recorded so the Rust port (`crates/pond-process`) can
 * check its own bridge gives the same ops, ids and answers.
 *
 * The study maths is checked elsewhere (`study-parity.json`, bit for bit).
 * This file checks the bridge on top of it: each op's `describe()` entry
 * (params, defaults, roles, outputs, units), its spec id with default
 * params, and a run of every study through a `Host`, as an agent would
 * send it.
 *
 * `buildProcessFixture(pond, proc, bridge)` runs against the compiled
 * packages (`generate.mjs` writes `test/fixtures/process-parity.json`) and
 * against source (`test/process-parity.test.ts`, which fails if the
 * committed file is stale).
 */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);

// A repeatable [0, 1) sequence (no Math.random).
const unit = (i, mult) => ((i * mult) % 4294967291) / 4294967291;

/**
 * 800 daily OHLCV bars, with a gap in `close` and one in `volume`. Long
 * enough that every study's warm-up ends (`specialK` needs 724 bars), so
 * every output column has numbers to compare (zigZag's default run aside:
 * the bars never swing 5%, so an extra run takes 1%).
 */
function bars() {
  let price = 100;
  const rows = [];
  for (let i = 0; i < 800; i += 1) {
    const open = price;
    price += (unit(i + 1, 2654435761) - 0.5) * 3;
    const close = price;
    const high = Math.max(open, close) + unit(i + 7, 40503) * 1.5;
    const low = Math.min(open, close) - unit(i + 11, 69069) * 1.5;
    const volume = 1000 + Math.round(unit(i, 48271) * 500);
    rows.push([
      T0 + i * DAY,
      Math.round(open * 100) / 100,
      Math.round(high * 100) / 100,
      Math.round(low * 100) / 100,
      i === 40 ? null : Math.round(close * 100) / 100,
      i === 55 ? null : volume,
    ]);
  }
  return {
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'open', kind: 'number', required: false },
      { name: 'high', kind: 'number', required: false },
      { name: 'low', kind: 'number', required: false },
      { name: 'close', kind: 'number', required: false },
      { name: 'volume', kind: 'number', required: false },
    ],
    rows,
  };
}

/** The column each input role reads. */
const COLUMN_OF = {
  column: 'close',
  open: 'open',
  high: 'high',
  low: 'low',
  close: 'close',
  volume: 'volume',
  benchmark: 'open',
};

/** A few non-default params, and two that a registry must refuse. */
const EXTRA = [
  { op: 'sma', params: { period: 5 } },
  { op: 'ema', params: { period: 200 } },
  { op: 'rsi', params: { period: 2 } },
  // The bars swing less than zigZag's default 5%, so give it a 1% one.
  { op: 'zigZag', params: { deviation: 1 } },
  { op: 'sma', params: { period: 0 } },
  { op: 'sma', params: { period: 2.5 } },
];

function caught(e) {
  return {
    code: e?.code ?? null,
    name: e?.name ?? null,
    message: e instanceof Error ? e.message : String(e),
  };
}

function cells(column) {
  const out = [];
  for (let i = 0; i < column.length; i += 1) {
    const v = column.at(i);
    out.push(v === undefined || !Number.isFinite(v) ? null : v);
  }
  return out;
}

function response(proc, result) {
  const out = JSON.parse(JSON.stringify(proc.toWire(result)));
  out.nodes = out.nodes.map(({ ms, ...rest }) => rest);
  if (result.columns !== undefined) {
    out.columns = Object.fromEntries(
      Object.entries(result.columns).map(([k, c]) => [k, cells(c)]),
    );
  }
  return out;
}

export function buildProcessFixture(pond, proc, bridge) {
  const ops = bridge.studyOps();
  let registry = proc.createRegistry();
  for (const def of ops) registry = registry.define(def);
  const input = bars();
  const host = proc.createHost({ registry });
  host.add('d', pond.TimeSeries.fromJSON(input));

  const specs = [
    ...ops.map((def) => ({
      op: def.name,
      inputs: def.inputs.map((i) => COLUMN_OF[i.role]),
    })),
    ...EXTRA.map(({ op, params }) => {
      const def = ops.find((d) => d.name === op);
      return { op, params, inputs: def.inputs.map((i) => COLUMN_OF[i.role]) };
    }),
  ];
  const runs = specs.map((spec) => {
    let id;
    try {
      id = { id: proc.specId(registry, spec) };
    } catch (e) {
      id = { error: caught(e) };
    }
    let result;
    try {
      result = {
        result: response(
          proc,
          host.run({
            from: 'd',
            process: [spec],
            select: [{ on: spec }],
            onError: 'collect',
            assemble: false,
          }),
        ),
      };
    } catch (e) {
      result = { error: caught(e) };
    }
    return { spec, ...id, ...result };
  });

  return JSON.parse(
    JSON.stringify({
      input: pond.TimeSeries.fromJSON(input).toJSON(),
      describe: registry.describe(),
      unbridged: bridge.UNBRIDGED_STUDIES,
      runs,
    }),
  );
}
