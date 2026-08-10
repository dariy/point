# Comments (remark42)

Optional built-in commenting via the [remark42](https://remark42.com) engine, shipped
as the `comments` enhancer plugin (slot `post-comments`, routes `/comments`,
`/light/comments`, `/api/admin/comments`).

## What is implemented

- **Bundled engine, supervised**: Point does not reimplement comments — it runs the
  remark42 binary as a supervised child process
  (`api/internal/services/remark_supervisor.go`) and reverse-proxies it under
  `<APP_URL>/comments`. No separate container or service to operate.
- **Activation** is config-driven: setting both `REMARK_URL` (public URL of the
  comments endpoint, i.e. `<APP_URL>/comments`) and `REMARK_SECRET` (JWT-signing
  secret) starts the engine. Unset = feature off.
- **Widget** under every post (public side, via the plugin slot). Visitors authenticate
  with whatever remark42 itself offers — anonymous, GitHub, Google, email — configured in
  Settings → Comments. Point is not an OAuth provider and offers no login button of its
  own; the owner is authenticated by the JWT cookie bridge below.
- **Moderation inside Point admin**: `/light/comments` (CommentsAdminPage in
  `frontend/src/plugins/comments/`) surfaces moderation without leaving the Point UI,
  backed by `/api/admin/comments`.

## Key decisions

- **Supervisor over sidecar**: a child process keeps the single-container promise
  (one image, one process tree, SQLite-only ops story) while reusing a mature comments
  engine. The supervisor handles lifecycle/restart (see `remark_supervisor_test.go`).
- **Auth bridge via JWT secret**: `REMARK_SECRET` signs the tokens that let Point act
  as the identity provider for the embedded engine. `IssueRemark42Cookies`
  (`api/internal/api/remark_auth.go`) sets them on *every* path that establishes a Point
  session — password login, passkey login, and `/api/auth/me` when the cookie is missing
  or near expiry — because the owner has no other way in: no login button in the widget
  can authenticate them, so a session without the cookie is anonymous with no recovery.
- **The `AUTH_CUSTOM_*` block in the supervisor is load-bearing — do not delete it.**
  It registers a provider named `point` whose OAuth URLs are deliberately inert (they
  point back into remark42 through the proxy). The registration is the point:
  go-pkgz/auth's middleware rejects any token whose provider — read from the `point_`
  prefix of the `point_<id>` subject — is not a registered provider, failing with
  `user …/point_1 provider is not allowed`. Remove the block and the bridge above stops
  authenticating anyone.
- **The dead provider is hidden, not removed**: because those URLs cannot complete a
  login, `stripPointProvider` (`api/internal/api/comments.go`) filters `point` out of
  `auth_providers` in the proxied `/comments/api/v1/config`, which is what the widget
  builds its login buttons from. The engine's own provider check reads its registry, not
  this response, so hiding the button leaves auth intact.
- Plugin-gated like everything else: disabling `comments` 404s the routes and removes
  the widget from the manifest.

## The slim image

Every release publishes two flavours (the `flavor` matrix in
`.github/workflows/release.yml`): the full image, and a `-slim` one built with
`--build-arg IS_SLIM=true` that leaves the remark42 binary out entirely — the
Dockerfile swaps the `remark42-<IS_SLIM>` stage for an empty alpine, saving the
engine's footprint for installs that will never enable comments.

`IS_SLIM` is baked into the image as an env var and is the single switch that
flavour-aware code reads:

- `listViews` (`api/internal/api/plugins.go`) drops `comments` from the admin
  plugin catalog — the plugin cannot be enabled when its binary is absent.
  `ENABLE_REMARK42=false` does the same for a local dev run.
- `GetVersion` labels the reported versions `-slim`, matching the image tag the
  admin would actually pull.

The name is deliberately generic: it marks the flavour, not one feature, so a
future omission can reuse it rather than adding a second `WITH_<thing>` arg.

## Out of scope

- Point-native comment storage/threading — remark42 owns comment data (its own data
  files live alongside Point's under the data volume; back up both).
- Comment federation or external comment services.
