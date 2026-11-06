// The browser build in headless Chromium: bundles a page with esbuild (the
// `default` condition, so `#wasm` is wasm.browser.js and the .wasm is
// fetched with a top-level await), serves it, and checks the page gives the
// same results as the Node build. Run twice: once as is, where toJSON
// writes its row loop with `new Function`, and once under a CSP of
// `script-src 'self' 'wasm-unsafe-eval'`, where `new Function` is refused
// and toJSON takes its plain-loop fallback.
//
// Needs the package built (./build.sh), esbuild and playwright (declared
// in the root package.json's devDependencies, so the root `npm ci`
// installs them) and a Playwright Chromium (`npx playwright install
// chromium`, or CHROMIUM_PATH set to another Chromium).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import * as rs from '../index.js';
import { workload } from './browser-workload.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const expected = JSON.stringify(workload(rs));

const dir = mkdtempSync(join(tmpdir(), 'pond-rs-browser-'));
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
};
try {
  await build({
    stdin: {
      contents: `
        import * as rs from '@pond-ts/rs';
        import { workload } from './test/browser-workload.mjs';
        let codegen;
        try { codegen = new Function('return true')(); } catch { codegen = false; }
        try {
          window.result = { codegen, json: JSON.stringify(workload(rs)) };
        } catch (e) {
          window.result = { error: String(e && e.stack || e) };
        }`,
      resolveDir: here('..'),
      sourcefile: 'page.js',
    },
    // The package resolving itself by name, as an app would import it.
    alias: { '@pond-ts/rs': here('../index.js') },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: join(dir, 'page.js'),
    logLevel: 'warning',
  });
  // esbuild leaves `new URL('./pkg/pond_wasm_bg.wasm', import.meta.url)` as
  // is, so the .wasm goes next to the bundle (see wasm.browser.js).
  mkdirSync(join(dir, 'pkg'));
  copyFileSync(
    here('../pkg/pond_wasm_bg.wasm'),
    join(dir, 'pkg/pond_wasm_bg.wasm'),
  );
  const page =
    '<!doctype html><meta charset="utf-8"><script type="module" src="page.js"></script>';

  const csp = "script-src 'self' 'wasm-unsafe-eval'";
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const headers = {};
    if (url.searchParams.has('csp')) headers['Content-Security-Policy'] = csp;
    if (url.pathname === '/') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html' });
      return res.end(page);
    }
    try {
      const body = readFileSync(join(dir, url.pathname));
      const ext = url.pathname.slice(url.pathname.lastIndexOf('.'));
      res.writeHead(200, {
        ...headers,
        'Content-Type': types[ext] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;

  // CHROMIUM_PATH: a Chromium other than the one this Playwright version
  // downloads (e.g. a preinstalled one).
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
  try {
    for (const [label, query, codegen] of [
      ['no CSP', '', true],
      [`CSP ${csp}`, '?csp', false],
    ]) {
      const tab = await browser.newPage();
      const errors = [];
      tab.on('pageerror', (e) => errors.push(String(e)));
      await tab.goto(base + query);
      await tab
        .waitForFunction(() => window.result !== undefined, null, {
          timeout: 30_000,
        })
        .catch(() => {});
      const result = await tab.evaluate(() => window.result);
      assert.ok(result, `${label}: page gave no result (${errors.join('; ')})`);
      assert.equal(result.error, undefined, `${label}: ${result.error}`);
      assert.equal(
        result.codegen,
        codegen,
        `${label}: new Function allowed = ${result.codegen}`,
      );
      assert.equal(
        result.json,
        expected,
        `${label}: results differ from the Node build`,
      );
      await tab.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  `browser build in Chromium matches the Node build (${expected.length} bytes of results), with and without a CSP that refuses new Function`,
);
