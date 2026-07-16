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
    return fetch(new Request(url, request));
  },
};
