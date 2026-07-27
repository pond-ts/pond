import { demoRegistry } from './server/ops.js';
const { toStrictJsonSchema } = await import('openai/lib/transform');

const plan = demoRegistry().toJsonSchema({ base: '#/properties/process' });
const wrap = (p: unknown) => ({
  type: 'object', additionalProperties: false, required: ['process'],
  properties: { process: p },
});
const attempt = (label: string, s: unknown) => {
  try { toStrictJsonSchema(s); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}\n      ${(e as Error).message.split('\n')[0].slice(0, 130)}`); }
};

/** Make every declared property required — strict mode's rule. */
function allRequired(node: any): any {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(allRequired);
  const out: any = {};
  for (const [k, v] of Object.entries(node)) out[k] = allRequired(v);
  if (out.type === 'object' && out.properties) out.required = Object.keys(out.properties);
  return out;
}

console.log('isolating what strict mode objects to:');
attempt('as projected', wrap(plan));
attempt('all properties required', wrap(allRequired(plan)));

const req = allRequired(plan);
const asAnyOf = structuredClone(req);
asAnyOf.items = { anyOf: req.items.oneOf };
attempt('all required + oneOf → anyOf', wrap(asAnyOf));

// Does the recursion itself survive, once the rest is legal?
const single = { type: 'array', items: allRequired(plan).items.oneOf[0] };
attempt('one op, recursion intact, all required', wrap(single));
console.log('\n  recursive ref in that last schema:',
  JSON.stringify((single.items as any).properties.inputs.items));
