// Router Worker for pond-ts.org
//
// Cloudflare custom domains attach at the *hostname* level, not the path
// level. To serve several independently-deployed Pages projects as subpaths
// of one apex (`pond-ts.org/`, `pond-ts.org/storybook/`, …), a Worker on the
// `pond-ts.org/*` route proxies each path prefix to the right Pages project.
//
// Add one line to ROUTES per deployable as it comes online. The default
// (docs) is served from the apex root.
//
// `strip: true`  — remove the prefix before proxying. Use when the target
//                  project is built to serve from *its own root* with
//                  relative asset URLs (Storybook's Vite builder does this),
//                  so `/storybook/assets/x` → project `/assets/x`.
//                  A stripped mount also needs its **redirects** rewritten on
//                  the way back — the origin answers in its own coordinate
//                  space, so a root-relative `Location` returns without the
//                  prefix and sends the browser to the apex. See
//                  `withPrefixedLocation`; `node --test workers/router/` covers it.
// `strip: false` — keep the full path. Use when the target project is built
//                  with a base path matching its mount (e.g. a Vite/Docusaurus
//                  app built with base `/experiments/dashboard/`), so its
//                  absolute asset URLs already carry the prefix.

const ROUTES = [
  { prefix: '/storybook', host: 'pond-storybook.pages.dev', strip: true },
  // Experiments land here as one-liners, e.g.:
  // { prefix: '/experiments/dashboard', host: 'pond-dashboard.pages.dev', strip: false },
];

const DEFAULT_HOST = 'pond-docs.pages.dev';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    const route = ROUTES.find(
      (r) =>
        url.pathname === r.prefix || url.pathname.startsWith(r.prefix + '/'),
    );

    if (!route) {
      url.hostname = DEFAULT_HOST;
      return fetch(new Request(url, request));
    }

    // Redirect the bare prefix to a trailing slash so the mounted app's
    // relative asset URLs resolve under its subpath, not the apex root.
    if (url.pathname === route.prefix) {
      return Response.redirect(
        url.origin + route.prefix + '/' + url.search,
        301,
      );
    }

    url.hostname = route.host;
    if (route.strip) {
      url.pathname = url.pathname.slice(route.prefix.length) || '/';
    }

    // `redirect: 'manual'` so a redirect from the origin reaches the rewrite
    // below instead of being followed inside the Worker (where the hop would
    // resolve against the *project* root and we'd never see the Location).
    const response = await fetch(new Request(url, request), {
      redirect: 'manual',
    });
    return route.strip ? withPrefixedLocation(response, route) : response;
  },
};

/**
 * Re-add a stripped prefix to a redirect's `Location`.
 *
 * A `strip: true` mount rewrites the *request* path but the origin answers in
 * its own coordinate space, so any root-relative `Location` it sends comes back
 * missing the prefix. The browser then resolves it against the apex and leaves
 * the mount entirely.
 *
 * This is not hypothetical: Cloudflare Pages canonicalises `/x.html` to `/x`
 * with a 308, so `/storybook/iframe.html?id=…` — the URL Storybook's manager
 * loads every story preview from — came back as `Location: /iframe?id=…`, which
 * resolves to the apex, misses every route, and falls through to the docs 404.
 * The manager rendered fine and every story spun forever.
 *
 * Rewrites root-relative Locations (`/x` → `/storybook/x`) and absolute ones
 * pointing back at the proxied host. An absolute Location to any *other* host
 * is left alone — that's a deliberate off-site redirect, not a coordinate-space
 * mismatch.
 */
function withPrefixedLocation(response, route) {
  if (response.status < 300 || response.status >= 400) return response;
  const location = response.headers.get('location');
  if (!location) return response;

  let rewritten;
  if (location.startsWith('//')) {
    return response; // protocol-relative → another host; leave it
  } else if (location.startsWith('/')) {
    rewritten = route.prefix + location;
  } else {
    let target;
    try {
      target = new URL(location);
    } catch {
      return response; // relative Location; resolves under the mount already
    }
    if (target.hostname !== route.host) return response;
    rewritten = route.prefix + target.pathname + target.search + target.hash;
  }

  // Headers on a redirect are immutable until copied.
  const headers = new Headers(response.headers);
  headers.set('location', rewritten);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
