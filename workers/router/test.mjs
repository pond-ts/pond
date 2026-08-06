// Tests for the pond-ts.org router Worker.
//
// Zero-dependency: Node's built-in test runner plus the global fetch/Request/
// Response/Headers (Node 18+), which are the same web APIs the Workers runtime
// exposes. `workers/` is not an npm workspace, so `npm test` does not reach
// this — run it directly:
//
//   node --test workers/router/
//
// The case that matters is the redirect rewrite. Cloudflare Pages canonicalises
// `/x.html` to `/x` with a 308, and a `strip: true` mount answers in the
// project's coordinate space — so without the rewrite, `/storybook/iframe.html`
// (every Storybook story preview) came back as `Location: /iframe`, which the
// browser resolved against the apex, missing the mount entirely.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';

/** Install a fake origin for one call; returns the captured request URL. */
function stubFetch(responder) {
  const seen = [];
  globalThis.fetch = async (req) => {
    seen.push(new URL(req.url));
    return responder(new URL(req.url), req);
  };
  return seen;
}

const get = (path) => new Request(`https://pond-ts.org${path}`);
const redirect = (location, status = 308) =>
  new Response(null, { status, headers: { location } });

test('an unmatched path proxies to the docs project', async () => {
  const seen = stubFetch(() => new Response('ok'));
  await worker.fetch(get('/docs/charts/gallery'));
  assert.equal(seen[0].hostname, 'pond-docs.pages.dev');
  assert.equal(seen[0].pathname, '/docs/charts/gallery');
});

test('a mounted path strips the prefix before proxying', async () => {
  const seen = stubFetch(() => new Response('ok'));
  await worker.fetch(get('/storybook/sb-manager/runtime.js'));
  assert.equal(seen[0].hostname, 'pond-storybook.pages.dev');
  assert.equal(seen[0].pathname, '/sb-manager/runtime.js');
});

test('the bare prefix redirects to a trailing slash', async () => {
  stubFetch(() => new Response('unused'));
  const res = await worker.fetch(get('/storybook'));
  assert.equal(res.status, 301);
  assert.equal(new URL(res.headers.get('location')).pathname, '/storybook/');
});

test('a root-relative redirect Location regains the prefix', async () => {
  // The live bug: Pages 308s /iframe.html -> /iframe, which without this
  // rewrite escapes the mount and 404s on the docs project.
  stubFetch(() => redirect('/iframe?id=axes-dualx--sigma&viewMode=story'));
  const res = await worker.fetch(
    get('/storybook/iframe.html?id=axes-dualx--sigma&viewMode=story'),
  );
  assert.equal(res.status, 308);
  assert.equal(
    res.headers.get('location'),
    '/storybook/iframe?id=axes-dualx--sigma&viewMode=story',
  );
});

test('an absolute redirect back to the proxied host regains the prefix', async () => {
  stubFetch(() => redirect('https://pond-storybook.pages.dev/iframe?id=x'));
  const res = await worker.fetch(get('/storybook/iframe.html?id=x'));
  assert.equal(res.headers.get('location'), '/storybook/iframe?id=x');
});

test('a redirect to another host is left alone', async () => {
  // A deliberate off-site redirect is not a coordinate-space mismatch.
  stubFetch(() => redirect('https://example.com/elsewhere'));
  const res = await worker.fetch(get('/storybook/whatever'));
  assert.equal(res.headers.get('location'), 'https://example.com/elsewhere');
});

test('a protocol-relative redirect is left alone', async () => {
  stubFetch(() => redirect('//cdn.example.com/asset.js'));
  const res = await worker.fetch(get('/storybook/whatever'));
  assert.equal(res.headers.get('location'), '//cdn.example.com/asset.js');
});

test('a non-redirect response passes through untouched', async () => {
  stubFetch(() => new Response('body', { status: 200 }));
  const res = await worker.fetch(get('/storybook/index.json'));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'body');
});

test('a 404 from the mount stays a 404 (no Location to rewrite)', async () => {
  stubFetch(() => new Response('missing', { status: 404 }));
  const res = await worker.fetch(get('/storybook/nope'));
  assert.equal(res.status, 404);
});
