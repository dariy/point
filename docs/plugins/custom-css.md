# Custom CSS (`custom-css`)

**Type:** enhancer · **Default:** enabled

Global custom CSS injection: admin-authored CSS (managed from the Themes page) applied
site-wide, layered on top of the active theme. Has no frontend chunk of its own — the
CSS injection lives in core rendering — so the plugin's only role is gating the
`/api/themes/custom-css` endpoints via `RequirePlugin`. Disabling it 404s those
endpoints and stops the custom CSS from being served, without touching the theme
system itself.

Distinct from **per-post CSS**, which is a post-level feature (not a plugin) covered in
[Themes](../features/themes.md).
