# Backups (`backups`)

**Type:** service · **Default:** enabled

Backend service backing the System page's backup functionality: create and restore
`tar.gz` backups of the data store. No dedicated frontend chunk — the System page's
backup controls are what the plugin gates.

Creation is **asynchronous and crash-safe**:

- `POST /api/system/backup` first checks free space (`CheckBackupSpace`) — the
  estimated archive size is the current data-directory size (a `.tar.gz` is at most
  about that, usually less), and creation is refused with `507` + a human-readable
  message if it wouldn't fit. It then returns `202` and builds in a background
  goroutine, because a multi-GB archive takes far longer than a request should stay
  open.
- The archive is written to `<name>.tar.gz.partial` and renamed to `<name>.tar.gz`
  only once complete, so a half-written archive never appears in the list, gets
  downloaded, or reports a growing size as if finished. `ListBackups` surfaces the
  `.partial` as an `in_progress` entry (with live size) at the top of the list, so
  the running backup is visible and survives page reloads; the UI polls until it
  flips to done. Only one backup runs at a time (`ErrBackupInProgress` / `409`), and
  stale partials from an interrupted run are cleared at startup and before each new
  backup.

Backups store a **consistent** snapshot of the SQLite database: rather than copying
the live WAL-mode `point.db` byte-for-byte (which can capture a torn database), the
archive tars a `VACUUM INTO` snapshot in its place and omits the `-wal`/`-shm`
sidecars.

Each archive gets a **SHA-256 checksum** computed in the same write pass and stored
as a `<archive>.sha256` sidecar (`sha256sum` format). It surfaces in the backups
list, is advertised on download via the `X-Archive-SHA256` response header, and is
recomputed on upload. This is an **integrity** check (detects corruption/truncation),
not an authenticity one — a bare checksum proves nothing about a hostile archive;
password re-entry and tar-traversal hardening cover that.

## Move out / move in

The backups list also supports getting an archive off the box and seeding a site
from one. Both actions re-verify the account password (sent SHA-256-hashed, as at
login) and require a session cookie — API keys are rejected.

- **Move out (download)** — a two-step flow so multi-GB archives stream from disk
  with HTTP range/resume and are never buffered in memory:
  1. `POST /api/system/backups/:filename/authorize-download` (`current_name` =
     hashed password) → a short-lived (5 min), single-use token.
  2. `GET /api/system/backups/:filename/download?token=…` → serves the archive as
     an attachment via `http.ServeContent`.
- **Move in (upload)** — `POST /api/system/backups/upload` streams a local
  `.tar.gz` as the raw request body (password in the `X-Confirm-Password` header)
  to a temp file, hashing it in the same pass, then extracts it over the data
  directory, **overwriting everything, including the login password**. This route
  is excluded from the global request body-size limit. The server must be restarted
  afterward (the live SQLite handle still points at the pre-restore file) and the
  operator is logged out. The UI gates this behind a danger confirmation before the
  password prompt.

  Before any destructive write, the upload is verified: if the client sends the
  expected checksum in `X-Archive-SHA256`, a mismatch is rejected (`400`);
  otherwise the archive is read end-to-end (`ValidateArchive`) to catch truncation
  and confirm it actually contains the database, so a corrupt or stray tarball
  can't half-overwrite live data. The computed `sha256` is returned in the response.
