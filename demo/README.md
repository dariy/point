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
demo/
  README.md       this document
  world.mjs       tag universe, locations and topical vocabulary
  mock/
    entry.js      build entry — imports the shim, then the real app.js
    shim.js       patches window.fetch + XMLHttpRequest
    store.js      mutable in-memory model, seeded from fixtures
    routes.js     endpoint handlers over the store
    banner.js     demo-only banner, reset control, login hint
    fixtures/     recorded API payloads (gitignored)
  scripts/
    make-content.sh      throwaway instance → generated content → fixtures
    generate-content.mjs picsum photos + Gemini prose
    retag-content.mjs    restructure tags without regenerating prose
    record-fixtures.mjs  record an instance's API responses
    build.sh             fixtures + frontend → demo/dist/
    build-html.mjs       index.html templating the Go server normally does
    build-feeds.mjs      static feed.xml and sitemap.xml
    run.sh / serve.mjs   serve demo/dist/ with the build's SPA fallback
    test.mjs             acceptance check against a served build
  dist/           build output (gitignored)
  .scratch/       throwaway instance (gitignored)
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
| Derived views | tag graph, timeline | Served as recorded blobs; recomputing them in the browser would duplicate real backend work for no visible gain |

Tag pages are **synthesized** from the entity stores rather than recorded, so a
tag created inside the demo gets a working page too. So is the Atlas's on-tap
cloud (`GET /api/pages/graph/tag/:id` — the place's recent posts and the tags
they share): it is one payload per place *and* per timeline range, so recording
it would mean a blob per combination, and a place the visitor retagged inside
the demo would still answer with the cloud it had at recording time.

### Work the server normally does to files

Two pieces of demo behaviour are not endpoints at all — on a real deployment the
Go server *rewrites files* in response to an admin action, and a static build
would freeze them at whatever they were when the fixtures were recorded:

- **`/assets/css/common/theme.css`** — `ThemeService.SyncActiveTheme` copies the
  active theme over this file and appends the site's custom CSS. `shim.js`
  intercepts the path and composes the same two ingredients from the store, so
  activating a theme or saving custom CSS repaints the page immediately instead
  of only moving a highlight. The theme sources ship as `/assets/themes/*.css`.
- **Plugin presets** — `plugins.DefaultPresets()` is seeded into the store
  (`store.js`) and `POST /api/plugins/presets/:id/apply` reproduces the
  backend's two corrections: a core area a preset empties falls back to its
  default member, and an exclusive area keeps only its first. Without them the
  demo could show combinations the real backend refuses to produce.

### Failing soft

An unmatched endpoint returns an empty `200`, never a rejection and never a
`401`. `client.js` turns a 401 into an `api:unauthorized` event which `app.js`
escalates into a hard navigation to `/light/login` — one unhandled endpoint would
otherwise eject a visitor mid-click.

The one deliberate 401 is `GET /api/auth/me` when logged out, which `client.js`
explicitly exempts from that event.

## Building

```bash
# 1. Generate content and record fixtures (~5 min, needs network + a Gemini key)
GEMINI_API_KEY=... demo/scripts/make-content.sh

# 2. Build
demo/scripts/build.sh              # or --skip-media for a fast iteration loop

# 3. Serve and verify, with the backend STOPPED
demo/scripts/run.sh                                       # http://localhost:8002
node demo/scripts/test.mjs --base=http://localhost:8002
```

`test.mjs` drives a real browser: `npm install`, then `npx playwright
install chromium` if the browser is not already cached.

### Serving it

`demo/scripts/run.sh` runs `demo/scripts/serve.mjs`, which reads the build's own
`_redirects` and applies it the way Cloudflare Pages does: static file first,
rules only when nothing matched.

Serving the directory as plain files instead — `npx serve demo/dist` — leaves
every `/light` route a 404, because admin routes are client-side and have no
file behind them; the entire admin UI disappears. `serve -s` goes too far the
other way and rewrites *everything* to `index.html`, so a missing image answers
`200` with the HTML shell and `dropBrokenImages()` never fires. Driving the
local server from `_redirects` keeps the two from drifting.

### The demo's tag tree

`demo/world.mjs` is the single definition of the demo's tag universe,
shared by the generator and the restructuring script so the two cannot describe
different worlds:

