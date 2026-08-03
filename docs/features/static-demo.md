# Static UI demo

A build of the Point frontend that runs with **no backend at all**. Every API
call is answered from bundled fixtures, so the output is plain static files —
deployable to any CDN or object store.

It exists to be a public showcase: visitors browse the real public site, log in
to the real admin UI, and click through everything, without there being a server
to attack, a database to corrupt, or a credential that grants anything.

## Why a mock rather than a read-only server

A read-only backend was the obvious alternative and is strictly worse here:

- Point has **no authorization model**. `users` has no role column and
  `docs/features/auth.md` states that all auth mechanisms resolve to the same
  principal. "Read-only" would have to be invented, then defended across HTTP,
  the MCP dispatcher (which bypasses Echo middleware entirely), the background
  scheduler, and every route added afterwards.
- A public demo credential makes that guard the entire security boundary.
- A static bundle has no origin to exhaust, so denial-of-service protection is
  structural rather than configured.
- There is nothing to reset. A reload re-seeds the store; the demo is pristine
  again.

## How it works

```
frontend/src/mock/
  entry.js      build entry — imports the shim, then the real app.js
  shim.js       patches window.fetch + XMLHttpRequest
  store.js      mutable in-memory model, seeded from fixtures
  routes.js     endpoint handlers over the store
  banner.js     demo-only banner, reset control, login hint
  fixtures/     recorded API payloads (gitignored)
```

The interception point is the **platform**, not `frontend/src/api/client.js`.
That module is not the only caller: `router.js` fetches `/api/setup/status` on
every `/light` navigation, `api/system.js` uploads over `XMLHttpRequest`,
`BackupsSection.js` fetches the version endpoint directly, and the comments
plugin calls `api.*` without going through `frontend/src/api/`. Patching `fetch`
and `XMLHttpRequest` catches all of them — including any added later — and leaves
the real `client.js` on the code path, so the demo exercises genuine error
handling and caching instead of a parallel implementation of it.

`entry.js` relies on ES module evaluation order: the shim is installed before
`app.js` runs its top-level `loadThemeCss()` fetch.

**`app.js` itself is never modified.** The demo runs the real application.

### Two kinds of fixture data

| Kind | Examples | Behaviour |
|---|---|---|
| Entities | posts, tags, media, settings, plugins | Seed a mutable store — create/edit/delete really take effect |
| Derived views | tag graph, atlas, timeline | Served as recorded blobs; recomputing them in the browser would duplicate real backend work for no visible gain |

Tag pages are **synthesized** from the entity stores rather than recorded, so a
tag created inside the demo gets a working page too.

### Failing soft

An unmatched endpoint returns an empty `200`, never a rejection and never a
`401`. `client.js` turns a 401 into an `api:unauthorized` event which `app.js`
escalates into a hard navigation to `/light/login` — one unhandled endpoint would
otherwise eject a visitor mid-click.

The one deliberate 401 is `GET /api/auth/me` when logged out, which `client.js`
explicitly exempts from that event.

## Building

```bash
# 1. Record fixtures from a running instance whose content you intend to publish
node scripts/record-demo-fixtures.mjs --base=http://localhost:8001 --session=<token>

# 2. Build
scripts/build-demo.sh              # or --skip-media for a fast iteration loop

# 3. Verify with the backend STOPPED
npx serve -s dist-demo -l 3000
node scripts/test-demo.mjs --base=http://localhost:3000
```

`<token>` is a raw value from the `sessions` table; any admin session works.
Nothing is written back to the source instance.

### What the build reproduces

The Go server rewrites `index.html` in memory on every request and never touches
the file on disk (`api/cmd/api/main.go`). `scripts/build-demo-html.mjs` does that
work at build time:

- `__BUILD_VERSION__` → a fixed demo string
- `<!-- __HEAD_HTML__ -->` → empty (the demo embeds no third-party origin)
- **`window.__PLUGINS__` injected before `</head>`** — not optional:
  `core/pluginHost.js` is completely inert without it, silently costing the demo
  its media viewer, timeline and tag visualisation. The build fails rather than
  emit an empty manifest.

`feed.xml` and `sitemap.xml` are server-rendered in production, so
`scripts/build-demo-feeds.mjs` writes them out as files.

### Plugins withheld from the demo

| Plugin | Why |
|---|---|
| `comments` | Loads `/comments/web/embed.mjs` from a remark42 sidecar that does not exist. Omitting it also stops `CommentsAdminPage` (which calls `api.*` directly) from mounting |
| `mcp` | Server-side capability with no meaning without a server |
| `offline-sync` | Registers `/sw.js` and enables the IndexedDB mutation queue. A service worker would serve stale bundles, and the queue would accumulate writes that never drain |

`app.js` falls back to importing `offline-sync` statically when the manifest is
**empty**, so the manifest must be present and non-empty for that omission to
take effect. The build enforces this.

## Scrubbing

The recorder scrubs at the recording boundary, so an unscrubbed fixture never
exists on disk. It drops every settings key beginning with `_` (`_secret_key` is
the instance's signing key), drops known credential keys, rewrites emails, and
replaces the blog title and author identity with demo values.

It then **audits its own output** and exits non-zero if a banned key or value
pattern survives.

`fixtures.json` is gitignored: it is a copy of a real instance's content, and
committing it is a publishing decision, not a build detail.

## Known limitations

- **`?thumb` does not resolve to a thumbnail.** The client appends it to media
  URLs in several admin views (`PostsListPage.js`, `VisualEditor.js`), and a
  static host ignores query strings, so the full-size image is served instead.
  `build-demo.sh` downscales originals to compensate;
  `utils/helpers.js dropBrokenImages()` handles anything missing.
- **Backend-shaped admin surfaces are canned**: backups, log tailing,
  photo-library import, system restart, Instagram connect, passkey registration.
  They render and respond plausibly rather than being hidden — seeing that the
  features exist is the point.
- **The mock is a parallel implementation and will drift.** Fixtures being
  recorded rather than transcribed limits this, and `scripts/test-demo.mjs`
  catches it. Re-record at each release.

## Deploying

The output is static files with `_redirects` (SPA fallback) and `_headers`
(cache policy) for Cloudflare Pages. Content-hashed chunks get immutable
year-long caching; unhashed entry bundles and `index.html` revalidate so a
redeploy is picked up.

No WAF rules, rate limiting or bot rules are needed — there is nothing behind the
edge to protect.
