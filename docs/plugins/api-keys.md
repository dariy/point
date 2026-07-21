# API Keys (`api-keys`)

**Type:** service · **Routes:** `/api/api-keys` · **Default:** enabled

Long-lived, revocable API keys for programmatic access via `Authorization: Bearer` —
used by scripts, MCP sidecar deployments, and any REST client. Keys are hashed at rest
and never redisplayed after creation. Disabling the plugin 404s `/api/api-keys` and
revokes the ability to authenticate via bearer token (existing sessions/password login
are unaffected).

See [Authentication & Account Security](../features/auth.md) for how API keys relate
to the single admin identity shared across all auth mechanisms.
