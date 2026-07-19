# Passkeys (`passkeys`)

**Type:** service · **Routes:** `/api/auth/webauthn` · **Default:** enabled

WebAuthn/passkey authentication: register and log in with platform authenticators
alongside password auth, managed from the Security page (`/light/security`).
Disabling the plugin 404s `/api/auth/webauthn` and removes the passkey UI, without
affecting password login or sessions.

See [Authentication & Account Security](../features/auth.md) for how this fits
alongside password auth, API keys, and MCP OAuth.
