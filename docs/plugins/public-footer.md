# Public Footer (`public-footer`)

**Type:** slot · **Slot:** `footer` · **Default:** enabled

Renders the public site's footer. A thin wrapper around the shared `PublicFooter`
component; disabling the plugin removes the footer from every public page.

## The copyright line

`footer_copyright` (Settings) is a template. Blank falls back to
`© {{author_name}}, powered by {{engine}}`.

| Form | Renders as |
|---|---|
| `{{author_name}}` | The author, linked to the About post (or `/light` when none is set) |
| `{{engine}}` | A link to the Point repository |
| `[text](https://example.com)` | An external link — new tab, `rel="noopener noreferrer"` |
| `[text](/path)` | A same-site link, same tab |

Everything else is literal text and is escaped, so raw HTML in the field shows
as visible markup rather than becoming an element. An href that is neither
http(s) nor a site-relative path — `javascript:`, `data:`, protocol-relative
`//host` — is not linked; the line renders as the `[text](url)` the admin typed.
`frontend/test/publicFooter.test.js` covers each of those.
