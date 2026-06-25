# Integrate point-mcp as an in-process `/mcp` plugin

## Context

`../point-mcp` is a standalone Go program (`github.com/dariy/point-mcp`) that exposes the
blog to AI clients via the Model Context Protocol: 28 tools, 3 resources, 1 prompt, served
over the MCP **streamable-HTTP** transport at `/mcp` and protected by its own OAuth 2.1
provider. Today it reaches the blog as an *external* HTTP client (`point.Client`) calling
point's REST `/api` with a Bearer API key, and runs as a separate process.

We want it to live **inside** the `point` server: accessible at `/mcp/`, toggleable like
any other plugin, talking to the blog's data **directly through the in-process services**
(no network hop, no second API key), and authenticating callers with **both** point's
existing API-key/session auth *and* a full OAuth 2.1 flow so remote MCP clients
(Claude.ai web/desktop) can connect by URL.

Decisions taken: **in-process plugin** topology · **direct service calls** for data ·
**both** auth mechanisms on the endpoint.

Hard constraint that shapes the approach: Go forbids importing another module's
`internal/` packages, so point-api cannot `go get` point-mcp's tools — the relevant code
is **vendored** into the point repo under `api/internal/mcp/...` and its import paths
rewritten from `github.com/dariy/point-mcp/internal/*` to `point-api/internal/mcp/*`.

## Approach

### 1. Vendor the MCP packages into point-api
Copy these point-mcp packages into `api/internal/mcp/`, rewriting imports to the
`point-api/internal/mcp/...` module path:

- `internal/tools`  → `api/internal/mcp/tools` (28 tool registrations + `Dispatch`)
- `internal/resources` → `api/internal/mcp/resources` (`point://context`, `point://theme/active`, `point://posts/recent`)
- `internal/prompts` → `api/internal/mcp/prompts` (`create_landing_page`)
- `internal/point` → `api/internal/mcp/point` (DTO **types** in `types.go` + the existing HTTP `Client`, kept as one implementation — see step 2)
- `internal/oauth` → `api/internal/mcp/oauth` (OAuth 2.1 provider + login page)

