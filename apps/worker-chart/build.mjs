// Bundles the page script and the two workers into dist/.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: ['page.ts', 'render-worker.ts', 'socket-worker.ts'].map((f) =>
    join(here, 'src', f),
  ),
  outdir: join(here, 'dist'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'warning',
});
