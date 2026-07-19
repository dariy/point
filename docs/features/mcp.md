# MCP Server

Point ships a built-in [Model Context Protocol](https://modelcontextprotocol.io) server at
`/mcp` (streamable-HTTP transport), so Claude or any MCP client can manage the blog
directly. It is an opt-in plugin (`mcp`, `DefaultEnabled: false` — a powerful remote-control
surface admins must consciously enable from `/light/plugins`).

## What is implemented

- **28 tools** (`api/internal/mcp/tools.go`): posts (list/get/create/update/publish/
  withdraw/delete, `point_replace_in_post`, `point_set_post_tags`,
  `point_generate_preview_link`), tags (CRUD + `point_geocode_tag`), media
  (list/upload/analyze), themes (list/get CSS/set active), settings (get/update),
  analytics (summary, top posts), plus `point_get_context` and the static
  `point_get_syntax_guidelines`.
- **3 read-only resources** (`resources.go`): `point://context`, `point://theme/active`,
  `point://posts/recent`.
- **1 prompt** (`prompts.go`): the `create_landing_page` workflow.
- **Dual auth on the endpoint**: Point's existing API-key/session auth *or* a full
  OAuth 2.1 flow (`api/internal/mcp/oauth/` — a minimal from-scratch provider with
  discovery, dynamic client registration, authorize, token) so remote clients
  (Claude.ai web/desktop) can connect by URL. OAuth login validates against the real
  admin credential — there is no separate MCP password.
- **Plugin gating**: with the plugin disabled, `/mcp` and the OAuth discovery routes 404.

## Key architectural decisions

1. **In-process dispatch to REST handlers, not a service-client layer.** The original
   plan (see git history of `mcp_proposal.md`) was to vendor the standalone `point-mcp`
   project and adapt its HTTP client into a `point.API` interface over the services.
   The final implementation went further: `invoke.go` builds a synthetic `echo.Context`
   carrying the request context and authenticated principal and calls the existing REST
   handlers directly. MCP therefore behaves *exactly* like the REST API — same
   validation, same response mappers, same business rules — with no second process, no
   network hop, no DTO layer to keep in sync.
2. **Layering**: `mcp` imports `api` (for handler types); `api` never imports `mcp`.
   Wiring happens in `cmd/api/main.go` via `mcp.Register(e, mcp.Deps{...})`. No import
   cycle, no interface seam needed.
3. **Typed tool inputs, passthrough outputs.** Tool input structs drive the
   model-facing JSON schema; outputs are the handler JSON passed straight through.
4. **Sandboxed uploads**: `point_upload_media` resolves paths on the **server host**,
   restricted to `PHOTO_LIBRARY_PATH` (the path is not on the MCP client's machine).
5. **Config**: `MCP_BASE_URL` is the public HTTPS base for OAuth discovery; it falls
   back to `APP_URL`.

## Out of scope

- stdio transport — `/mcp` is HTTP-only; the standalone `point-mcp` binary remains
  the stdio/CLI option.
- Multi-user authorization — the MCP principal is the single admin.

## Notes for future development

- The OAuth provider (`internal/mcp/oauth`, ~478 LOC) has **zero test coverage** —
  tracked as `point-test-mcp-oauth-coverage-2ng7` / `point-mcp-oauth-tests-ebxr`.
- Destructive tool semantics: `point_update_tag` (like the REST PUT it wraps) replaces
  the whole tag — omitted fields are wiped; clients must resend the full object.
- When adding a REST endpoint that should be MCP-visible, add a tool entry in
  `tools.go`; the dispatcher needs no changes.
