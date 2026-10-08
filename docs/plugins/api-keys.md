# API Keys (`api-keys`)

**Type:** service · **Routes:** `/api/api-keys` · **Default:** disabled

Long-lived, revocable API keys for programmatic access via `Authorization: Bearer` —
used by scripts, MCP sidecar deployments, and any REST client. Keys are hashed at rest
and never redisplayed after creation. Disabling the plugin 404s `/api/api-keys` and
revokes the ability to authenticate via bearer token (existing sessions/password login
are unaffected).

The bearer half of that is enforced in `ApiKeyService.ValidateAPIKey`, not in the
route table: `RequirePlugin` guards only the management routes, while the toggle has
to close every path that accepts a key — `AuthMiddleware`, `OptionalAuthMiddleware`
and the MCP bearer path all go through that one method. Because the plugin ships
disabled, a key minted with `point --create-api-key` on a fresh install does not
authenticate until the plugin is switched on; the CLI says so after printing the key.

See [Authentication & Account Security](../features/auth.md) for how API keys relate
to the single admin identity shared across all auth mechanisms.
