/**
 * [PND-PROCSLOT] / [PND-PROCBUILD] end to end.
 *
 * The contract in one script: a slot plan, a builder-produced plan, and
 * the equivalent nested plan must land on the same nodes — so the cache
 * one built is the cache the others hit, and a param edit moves the id
 * while leaving the slot alone.
 *
 *     npx tsx scripts/slots-equivalence.mts
 */

import { createHost, plan, type Envelope } from '@pond-ts/process';
import { barUnits, datasetSpecs, makeBars } from '../server/data.js';
import { demoRegistry } from '../server/ops.js';

const host = createHost({ registry: demoRegistry(), units: barUnits });
const spec = datasetSpecs[0]!;
host.add(spec.id, makeBars(spec));
console.log(`${spec.id}: ${spec.rows.toLocaleString()} bars\n`);

const show = (label: string, envelope: Envelope) => {
  const r = host.run({ onError: 'collect', ...envelope } as Envelope);
  for (const n of r.nodes) {
    const slot = n.slot === undefined ? '—' : n.slot;
    const state = n.pulled ? (n.cached ? 'cached  ' : 'computed') : 'idle    ';
    console.log(`  ${slot.padEnd(8)} ${state} ${String(n.ms).padStart(8)} ms  ${n.id}`);
  }
  const named = r.facts.map((f) => `${f.name ?? '(unnamed)'}=${f['value']}`);
  console.log(`  ${label}: ${named.join('  ')}\n`);
  return r;
};

// 1. Nested — the original form.
const nested = {
  op: 'ema',
  params: { period: 50 },
  inputs: [{ op: 'sma', params: { period: 50 }, inputs: ['px'] }],
};
console.log('nested plan (cold):');
show('nested', {
  from: spec.id,
  process: [nested],
  select: [{ on: nested, reduce: 'last' }],
});

// 2. Slots — same graph, caller-assigned names.
console.log('slot plan — every node should already be cached:');
const slots = {
  from: spec.id,
  nodes: {
    avg: { op: 'sma', params: { period: 50 }, in: ['px'] },
    smooth: { op: 'ema', params: { period: 50 }, in: ['avg'] },
  },
  outputs: { latest: { on: 'smooth', reduce: 'last' as const } },
};
show('slots', slots);

// 3. Builder — the same envelope, authored in code.
const g = plan(spec.id).as('smoothed');
const avg = g.add('avg', 'sma', { period: 50 }, ['px']);
const smooth = g.add('smooth', 'ema', { period: 50 }, [avg]);
g.expose('latest', smooth.last());
console.log('builder — same again, and still cached:');
show('builder', g.toJSON());

// 4. A param edit: the id moves, the slot does not.
console.log('param edit (period 50 → 80) — slot stable, id new:');
const edited = show('edited', {
  ...slots,
  nodes: { ...slots.nodes, avg: { op: 'sma', params: { period: 80 }, in: ['px'] } },
});
console.log(
  `  slots unchanged: ${JSON.stringify(edited.nodes.map((n) => n.slot))}`,
);