Add to `api/go.mod` (point-api is already Go 1.26.4, compatible with point-mcp's 1.26.3):
`github.com/modelcontextprotocol/go-sdk v1.6.1`, `github.com/google/jsonschema-go`,
`github.com/segmentio/encoding`, `github.com/yosida95/uritemplate/v3`,
`golang.org/x/oauth2`. Run `go mod tidy` in `api/`.

### 2. Replace the HTTP client with direct service calls (the core change)
The tool/resource handlers depend on the concrete `*point.Client`
(`tools.Register(s, c *point.Client)`, `resources.Register(s, c *point.Client)` —
`api/internal/mcp/tools/tools.go:17`, `resources/resources.go:15`).

- **Extract an interface** `point.API` in `api/internal/mcp/point/` listing exactly the
  methods the handlers use (the ~25 `func (c *Client)` methods in
  `posts.go`/`tags.go`/`media.go`/`themes.go`/`settings.go`/`system.go`, e.g. `ListPosts`,
  `GetPostByID`, `CreatePost`, `UpdatePost`, `Publish`, `Withdraw`, `DeletePost`,
  `GeneratePreviewLink`, `UpdateTags`, `GetPostAnalytics`, `ListTags`/`CreateTag`/…,
  `ListMedia`/`UploadFile`/`AnalyzeImageByID`, theme/settings/`GetStats`).
- Change `tools.Register` / `resources.Register` to take `point.API`. The existing HTTP
  `Client` already satisfies it, so the **standalone point-mcp binary keeps working** for
  stdio/CLI use — only the call sites' type changes.
- **New in-process adapter** `api/internal/mcp/serviceclient.go` (package in
  `internal/api` or a small new package) implementing `point.API` by delegating to the
  real services on the `svcs` struct: `PostService`, `TagService`, `MediaService`,
  `ThemeService`, `SettingsService`, `SystemService`
  (`api/internal/services/*_service.go`). Each method:
  1. calls the service (all take `context.Context`),
  2. translates `models.*` / service params ↔ the MCP DTOs in `point/types.go`.
     **Reuse the existing handler response-mappers** in `api/internal/api/*.go`
     (the `toPostResponse`-style converters the REST handlers already use) instead of
     duplicating model→DTO logic.
- **Context & identity:** the adapter is built **per request** (see step 3) so it captures
  `r.Context()` and the authenticated user id, letting it call ctx-bound services and pass
  author ids where required (`SoftDeletePost(id, authorID)`, Instagram cross-post, etc.)
  without adding `ctx` to every interface method.
- Note in code: `UploadFile(filePath)` semantics change — the path is now resolved on the
  **server host**, not the MCP client. Document this on the tool.

### 3. Mount `/mcp` in Echo, gated as a plugin, with both auth mechanisms
In `setupEcho()` (`api/cmd/api/main.go`, after the `/api/system` block ~line 408, before
the SPA fallback):

- Build the MCP HTTP handler with a **per-request server factory** so each request gets a
  fresh `mcp.Server` whose tools/resources are registered against an adapter bound to that
  request's context + user:
  ```go
  mcpHandler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
      srv := mcp.NewServer(&mcp.Implementation{Name: "point-mcp", Version: cfg.AppVersion}, nil)
      client := mcpapi.NewServiceClient(r.Context(), svcs, userFromCtx(r))
      mcptools.Register(srv, client)
      mcpresources.Register(srv, client)
      mcpprompts.Register(srv)
      return srv
  }, nil)
  ```
- **Both auth:** mount the vendored OAuth provider's discovery/token endpoints on Echo
  (`provider.Register` → adapt its `*http.ServeMux` handlers to Echo routes:
  `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
  `/oauth/register`, `/oauth/authorize`, `/oauth/token`). Wrap the MCP handler with a
  **combined auth middleware** that accepts EITHER: point's existing API-key/session auth
  (reuse `AuthMiddleware`'s validation against `svcs.Auth`/`svcs.ApiKey`) OR an OAuth
  bearer token validated by `provider.RequireBearer`. On success it stuffs the resolved
  user into the request context for `userFromCtx`.
- Wire the OAuth login (`handleAuthorizePOST`) to validate credentials against
  **`svcs.Auth`** (the real admin password) rather than a standalone `MCP_PASSWORD`, so
  there is one credential. Keep `MCP_PASSWORD` as a fallback only if `svcs.Auth` wiring is
  deferred.
- Gate everything with `api.RequirePlugin(svcs.Settings, "mcp")` so the endpoint 404s when
  the plugin is disabled. Register `/mcp` and `/mcp/*` (Echo `Any`) via `echo.WrapHandler`.

### 4. Register the plugin
Add to `api/internal/plugins/registry.go` `Registry` (backend-gated services block ~line 96):
```go
{ID: "mcp", Type: TypeService, Routes: []string{"/mcp"}, DefaultEnabled: false},
```
`DefaultEnabled: false` — it's a powerful remote-control surface; admins opt in from the
Plugins page. The existing toggle UI/flow needs no other change (it's data-driven from the
registry).

### 5. Config
Add to `api/internal/config/config.go`: `MCP_BASE_URL` (public HTTPS URL of this server,
needed for OAuth discovery; default to existing `APP_URL` if unset) and optional
`MCP_AUTH_TOKENS` (static bearer tokens for legacy/programmatic clients). No
`POINT_BASE_URL`/`POINT_API_KEY` needed anymore — data access is in-process.

## Critical files
- New: `api/internal/mcp/{tools,resources,prompts,point,oauth}/…` (vendored)
- New: `api/internal/api/mcp_serviceclient.go` (the `point.API` adapter over services)
- Edit: `api/cmd/api/main.go` `setupEcho()` — mount `/mcp`, OAuth routes, combined auth
- Edit: `api/internal/plugins/registry.go` — add `mcp` descriptor
- Edit: `api/internal/config/config.go` — `MCP_BASE_URL`, `MCP_AUTH_TOKENS`
- Edit: `api/go.mod` / `go.sum` — MCP SDK + deps

## Verification
1. **Build/unit:** `cd api && go build ./... && go test ./internal/mcp/... ./internal/services/...`
   (port the vendored `*_test.go`; add adapter tests asserting model→DTO translation).
2. **Run locally:** `scripts/run-local.sh` (localhost:8001).
3. **Plugin gating:** with `mcp` disabled, `curl -i localhost:8001/mcp` → 404. Enable it on
   the admin Plugins page, repeat → 401 (auth required).
4. **API-key auth:** create a key (api-keys plugin), then an MCP `initialize` +
   `tools/list` POST to `/mcp` with `Authorization: Bearer <key>` → returns the 28 tools.
   Call `point_list_posts` and confirm results match `/api/posts`.
5. **OAuth flow:** `curl localhost:8001/.well-known/oauth-authorization-server` returns
   discovery; complete register → authorize (log in with the admin password) → token, then
   call `/mcp` with the issued bearer.
6. **End-to-end:** add `http://localhost:8001/mcp` as a remote MCP server in an MCP client
   and exercise create/update/publish a draft post; confirm the change appears in the blog
   and that no second process / API key is involved.

## Out of scope / notes
- The standalone `../point-mcp` binary stays as-is for stdio/CLI usage (interface
  extraction is backward-compatible). Vendoring forks the code — note divergence in a
  `README`/comment so future upstream changes are merged deliberately.
- stdio transport is **not** added to the web server; `/mcp` is HTTP-only.
