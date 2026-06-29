# Point — Creative Usages

Point presents itself as a self-hosted photo blog, but underneath it is a small
set of unusually composable primitives: a GPS-aware media store, a hierarchical
tag DAG with three interchangeable visualizations, per-post sanitized CSS, a full
post lifecycle, three control planes (SPA, REST API, MCP server), a PWA layer,
and a plugin registry where disabled plugins 404 entirely. The combinations of
those primitives produce uses well beyond "a blog." This document catalogs them.

Each proposal below names the actual capabilities that make it real, so it can be
read as a feature brief rather than marketing copy.

---

## 1. The AI-operated blog ("agentic blogging")

Point ships a first-class MCP (Model Context Protocol) server at `/mcp` that
exposes the blog as a set of tools an AI client can call directly: create and
update posts, upload and analyze media, manage and geocode tags, set the active
theme, generate preview links, and read analytics. Combined with the built-in
Gemini image analysis (title/tags/excerpt suggestions), the scheduler, and
Instagram cross-posting, an agent can run the entire publishing pipeline.

The practical workflow is hands-off: point an agent at a folder of photos and it
analyzes each image, geocodes the tags, schedules a drip of posts, and
cross-posts on publish. No other self-hosted blog engine treats remote control by
an AI assistant as a built-in, opt-in surface. The headline writes itself — "the
blog your AI assistant runs for you."

## 2. Per-post CSS — a micro-site in every post

The `custom-css` content enhancer lets every post carry its own stylesheet, run
through `SanitizePostCSS` so it cannot break out of the post or inject unsafe
properties. A post is therefore not just text and images in a fixed template; it
is a small, independently designed surface that the author controls down to the
layout.

This turns individual posts into one-off artifacts: a zine spread, a digital
exhibit panel, a designed landing page, or a Linktree-style card. Authors who
want a single bespoke page do not need a separate site builder — they write one
post and style it. Every post is, in effect, its own little website.

## 3. Photographer client proofing and private delivery

Point combines time-limited preview links, the `hidden` post status, the
`hides_posts` tag flag, and the immersive/slideshow viewers into a complete
client-delivery workflow. An unpublished gallery can be handed to a client behind
an expiring URL, kept invisible to the public, and presented full-screen without
chrome.

When the client approves, the post flips from hidden to published with a single
status change — no re-upload, no second tool, no external proofing service. For a
working photographer this replaces a whole category of SaaS subscriptions with a
configuration of features that already ship in the box.

## 4. A front door over an existing photo archive

The read-only photo-library import points Point at an existing folder — for
example a Lightroom export — and imports new files without moving or copying the
originals. Point becomes a publishing and browsing layer on top of an archive you
continue to curate elsewhere, rather than yet another place your photos have to
live.

This matters for anyone with an established workflow: the archive stays the source
of truth, and Point adds web presentation, tagging, and syndication on top. The
engine's name lands here — you do not migrate your photos, you point at them.

## 5. Digital signage and exhibition kiosk

The auto-advancing slideshow plugin, the chrome-less immersive viewer, and the
theme / per-post CSS system together produce a self-running visual display. Run
full-screen on an inexpensive device — the multi-arch images include arm64, so a
Raspberry Pi wired to a TV works — and the screen becomes a rotating gallery
wall.

Because the same content is reachable through the REST API and the MCP server,
the wall is also remotely updatable: change what is showing without touching the
device. This covers exhibition displays, lobby signage, restaurant menus of
imagery, and event galleries, all from a deployment that costs almost nothing to
run.

## 6. A visual knowledge graph / image zettelkasten

The hierarchical tag DAG allows a tag to have multiple parents and multiple
children, and the force-directed graph view renders the whole tag/post/edge
structure on a canvas. With recursive post retrieval, browsing a parent surfaces
everything beneath it. The result is a corpus of images navigated as a knowledge
graph rather than a linear feed.

Used this way Point is a design-reference library, an art-collection catalog, a
moodboard, or a research image bank — none of which are "a blog." The graph,
atlas, and map views give three different lenses on the same relationships, so the
same data set supports browsing by structure, by place, or by similarity of
connection.

## 7. Geospatial field log

EXIF GPS extraction promotes location data into geo-tags carrying latitude and
longitude, which then appear on the Leaflet map, in the atlas view (posts fanned
as chips pinned to a place), and in the timeline's location drill-down. The
map-plus-timeline combination is effectively a personal GIS for media: where was
I, and when.

This supports travel journals, field-biology surveys, real-estate portfolios,
construction progress logs, and architecture or urban-exploration catalogs.
Anything where the value of an image is tied to its place and its moment is
served better by this combination than by a chronological blog.

## 8. Offline-first field capture

The PWA layer registers a service worker, ships a Web Share Target so Point
appears in the mobile system share sheet, maintains an offline snapshot, and
queues actions for sync. A photographer or inspector in the field with no
connectivity can capture content directly — sharing from the phone gallery into a
new draft — and have it sync when back online.

This makes Point usable as a capture tool at the edge of the network, not just a
publishing destination reached over a good connection. Inspection reports,
expedition journaling, and on-site event coverage all benefit from the
capture-now-sync-later model.

## 9. Headless content backend

API-key authentication issues long-lived, revocable Bearer tokens, and the MCP
server plus the RSS feed and sitemap mean the blog's content is fully reachable
without its own frontend. The SQLite store and clean API let Point back a static
site generator, a mobile app, or an entirely separate presentation layer.

In this role Point is the content management and media-processing engine, and
something else renders the result. The team that wants Point's tagging, EXIF, and
AI-assisted authoring but has its own design system can take the data and leave
the SPA behind entirely.

## 10. Hardened minimal deployment

Point's plugin system enforces an enabled-only manifest: a disabled plugin's
JavaScript chunks and API routes are not merely hidden, they 404. Turning off MCP,
Instagram, API keys, and the optional view plugins genuinely removes those
surfaces rather than concealing a still-present endpoint.

This produces an honest security claim that few engines can make — turn a feature
off and it is actually gone. A security-conscious operator can ship a deliberately
tiny attack surface: a read-only public gallery with every optional route absent.
The minimalism is a deployment posture, not a setting that pretends.

## 11. Audio diary / proto-podcast

The unified media library accepts audio files alongside images and video, and the
engine already generates an RSS feed of published posts. An author can keep an
audio journal or publish short audio pieces through the same posting and tagging
workflow used for photos.

This is not a full podcast host — there is no episode-specific feed tooling — but
for a personal audio log or a small enclosure feed it is sufficient out of the
box. It widens "photo blog" into "media blog" with no additional configuration.

## 12. Headless "bare gallery" — drop-in for a static site

The `public-header` and `public-footer` are non-core slot plugins and can both be
disabled, leaving their shell regions empty. The post grid, the post page and
viewer, and tag-archive routing are core application code rather than plugins, so
they survive with every optional plugin turned off. The remaining surface is a
chrome-less list of posts, a post page, and navigation by tag — and nothing else.

Because disabled slots render empty rather than hidden, and no frame-busting
header is set by default, this bare configuration can be embedded directly into an
existing static site: dropped into an `<iframe>` as a self-updating photo section,
or reverse-proxied under a subpath (`example.com/blog/`) so it inherits the parent
site's own header and footer. A hand-built static site keeps its design while
Point quietly supplies the dynamic media-and-tag backend behind one element or one
nginx `location` block. If you ship this publicly, set a `frame-ancestors`
allowlist rather than leaving framing open.
