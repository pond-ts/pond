// Loads @pond-ts/rs as npm would install it and runs test/smoke-scenario.mjs
// everywhere the package should work:
//
//   1. Node, by package name: the `node` export, for `.` and `./init`;
//   2. Chromium, as plain ES modules, with an import map built from
//      package.json's `default` exports: `.` (top-level await) and `./init`
//      (`await init()`);
//   3. a module worker in Chromium;
//   4. a Vite production bundle and the Vite dev server in Chromium, with
//      the settings the docs give: a bundler must find the .wasm through
//      `new URL('…', import.meta.url)`.
//
// The package is packed with `npm pack` and unpacked into a scratch
// project, so a file left out of `files` fails here. Every run must give
// the same result, and Node's must match the scenario's expected values.
//
//   node test/smoke.mjs              (after ./build.sh)
//   node test/smoke.mjs --node-only  (no browser)
//
// The browser is Playwright's Chromium (`npx playwright install chromium`)
// or the one at CHROME_PATH; Playwright and Vite come from the repo's
// node_modules (`npm ci` at the root).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expected } from './smoke-scenario.mjs';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const nodeOnly = process.argv.includes('--node-only');
const tmp = mkdtempSync(join(tmpdir(), 'pond-rs-smoke-'));
const results = {};

try {
  // ---- the package as published -------------------------------------------
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], {
      cwd: PKG,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  const installed = join(tmp, 'node_modules', '@pond-ts', 'rs');
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    join(tmp, packed.filename),
    '-C',
    installed,
    '--strip-components=1',
  ]);
  const manifest = JSON.parse(
    readFileSync(join(installed, 'package.json'), 'utf8'),
  );
  const files = packed.files.map((f) => f.path).sort();
  for (const f of ['LICENSE', 'README.md', 'pkg/pond_wasm_bg.wasm'])
    assert.ok(files.includes(f), `${f} is not in the package`);
  copyFileSync(
    new URL('./smoke-scenario.mjs', import.meta.url),
    join(tmp, 'scenario.mjs'),
  );

  // ---- Node ------------------------------------------------------------------
  writeFileSync(
    join(tmp, 'node.mjs'),
    `import * as rs from '@pond-ts/rs';
import * as rsInit from '@pond-ts/rs/init';
import { scenario } from './scenario.mjs';
const out = { main: await scenario(rs), init: await scenario(rsInit) };
out.sameModule = rs.TimeSeries === rsInit.TimeSeries;
console.log(JSON.stringify(out));
`,
  );
  const node = JSON.parse(
    execFileSync(process.execPath, ['node.mjs'], {
      cwd: tmp,
      encoding: 'utf8',
    }),
  );
  assert.ok(node.sameModule, 'Node: `.` and `./init` load different modules');
  results['node'] = node.main;
  results['node ./init'] = node.init;

  if (!nodeOnly) await browserRuns(tmp, manifest);

  // ---- compare ---------------------------------------------------------------
  const reference = results['node'];
  for (const [key, value] of Object.entries(expected))
    assert.deepStrictEqual(reference[key], value, `node: ${key}`);
  for (const [where, result] of Object.entries(results))
    assert.deepStrictEqual(result, reference, `${where} differs from Node`);
  console.log(
    `smoke: @pond-ts/rs ${manifest.version} (pond-rs ${reference.version}, ${packed.files.length} files, ` +
      `${(packed.size / 1e6).toFixed(1)} MB packed) gives the same result in: ${Object.keys(results).join(', ')}`,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

async function browserRuns(root, manifest) {
  const { chromium } = await import('playwright');
  const { build, createServer: viteServer } = await import('vite');
  const entry = (sub) =>
    `/node_modules/@pond-ts/rs/${manifest.exports[sub].default.slice(2)}`;

  // Plain ES modules, resolved with an import map.
  const page = (specifier) => `<!doctype html>
<script type="importmap">${JSON.stringify({
    imports: { '@pond-ts/rs': entry('.'), '@pond-ts/rs/init': entry('./init') },
  })}</script>
<script type="module">
  import * as rs from '${specifier}';
  import { scenario } from '/scenario.mjs';
  window.smoke = scenario(rs);
</script>`;
  writeFileSync(join(root, 'main.html'), page('@pond-ts/rs'));
  writeFileSync(join(root, 'init.html'), page('@pond-ts/rs/init'));

  // A module worker (import maps do not reach workers: the path itself).
  writeFileSync(
    join(root, 'worker.mjs'),
    `import * as rs from '${entry('.')}';
import { scenario } from '/scenario.mjs';
scenario(rs).then((r) => postMessage({ r }), (e) => postMessage({ e: String(e && e.stack || e) }));
`,
  );
  writeFileSync(
    join(root, 'worker.html'),
    `<!doctype html><script>
  const w = new Worker('/worker.mjs', { type: 'module' });
  window.smoke = new Promise((ok, fail) => {
    w.onmessage = ({ data }) => (data.e ? fail(new Error(data.e)) : ok(data.r));
    w.onerror = (e) => fail(new Error(e.message));
  });
</script>`,
  );

  // Vite, as the docs set it up: top-level await needs an es2022 target
  // (Vite 5's default predates it), and the dev server's dependency
  // pre-bundling would move the module away from its .wasm.
  const vite = {
    configFile: false,
    logLevel: 'warn',
    base: './',
    build: { target: 'es2022' },
    optimizeDeps: { exclude: ['@pond-ts/rs'] },
  };
  // The scratch project itself is the Vite app (index.html + main.js beside
  // node_modules, as in a real project; the dev server serves nothing above
  // its root).
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><script type="module" src="./main.js"></script>',
  );
  writeFileSync(
    join(root, 'main.js'),
    `import * as rs from '@pond-ts/rs';
import { scenario } from './scenario.mjs';
window.smoke = scenario(rs);
`,
  );
  await build({
    ...vite,
    root,
    build: { ...vite.build, outDir: join(root, 'dist') },
  });
  const dev = await viteServer({
    ...vite,
    root,
    server: { host: '127.0.0.1' },
  });
  await dev.listen();

  const types = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.wasm': 'application/wasm',
  };
  const server = createServer((req, res) => {
    const path = normalize(
      decodeURIComponent(new URL(req.url, 'http://x').pathname),
    );
    try {
      const body = readFileSync(join(root, path));
      res.writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
  });
  try {
    for (const [where, url] of [
      ['browser', base + '/main.html'],
      ['browser ./init', base + '/init.html'],
      ['module worker', base + '/worker.html'],
      ['vite bundle', base + '/dist/index.html'],
      ['vite dev server', dev.resolvedUrls.local[0]],
    ]) {
      const tab = await browser.newPage();
      const errors = [];
      tab.on('pageerror', (e) => errors.push(e));
      tab.on(
        'console',
        (m) => m.type() === 'error' && errors.push(new Error(m.text())),
      );
      await tab.goto(url);
      try {
        await tab.waitForFunction(() => window.smoke, null, {
          timeout: 30_000,
        });
        results[where] = await tab.evaluate(() => window.smoke);
      } catch (e) {
        throw new Error(
          `${where}: ${errors.map(String).join('; ') || e.message}`,
        );
      }
      assert.deepStrictEqual(errors, [], `${where}: errors in the page`);
      await tab.close();
    }
  } finally {
    await browser.close();
    server.close();
    await dev.close();
  }
}
