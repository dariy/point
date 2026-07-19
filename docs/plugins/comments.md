# Comments (`comments`)

**Type:** enhancer · **Slot:** `post-comments` · **Routes:** `/comments`, `/light/comments`, `/api/admin/comments` · **Default:** enabled · **Title:** Comments (Remark42)

Embeds a [remark42](https://remark42.com) comments widget below post content. Point
runs the remark42 binary as a supervised child process
(`api/internal/services/remark_supervisor.go`) and reverse-proxies it under
`<APP_URL>/comments` — no separate container to operate. The plugin also owns the
`/light/comments` moderation page (nav-menu pattern: one plugin = public surface +
admin page). Disabling the plugin 404s both the JS chunk and every widget asset served
through the gated proxy.

The widget's theme (colors, dark/light) is synced live from the site's active theme
tokens via CSS custom-property injection into the same-origin iframe.

See [Comments (remark42)](../features/comments.md) for activation (`REMARK_URL` /
`REMARK_SECRET`) and moderation details.
