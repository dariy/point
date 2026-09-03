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
entirely. The builder itself lands in stages — this is the gated skeleton.

See [Carousel Studio](../features/carousel-studio.md) for the output contract, the
document schema, and the delivery stages.
