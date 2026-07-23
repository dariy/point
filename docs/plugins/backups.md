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

The backups list also supports getting an archive off the box and bringing one in.
Uploading and restoring are **decoupled**: an upload only *stages* the archive in
the backups folder; nothing is applied until the operator explicitly Restores it.

- **Move out (download)** — re-verifies the account password (sent SHA-256-hashed,
  as at login), requires a session cookie (API keys rejected), and streams from
  disk so multi-GB archives use HTTP range/resume and are never buffered in memory:
  1. `POST /api/system/backups/:filename/authorize-download` (`current_name` =
     hashed password) → a short-lived (5 min), single-use token.
  2. `GET /api/system/backups/:filename/download?token=…` → serves the archive as
     an attachment via `http.ServeContent` (with the `X-Archive-SHA256` header).
- **Move in (upload → then restore)**:
  - `POST /api/system/backups/upload` streams a local `.tar.gz` as the raw request
    body into the backups folder — the same staging (`.partial` → rename) and
    checksum sidecar as a locally created backup, so a half-uploaded or invalid file
    never appears as a usable backup. It is **not applied**: the uploaded archive
    simply joins the list. The route requires a session cookie and is excluded from
    the global request body-size limit so multi-GB archives fit. Verification runs
    before publishing — an optional `X-Archive-SHA256` is compared, otherwise the
    archive is read end-to-end (`ValidateArchive`) to catch truncation and confirm
    it contains the database. The computed `sha256` is returned.
  - **Restore** (`POST /api/system/backups/:filename/restore`) is the destructive
    apply step for *any* backup, uploaded or created: it extracts the archive over
    the data directory, **overwriting everything, including the login password**.

    Restoring is **deferred to the next startup**: the endpoint validates the
    archive (`ScheduleRestore`) and writes a `backups/pending_restore` marker, but
    does not extract anything while the server is live. On boot, before the
    database is opened, `ApplyPendingRestore` extracts the archive and deletes the
    DB's `-wal`/`-shm` sidecars. This is essential — extracting a backup over the
    SQLite file while the server holds it open, and leaving a stale WAL for SQLite
    to replay against the restored snapshot, corrupts the database (*"disk image is
    malformed"*). The UI gates the action behind a danger confirmation and tells the
    operator to restart the server to apply it.
