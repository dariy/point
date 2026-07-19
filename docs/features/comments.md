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
- **Widget** under every post (public side, via the plugin slot), supporting anonymous
  or OAuth commenting per remark42 configuration.
- **Moderation inside Point admin**: `/light/comments` (CommentsAdminPage in
  `frontend/src/plugins/comments/`) surfaces moderation without leaving the Point UI,
  backed by `/api/admin/comments`.

## Key decisions

- **Supervisor over sidecar**: a child process keeps the single-container promise
  (one image, one process tree, SQLite-only ops story) while reusing a mature comments
  engine. The supervisor handles lifecycle/restart (see `remark_supervisor_test.go`).
- **Auth bridge via JWT secret**: `REMARK_SECRET` signs the tokens that let Point act
  as the identity provider for the embedded engine.
- Plugin-gated like everything else: disabling `comments` 404s the routes and removes
  the widget from the manifest.

## Out of scope

- Point-native comment storage/threading — remark42 owns comment data (its own data
  files live alongside Point's under the data volume; back up both).
- Comment federation or external comment services.
