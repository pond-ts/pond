# Docs hosting migration → Cloudflare + `pond-ts.org`

This tracks the one-time move of the docs site from GitHub Pages
(`pjm17971.github.io/pond-ts`) to Cloudflare Pages behind the apex domain
`pond-ts.org`, with a Worker router so multiple independently-deployed apps
share the apex as subpaths.

## Status

**Live.** The zone is Active on Cloudflare, both Pages projects are deployed,
and the router Worker is bound to `pond-ts.org/*`:

- <https://pond-ts.org> → docs (`pond-docs`)
- <https://pond-ts.org/storybook/> → Storybook (`pond-storybook`)
- `www.pond-ts.org` → 301 to apex

The first deploy was done manually via `wrangler` from a local `wrangler login`.
**Remaining:** wire the GitHub Actions secrets (below) so future release-tag
pushes auto-deploy, and optionally decommission old GitHub Pages.

## Target topology

```
pond-ts.org/*  ──►  [pond-ts-router Worker]  (workers/router/)
     /  , /docs, /api, /generated-api …  ──►  pond-docs.pages.dev       (this repo → website/build)
     /storybook/*                         ──►  pond-storybook.pages.dev  (this repo → packages/charts/storybook-static)
     /experiments/<name>/*                ──►  pond-<name>.pages.dev      (each experiment repo — added later)
```

- **Two Pages projects deploy from this repo** on every `v*` tag (see
  `.github/workflows/docs.yml`): `pond-docs` and `pond-storybook`.
- **The Worker owns the `pond-ts.org` hostname.** The Pages projects keep
  their `*.pages.dev` names; do **not** attach `pond-ts.org` as a custom
  domain on any individual Pages project — the Worker route does the binding.

## In-repo changes (already landed on this branch)

- `website/docusaurus.config.ts` — `url: https://pond-ts.org`, `baseUrl: '/'`,
  `organizationName/projectName → pond-ts/pond`, `editUrl` + navbar/footer
  GitHub links repointed.
- `.github/workflows/docs.yml` — three GitHub Pages steps replaced by two
  `cloudflare/wrangler-action` deploys (`pond-docs`, `pond-storybook`). The
  `v*`-tag trigger + `workflow_dispatch` are kept, so the site still tracks the
  latest _published_ version, not in-flight `main`.
- `workers/router/` — the router Worker + `wrangler.toml`.
- `README.md` — doc links repointed to `pond-ts.org`.

## Out-of-repo steps (only you can do these)

Do them roughly in this order.

### 1. Create a Cloudflare account + add the zone

1. Sign up / log in at <https://dash.cloudflare.com>.
2. **Add a domain** (older UI: "Add a site") → enter `pond-ts.org`. Choose to
   **connect an existing domain** / manually enter records — _not_
   register/transfer (registration stays at GoDaddy). Pick the **Free** plan.
3. Cloudflare scans existing DNS records and shows you **two nameservers**
   (e.g. `xxx.ns.cloudflare.com`). Note them. (The newer flow may offer an
   automated nameserver handoff for supported registrars; GoDaddy is manual —
   just get to the two nameserver names and do step 2 below by hand.)

> A full zone (nameserver move) is required — a CNAME-only "partial" setup
> cannot host Worker routes on the apex.

### 2. Point GoDaddy at Cloudflare's nameservers

1. GoDaddy → your domain → **DNS / Nameservers** → **Change Nameservers** →
   **Enter my own nameservers (custom)**.
2. Replace the two GoDaddy nameservers with the two from Cloudflare.
3. Save. Propagation is usually minutes-to-hours; Cloudflare emails you when
   the zone is **Active**. Registration stays at GoDaddy — only DNS moves.

### 3. Create the two Pages projects

You can create empty projects in the dashboard, or let the first `wrangler
pages deploy` create them. To create in the dashboard:

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Create using direct upload** (NOT Git — we deploy via GitHub Actions).
2. Name it exactly **`pond-docs`**. Set the **production branch to `main`**.
3. Repeat for **`pond-storybook`**.

The workflow deploys with `--branch=main`, which marks each deploy as the
project's production deployment.

### 4. Add repo secrets for the GitHub Actions deploy

In GitHub → `pond-ts/pond` → **Settings → Secrets and variables → Actions**:

- **`CLOUDFLARE_API_TOKEN`** — create at Cloudflare → **My Profile → API
  Tokens → Create Token**. Use the **"Edit Cloudflare Workers"** template, or a
  custom token with at least: **Account · Cloudflare Pages · Edit**. Scope it
  to your account.
- **`CLOUDFLARE_ACCOUNT_ID`** — shown on the right sidebar of any Workers &
  Pages page (or the URL after `/accounts/`).

### 5. First deploy of the Pages projects

Either push a `v*` tag or run the workflow manually:

```
gh workflow run docs.yml --ref main
gh run list --workflow=docs.yml --limit 1   # watch it
```

After it succeeds, confirm the raw project URLs work **before** wiring the
Worker:

- <https://pond-docs.pages.dev>
- <https://pond-storybook.pages.dev>

### 6. Deploy the router Worker + bind the apex route

Once the zone is **Active** (step 2):

```
cd workers/router
npx wrangler login          # one-time, opens a browser
npx wrangler deploy         # deploys the Worker AND binds the routes in wrangler.toml
```

`wrangler.toml` binds `pond-ts.org/*` and `www.pond-ts.org/*`. For those routes
to resolve there must be **proxied** (orange-cloud) DNS records on the zone for
the apex and `www`:

- When the zone was imported from GoDaddy, Cloudflare carried over **proxied**
  `A` records for the apex (pointing at GoDaddy parking IPs) and a proxied
  `www → pond-ts.org` CNAME. **These already satisfy the requirement** — the
  Worker route intercepts every request before the origin IP is ever hit, so
  the parking IPs are irrelevant. No dummy record needed; leave them as-is.
- If for some reason no proxied apex record exists, add one: an `A` record
  `@ → 192.0.2.1` (dummy) set to **proxied** works, since the Worker intercepts.

Then verify:

- <https://pond-ts.org> → docs
- <https://pond-ts.org/storybook/> → Storybook

### 7. Decommission old GitHub Pages (optional cleanup)

Once `pond-ts.org` serves correctly, disable Pages on the old repo (Settings →
Pages) if it's still enabled. GitHub auto-redirects `pjm17971/pond-ts` repo
URLs to `pond-ts/pond`, so source links keep working.

## Adding an experiment later (the payoff)

1. Deploy the experiment as its own Pages project `pond-<name>` — built with a
   base path of `/experiments/<name>/` (so its absolute asset URLs carry the
   prefix), OR built to serve from root with relative assets.
2. Add **one line** to `ROUTES` in `workers/router/index.js`:
   ```js
   { prefix: '/experiments/<name>', host: 'pond-<name>.pages.dev', strip: false },
   ```
   Use `strip: true` if the app serves from its own root with relative assets;
   `strip: false` if it was built with the matching base path.
3. `cd workers/router && npx wrangler deploy`.

## Open items to confirm

- **Dashboard repo location.** `README.md` still links the dashboard example at
  `github.com/pjm17971/pond-ts-dashboard`. GitHub redirects the old owner, but
  if that repo also moves to the `pond-ts` org, update the link.
- **CHANGELOG compare links** point at `github.com/pjm17971/pond-ts`. They keep
  working via GitHub's redirect; repoint at the next release bump if desired.
