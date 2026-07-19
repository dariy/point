# Authentication & Account Security

Single-admin authentication with several credential surfaces. Services:
`auth_service.go`, `webauthn_service.go`, `apikey_service.go`, `email_service.go`,
`password.go` under `api/internal/services/`.

## What is implemented

- **Password auth** with modern hashing: passwords hash with Argon2id (legacy bcrypt
  hashes are transparently rehashed on successful login — there's a known logging gap
  on rehash failures).
- **Sessions**: HTTP-only cookies, TTL via `SESSION_EXPIRY_HOURS` (default 30 days).
  The Security page (`/light/security`) lists active sessions with device/IP, revokes
  individual sessions, logs out all other devices, changes password.
- **Passkeys / WebAuthn** (plugin `passkeys`, routes `/api/auth/webauthn`): register
  and log in with platform authenticators alongside password auth; managed from the
  Security page.
- **API keys** (plugin `api-keys`, routes `/api/api-keys`): long-lived revocable keys
  for programmatic access via `Authorization: Bearer` — used by scripts, the MCP
  sidecar deployments, and any REST client. Keys are hashed at rest and never
  redisplayed.
- **Password recovery**, two paths:
  - **SMTP reset emails** (`email_service.go`): configured via `SMTP_HOST/PORT/
    USERNAME/PASSWORD/FROM`; reset tokens are hashed, single-use, 1-hour expiry.
  - **Offline CLI**: `point reset-password` (`api/cmd/api/resetpassword.go`) for
    operators locked out without SMTP — runs against the DB directly.
- **MCP OAuth 2.1** is a separate surface with its own provider but validates the same
  admin credential (see [mcp.md](mcp.md)).
- **Guest filtering is server-side everywhere** — see
  [hidden-visibility.md](hidden-visibility.md); admin routes sit behind
  `AuthMiddleware`, public reads behind `OptionalAuthMiddleware`.

## Key decisions

- One admin identity; all auth mechanisms (password, passkey, API key, OAuth bearer)
  resolve to the same principal — authorization stays trivial.
- Auth mechanisms are plugins where they're optional attack surface (passkeys,
  api-keys, mcp): disabled → routes 404.
- Secrets (API keys, reset tokens, Instagram/Gemini credentials) are never returned by
  any endpoint; `*_is_set` booleans drive the UI.

## Known open items

- Session cookies lack the `Secure` flag and there's no HSTS.
- Login rate limiting is bypassable via `X-Forwarded-For`; no rate limit on the
  public API surface.
- `SECRET_KEY` is currently dead code.
- Email service review findings: envelope parsing, SMTP injection, STARTTLS downgrade,
  timeouts.
