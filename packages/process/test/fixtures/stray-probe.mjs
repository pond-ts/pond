// Run as a SUBPROCESS by pool.test.ts.
//
// A stray worker message used to decrement the pool's in-flight count
// and `unref()` the worker while a real request was still outstanding.
// The consequence is that nothing holds the event loop open, so the
// process exits before the answer arrives — invisible under a test
// runner, which keeps the process alive on its own. Hence a subprocess:
// printing ANSWERED requires the pool to have kept the worker ref'd.
import { HostPool } from '../../dist/pool/index.js';

const SETUP = new URL('./pool-setup.mjs', import.meta.url);
const pool = await HostPool.start({
  setup: SETUP,
  size: 1,
  setupOptions: { rows: 64, stray: true },
});

const plan = [{ op: 'sma', params: { period: 3 }, inputs: ['px'] }];
// First request imports the setup module (registering the stray
// listener); the second is the one that runs with a stray in flight.
await pool.run({ from: 'px', process: plan, select: [{ on: plan[0] }] });
const result = await pool.run({
  from: 'px',
  process: plan,
  select: [{ on: plan[0] }],
});
if (Object.keys(result.columns ?? {}).length === 1) console.log('ANSWERED');
await pool.close();
