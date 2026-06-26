# internal/mcp — in-process MCP server

Serves the blog over the Model Context Protocol at `/mcp`, in-process (single
binary, no sidecar). Tool calls are dispatched to the existing REST handlers with
the caller's identity injected, so MCP behaves exactly like the REST API (same
validation, mappers, business rules) with no second process, no network hop, and
no API key for data access.

This is a from-scratch integration; it keeps the *business logic* of the
standalone `point-mcp` project (tool names/schemas, the landing-page prompt, the
syntax guidelines) but not its architecture (no separate API client, DTO layer,
or interface — those mirrored the REST API needlessly).

## Files
- `server.go` — `Deps` + `Register`: mounts `/mcp` and OAuth 2.1 discovery on
  Echo, gated by the `mcp` plugin; combined API-key/session + OAuth bearer auth.
- `invoke.go` — the in-process dispatcher: builds a synthetic `echo.Context` with
  the request context + principal, calls a REST handler, returns its JSON. Also
  the sandboxed media upload (`PHOTO_LIBRARY_PATH`).
- `tools.go` — the 28 tools. Inputs are typed (drive the model-facing schema);
  outputs pass the handler JSON straight through.
- `content.go` — static `point_get_syntax_guidelines`.
- `resources.go` — the three read-only resources.
- `prompts.go` — the `create_landing_page` workflow prompt.
- `oauth/` — minimal OAuth 2.1 provider for remote MCP clients.

## Layering
`mcp` imports `api` (for the handler types); `api` does **not** import `mcp`, so
there is no cycle and no need for an interface seam. Wiring happens in
`cmd/api/main.go` via `mcp.Register(e, mcp.Deps{...})`.
