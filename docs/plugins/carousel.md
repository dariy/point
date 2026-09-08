# Carousel Studio (`carousel`)

**Type:** route · **Routes:** `/light/carousel`, `/api/carousel` · **Default:** disabled · **Title:** Carousel Studio

An admin studio that turns a post's media into a designed, Instagram-ready slide deck.
The route is param-less — plugin admin routes are merged verbatim from the manifest and
filtered on the `/light` prefix, and the page title is taken from the last path segment
— so the target post rides in the query string: `/light/carousel?post=<id>`. The post
editor's overflow menu grows a **Carousel Studio** entry, gated on this plugin and shown
only for a saved post, that links straight to it.

Off by default: published `:::{.carousel-block}` output stays styled with the plugin
disabled (the public CSS is in the main bundle, not the plugin dir), so only editors who
want the builder turn it on. Disabling the plugin 404s the studio chunk and `/api/carousel`
entirely.

The builder itself is past the gated-skeleton stage: the splitter (source picker, fit
panel with count/strategy chips, live sizing readout), per-slide crop-accurate rendering
with progress, dirty-state tracking, and a confirmed remove action are all live behind
this gate. There is no settings-drawer affordance for the plugin yet — see "Out of scope"
in the feature doc. Framing, layers, and templates (S2 onward) are still ahead.

`GET/PUT/DELETE /api/carousel?post=<id>` stores one carousel document per post in the
`carousels` table (`post_id` UNIQUE, `ON DELETE CASCADE`). The document body is opaque —
the server validates only that it is a JSON object and round-trips it verbatim; the
schema is `frontend/src/plugins/carousel/document.js`.

See [Carousel Studio](../features/carousel-studio.md) for the output contract, the
document schema, and the delivery stages.
