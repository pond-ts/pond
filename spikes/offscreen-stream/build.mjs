// Bundle the page script and the worker (TS source, including the internal
// @pond-ts/charts draw kernels the spike calls directly) into dist/.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [
    join(here, 'src/main.ts'),
    join(here, 'src/worker.ts'),
    join(here, 'src/receiver.ts'),
  ],
  outdir: join(here, 'dist'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
