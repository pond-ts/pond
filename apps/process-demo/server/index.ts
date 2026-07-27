/**
 * The demo backend — one long-lived `Host`, one agent seam.
 *
 * The `Host` is module scope on purpose. That is the whole architectural
 * claim from M1 restated as a deployment fact: a graph built per request
 * starts cold, and a cold graph is a fold with extra steps. Everything
 * this demo is meant to show — the warm badge, the cache — depends on
 * this object outliving the requests that read it.
 *
 * There is no persistence and no session state beyond that map. Two
 * browser tabs share one cache, which is the MCP shape in miniature.
 */

import { createServer } from 'node:http';
import { createHost, toWire, type Envelope } from '@pond-ts/process';
import { composerFromEnv, type Composer, type Turn } from './compose.js';
import { barUnits, datasetSpecs, makeBars } from './data.js';
import { demoRegistry } from './ops.js';

const PORT = Number(process.env['PORT'] ?? 8787);

const registry = demoRegistry();
const host = createHost({ registry, units: barUnits });
const composer: Composer = composerFromEnv();

console.log(`[data] seeding ${datasetSpecs.length} datasets…`);
for (const spec of datasetSpecs) {
  const t0 = performance.now();
  host.add(spec.id, makeBars(spec));
  console.log(
    `[data] ${spec.id}: ${spec.rows.toLocaleString()} bars in ${Math.round(performance.now() - t0)} ms`,
  );
}

const planSchema = registry.toJsonSchema({ base: '#/properties/process' });

function composerContext() {
  return {
    datasets: host.datasets,
    ops: registry.describe(),
    planSchema,
    units: barUnits,
  };
}

// ── handlers ─────────────────────────────────────────────────

interface Json {
  status: number;
  body: unknown;
}

async function readJson(
  req: import('node:http').IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

/** Resolves an envelope against its dataset's long-lived graph. */
function runEnvelope(envelope: Envelope) {
  const t0 = performance.now();
  const result = host.run({ onError: 'collect', ...envelope });
  const ms = Math.round((performance.now() - t0) * 1000) / 1000;
  return { ...toWire(result, envelope.as), ms };
}

async function handle(
  method: string,
  path: string,
  req: import('node:http').IncomingMessage,
): Promise<Json> {
  if (method === 'GET' && path === '/api/context') {
    return {
      status: 200,
      body: {
        datasets: host.datasets,
        ops: registry.describe(),
        families: Object.fromEntries(
          [...registry.byFamily()].map(([f, ops]) => [
            f,
            ops.map((o) => o.name),
          ]),
        ),
        units: barUnits,
        planSchema,
        composer: { kind: composer.kind, why: composer.why },
      },
    };
  }

  if (method === 'POST' && path === '/api/compose') {
    const { prompt, history = [] } = (await readJson(req)) as {
      prompt?: string;
      history?: Turn[];
    };
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return { status: 400, body: { error: 'prompt is required' } };
    }
    const composed = await composer.compose(prompt, composerContext(), history);
    return { status: 200, body: composed };
  }

  if (method === 'POST' && path === '/api/run') {
    const envelope = (await readJson(req)) as Envelope;
    if (
      typeof envelope?.from !== 'string' ||
      !Array.isArray(envelope.process)
    ) {
      return { status: 400, body: { error: 'expected { from, process, … }' } };
    }
    return { status: 200, body: runEnvelope(envelope) };
  }

  // One round trip for the UI: prompt in, both panels out. The panels
  // are still fed separately so a hand-edited envelope can be re-run
  // without going back through the model.
  if (method === 'POST' && path === '/api/ask') {
    const { prompt, history = [] } = (await readJson(req)) as {
      prompt?: string;
      history?: Turn[];
    };
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return { status: 400, body: { error: 'prompt is required' } };
    }
    const composed = await composer.compose(prompt, composerContext(), history);
    return {
      status: 200,
      body: { composed, result: runEnvelope(composed.envelope) },
    };
  }

  return { status: 404, body: { error: `no route for ${method} ${path}` } };
}

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  handle(req.method ?? 'GET', path, req)
    .then(({ status, body }) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
    })
    .catch((e: unknown) => {
      // Everything reaching here is a genuine failure — a bad *plan*
      // comes back as `skipped`, with a reason, and a 200.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[error] ${req.method} ${path}: ${message}`);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: message }, null, 2));
    });
}).listen(PORT, () => {
  console.log(`[serve] http://localhost:${PORT}  (${composer.why})`);
});