```
country ─┬ Portugal ── Lisbon      cities are children of their country *and*
         ├ Iceland ─── Reykjavík   of the `city` root, so the tree reads as
         ├ Japan ───── Kyoto       geography while `city` stays a flat index
         └ Argentina ─ El Chaltén
city ────┬ Lisbon, Reykjavík, Kyoto, El Chaltén
date ────┬ 2020 … 2026             kind: "year" — what the timeline reads
subject ─┬ terrain ─┬ mountains, forest, coastline, valley, flora
         ├ water ───┬ ocean, waves, still-water, droplets
         ├ built ───┬ architecture, street-life, cityscape, winding-road
         ├ light ───┬ morning-light, mist, sky, twilight
         ├ season ──┬ winter, summer
         ├ people ──┬ solitude, companionship, everyday
         └ objects ─┬ analog, close-up, texture
```

Point's tag graph is a DAG, so the two parents on each city are a supported
shape rather than a trick: breadcrumbs render `country → Japan → Kyoto` and the
ancestor flyout offers the other path.

Countries carry coordinates as well as cities. The Atlas plots only tags that
have them, then matches each one's name against its boundary files — so a
country with coordinates is drawn as a filled shape and one without is not
drawn at all, which is what left the map showing four city pins over an empty
world.

The topical vocabulary is **closed**. Letting the model invent keywords per
photo produced ~100 tags of which roughly 80 named exactly one post — a flat
list that exercises the tag *page* but not the hierarchy, the breadcrumbs or the
flyout, and every click on which lands on an archive of one. Twenty-five terms
over 28 posts keeps every tag a facet that narrows the archive to more than one
entry, which both scripts assert before finishing.

Each post carries its country, its city, its year and 2–4 topics, so no branch
of the tree is decorative.

### The content pipeline

`demo/scripts/make-content.sh` stands up a **throwaway Point instance** in
`demo/.scratch/` — its own database and storage — fills it, records it, and tears
it down. Your real instance is never touched.

`demo/scripts/generate-content.mjs` does the filling:

1. Samples the [picsum.photos](https://picsum.photos) catalogue (Unsplash-sourced,
   freely usable). Landscape only, and at most one photo per contributor —
   picsum's opening run is a single photographer's desk-and-laptop series, so
   taking the head of the list yields a demo where every post looks the same.
2. Assigns a location and year **round-robin**, not by asking the model. Letting
   Gemini choose clustered almost everything onto one city, leaving the map with
   a single pin. With 28 posts over 4 locations and 7 years the two cycles are
   coprime, so every combination appears exactly once: 7 per location, 4 per year.
3. Sends each image to Gemini (`gemini-2.5-flash`, structured output) with its
   assigned place and year, asking for a title, excerpt, body and topical tags.
   The text describes the actual photograph rather than reading as filler. Tags
   are constrained to the vocabulary above by a schema `enum`, not by asking
   nicely.
4. Creates everything **through the REST API** — uploads, tags, posts — so slugs,
   tag counts, media linking and visibility all follow the same code paths as a
   real edit. The prose lands in `excerpt` and the body holds only the
   photograph: `excerpt` is what the Sheet immersive viewer renders and what
   the post cards preview, so writing left in the body is writing nobody in the
   demo reads.
5. Drops any topic the model only reached for once, then builds the `subject`
   branch from what survived — a topic tag on one post, or none, is a dead end
   in the navigation.
6. Backdates `published_at` directly in SQLite. This is the one thing the API
   cannot do: it sets the timestamp server-side at publish time, and a past
   `scheduled_at` publishes immediately instead of backdating. Timestamps are
   clamped to an hour ago so the current year never produces future-dated posts.

Photo selection and date jitter run off a seeded PRNG, so a re-run reproduces the
same layout — a demo that reshuffles on every rebuild makes screenshots and bug
reports impossible to compare. Gemini's prose still varies.

### Restructuring without regenerating

```bash
demo/scripts/make-content.sh --retag   # no Gemini key, no new photographs
```

Runs `demo/scripts/retag-content.mjs` against the existing `demo/.scratch/`
instance: it folds each post's keywords onto the controlled vocabulary
(`TOPIC_ALIASES`), rebuilds the tree around what survived, moves the prose into
`excerpt`, sets the plugin selection, and re-records. Existing titles and text
are untouched.

It verifies the ≥2-posts-per-topic invariant *before* deleting anything, so a
vocabulary gap leaves the instance as it was rather than half-migrated. Post
timestamps are captured up front and restored afterwards — the API owns
`published_at`, and a PUT would collapse the 2020–2026 archive into today.

### Recording from a real instance instead

