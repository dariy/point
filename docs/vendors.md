# Third-Party Vendors & Libraries

A reference list of external libraries and services Point depends on, and what
each one is used for. Point deliberately keeps this list short — most UI (the
force-directed tag graph, timeline, lightbox, editor toolbars) is hand-rolled
rather than pulled in from a library. See [Architecture](./architecture/frontend.md)
for why (small, dependency-light Vanilla JS Component System).

## Frontend (vendored JS)

No JS runtime dependencies are installed via npm — `esbuild` and `eslint` in
`package.json` are build-time only. Third-party browser code lives, unminified
and reviewable, in `frontend/vendor/`:

| Library | Version | Used for |
|---|---|---|
| [Leaflet](https://leafletjs.com) | 1.9.4 | Interactive maps — geo-tagged posts, the Tags Map view (`frontend/src/plugins/tags-map/`). Tiles from CartoDB basemaps (`{s}.basemaps.cartocdn.com`), the only third-party origin allowed by the default CSP. |
| [Prism.js](https://prismjs.com) | core + per-language grammars | Syntax highlighting for fenced code blocks in rendered Markdown and in the post editor. |
| [CodeJar](https://github.com/antonmedv/codejar) | vendored, unversioned | Minimal code-editing textarea (line editing, indent/outdent, bracket auto-close) backing the CSS editor and code blocks in the Markdown/Visual editor. |

Notably *not* used: no D3 — the Tags Graph (`frontend/src/plugins/tags-graph/tagGraph.js`)
is a dependency-free force-directed layout renderer on `<canvas>`; no
lightbox/carousel library — `MediaLightbox`/`MediaViewer`/immersive mode are
custom components; no Markdown-it/marked on the client (Markdown is rendered
server-side, see below).

## Backend (Go modules)

Direct dependencies from `api/go.mod`, grouped by purpose:

**Web framework & auth**
- [`labstack/echo/v4`](https://echo.labstack.com) — HTTP router/framework.
- [`go-pkgz/auth/v2`](https://github.com/go-pkgz/auth) — session/JWT auth middleware, OAuth provider support (`api/internal/api/auth.go`).
- [`go-webauthn/webauthn`](https://github.com/go-webauthn/webauthn) — WebAuthn/passkey registration and login.
- [`golang-jwt/jwt/v5`](https://github.com/golang-jwt/jwt) — JWT signing, including the remark42 SSO cookie.
- [`golang.org/x/crypto`](https://pkg.go.dev/golang.org/x/crypto) — password hashing and related primitives.

**Content pipeline (Markdown → sanitized HTML)**
- [`yuin/goldmark`](https://github.com/yuin/goldmark) — Markdown → HTML rendering, with the `extension` (GFM tables, strikethrough, etc.) and `parser`/`html`/`util` packages.
- [`mdigger/goldmark-attributes`](https://github.com/mdigger/goldmark-attributes) — `{...}` attribute syntax on Markdown blocks.
- [`stefanfritsch/goldmark-fences`](https://github.com/stefanfritsch/goldmark-fences) — custom fenced containers (used for embeds/callouts in post content).
- [`microcosm-cc/bluemonday`](https://github.com/microcosm-cc/bluemonday) — HTML sanitizer; strips everything not on the allowlist before rendered content ever reaches a browser.
- [`gorilla/css`](https://github.com/gorilla/css) — CSS tokenizer, used by `SanitizePostCSS` to validate per-post custom CSS (see [Themes](./features/themes.md)).

**Media & EXIF**
- [`disintegration/imaging`](https://github.com/disintegration/imaging) — image decoding, resizing (`imaging.Fill`/Lanczos), thumbnail generation.
- [`dsoprea/go-exif/v3`](https://github.com/dsoprea/go-exif), `dsoprea/go-jpeg-image-structure/v2`, `dsoprea/go-iptc`, `dsoprea/go-photoshop-info-format`, `dsoprea/go-utility/v2` — EXIF/IPTC read and rewrite (`api/internal/services/exif_writer.go`).
- [`rwcarlsen/goexif`](https://github.com/rwcarlsen/goexif) — secondary EXIF reader used alongside dsoprea's.

**AI**
- [`google.golang.org/genai`](https://pkg.go.dev/google.golang.org/genai) — official Gemini SDK, powers the optional [AI Analysis](./features/ai-analysis.md) (title/tags/excerpt suggestions from an uploaded image). Bring-your-own-key; unused with no `GEMINI_API_KEY` set.

**MCP**
- [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk) — official Go SDK backing the [MCP server](./features/mcp.md) at `/mcp`.

**Storage & config**
- [`modernc.org/sqlite`](https://pkg.go.dev/modernc.org/sqlite) — pure-Go (no cgo) SQLite driver; Point's only database.
- [`spf13/viper`](https://github.com/spf13/viper) — config file + env var loading.

**Misc utilities**
- [`mozillazg/go-unidecode`](https://github.com/mozillazg/go-unidecode) — Unicode → ASCII transliteration for slug generation.
- [`golang.org/x/term`](https://pkg.go.dev/golang.org/x/term), [`golang.org/x/time`](https://pkg.go.dev/golang.org/x/time) — terminal input (CLI/setup) and rate limiting.
- [`stretchr/testify`](https://github.com/stretchr/testify) — test assertions/mocks (test-only).

Everything else in `go.mod` is a transitive (indirect) dependency pulled in by
the packages above.

## Sidecar services

- **[remark42](https://remark42.com)** — the comments engine. Not a Go/JS
  library import; it runs as a separate process/sidecar (`api/internal/services/remark_supervisor.go`
  launches the bundled binary, or `scripts/run-remark42-local.sh` for local
  dev) and Point proxies to it at `/comments`. See [Comments](./features/comments.md).

## External network origins

Point's default Content-Security-Policy is deliberately narrow. The only
third-party origin allowed out of the box is `*.basemaps.cartocdn.com` (map
tiles for Leaflet). Anything else — analytics, verification scripts — is
opt-in via `HEAD_HTML` + `CSP_SCRIPT_SRC`/`CSP_CONNECT_SRC`, see
[Syndication & SEO](./features/syndication.md) and `api/cmd/api/main.go`.
