# Instagram (`instagram`)

**Type:** service · **Routes:** `/api/instagram` · **Default:** enabled

Two directions of Instagram integration, both gated behind this plugin: **cross-posting
(outbound)** — publish a post's photos to a connected Instagram Business/Creator
account (single image or up to a 10-image carousel) on publish or on demand — and
**import (inbound)** — pull the account's existing posts into Point as drafts, via an
idempotent re-runnable sync. The admin brings their own Meta app credentials; Point
runs no shared OAuth proxy. Disabling the plugin 404s `/api/instagram` and hides the
integration's settings UI.

See [Instagram Integration](../features/instagram-integration.md) for the full
cross-posting and import behavior.