`demo/scripts/record-fixtures.mjs` works against any instance:

```bash
node demo/scripts/record-fixtures.mjs --base=http://localhost:8001 --session=<token>
MEDIA_SRC=/path/to/data/media/originals demo/scripts/build.sh
```

`<token>` is a raw value from the `sessions` table; any admin session works.
Nothing is written back to the source instance. Note that this publishes that
instance's content — see Scrubbing below.

### What the build reproduces

The Go server rewrites `index.html` in memory on every request and never touches
the file on disk (`api/cmd/api/main.go`). `demo/scripts/build-html.mjs` does that
work at build time:

- `__BUILD_VERSION__` → a fixed demo string
- `<!-- __HEAD_HTML__ -->` → empty (the demo embeds no third-party origin)
- **`window.__PLUGINS__` injected before `</head>`** — not optional:
  `core/pluginHost.js` is completely inert without it, silently costing the demo
  its media viewer, timeline and tag visualisation. The build fails rather than
  emit an empty manifest.

`feed.xml` and `sitemap.xml` are server-rendered in production, so
`demo/scripts/build-feeds.mjs` writes them out as files.

### Plugins withheld from the demo

| Plugin | Why |
|---|---|
| `comments` | Loads `/comments/web/embed.mjs` from a remark42 sidecar that does not exist. Omitting it also stops `CommentsAdminPage` (which calls `api.*` directly) from mounting |
| `mcp` | Server-side capability with no meaning without a server |
| `offline-sync` | Registers `/sw.js` and enables the IndexedDB mutation queue. A service worker would serve stale bundles, and the queue would accumulate writes that never drain |

`app.js` falls back to importing `offline-sync` statically when the manifest is
**empty**, so the manifest must be present and non-empty for that omission to
take effect. The build enforces this.

### Plugins the demo turns off

These ship in the bundle but are disabled in the recorded instance, so the demo
opens on a particular selection rather than the defaults:

| Plugin | State | Why |
|---|---|---|
| `tags-atlas` | on | The map answers "what is in this archive?" against the geography the tag tree now models |
| `tag-cloud` | off | Answers the same question as a flat weighted list — which is what the hierarchy replaces |
| `immersive-sheet` | on | Renders `excerpt`, where the demo's prose lives |
| `immersive` | off | Standard and Sheet are the two members of an exclusive area; at least one must stay enabled, so Sheet goes on **before** Standard goes off |

## Scrubbing

The generated pipeline produces nothing sensitive, but the recorder is also
usable against a real blog, so it scrubs at the recording boundary — an
unscrubbed fixture never exists on disk. It drops every settings key beginning
with `_` (`_secret_key` is the instance's signing key), drops known credential
keys, rewrites emails, and replaces the blog title and author identity with demo
values.

It then **audits its own output** and exits non-zero if a banned key or value
pattern survives. The audit checks keys and value patterns rather than doing a
raw substring search, which false-positives on innocent content — a migration is
genuinely named `migrate_secret_key_to_secrets`.

`fixtures.json` is gitignored. For the generated pipeline that is just build
output; if you record from a real instance, committing it is a publishing
decision rather than a build detail.

## Content licensing

Photographs come from picsum.photos, which serves Unsplash images under the
[Unsplash License](https://unsplash.com/license) (free to use commercially, no
attribution required). Post text is model-generated. Nothing in the demo bundle
is anyone's real content.

## Known limitations

- **`?thumb` does not resolve to a thumbnail.** The client appends it to media
  URLs in several admin views (`PostsListPage.js`, `VisualEditor.js`), and a
  static host ignores query strings, so the full-size image is served instead.
  `build.sh` downscales originals to compensate;
  `utils/helpers.js dropBrokenImages()` handles anything missing.
- **Backend-shaped admin surfaces are canned**: backups, log tailing,
  photo-library import, system restart, Instagram connect, passkey registration.
  They render and respond plausibly rather than being hidden — seeing that the
  features exist is the point.
- **The mock is a parallel implementation and will drift.** Fixtures being
  recorded rather than transcribed limits this, and `demo/scripts/test.mjs`
  catches it. Re-record at each release.

## Deploying

The output is static files with `_redirects` (SPA fallback) and `_headers`
(cache policy) for Cloudflare Pages. Content-hashed chunks get immutable
year-long caching; unhashed entry bundles and `index.html` revalidate so a
redeploy is picked up.

No WAF rules, rate limiting or bot rules are needed — there is nothing behind the
edge to protect.
