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
    malformed"*).

    The restart that applies it can be done from the UI: `POST /api/system/restart`
    (session-only) flags a restart and triggers the normal graceful shutdown, after
    which `main` **re-execs the binary in place** (`syscall.Exec` — same PID and
    container, a fresh program that runs `ApplyPendingRestore` before opening the
    DB). No external supervisor is required, so it also works under bare
    `scripts/run.sh`. The UI offers "Restart now" right after scheduling a restore,
    plus a standalone "Restart server" button.

## Pre-migration snapshots

Separate from this plugin, and deliberately not gated by it: schema migrations
are protected by their own snapshot, so a failed upgrade never has to be
recovered from a backup the operator may not have enabled.

Migrations are fail-forward and run outside a transaction — several of them
rebuild a table by copying it and dropping the original — so a failure part way
through leaves a database that is neither the old schema nor the new one. SQLite
offers no rollback for that, so the boot takes a copy first:

- Before applying anything, `runMigrationsGuarded` asks `migrations.Pending`
  what is outstanding. Every migration records its own name in
  `migration_history`, so an empty answer means there is genuinely nothing to
  do and **no snapshot is taken** — an ordinary restart costs nothing.
- Otherwise `SnapshotForMigrations` writes a `VACUUM INTO` copy to
  `<data>/backups/migrations/premigration_<ts>.db`. If it can't (no disk space,
  read-only data dir) the server **refuses to start** rather than migrate
  unprotected. `MIGRATION_BACKUP=false` overrides that; `MIGRATION_BACKUP_KEEP`
  (default 3) sets retention.
- If the migrations then fail, the server closes the database, hard-links the
  broken one aside as `failed_<ts>.db` with a `failed_<ts>.txt` naming the
  failed steps, swaps the snapshot back in, and exits non-zero. It **never
  retries** — the same migration would fail the same way. Rolling back to the
  previous image is a complete recovery, because the database is exactly as it
  was before the upgrade.

The swap is ordered so the database file is never absent (an absent `point.db`
makes the next boot initialize an empty one from `schema.sql`): the snapshot is
copied to `point.db.restoring`, fsynced, the `-wal`/`-shm` sidecars of the
broken database are deleted, and only then is the staging file renamed over
`point.db`. A `restore_pending` marker is written before that sequence and
cleared after it, so a crash in the middle is finished by
`ApplyPendingMigrationRestore` on the next boot — before the database is opened,
the same rule `pending_restore` follows and for the same reason.

These files are invisible to everything above: `CreateBackup` and the free-space
estimate skip any directory named `backups`, and the backups list, rotation and
due-check skip directories and match only `*.tar.gz`.

To restore by hand — the automatic restore failed, the migration "succeeded" but
was wrong, or the container won't boot far enough to reach the UI — use
[`scripts/restore-db.sh`](../../scripts/restore-db.sh), which takes either a
`.db` snapshot or a `.tar.gz` archive.

The two paths deliberately order the swap differently, because one is attended
and the other is not:

- **The boot's restore** copies the snapshot to a staging file and renames it
  *over* `point.db`, so the path always resolves to a complete database. It has
  to: nobody is watching a container restart, and a crash with `point.db` absent
  would have the next boot build an empty one from `schema.sql`.
- **`restore-db.sh`** renames the current database aside *first*, then copies,
  then verifies (size, SQLite header, `integrity_check`), rolling back with a
  rename if any check fails. That leaves a brief window with no `point.db` —
  acceptable only because an operator is present, and bracketed by a
  `restore_in_progress` marker naming the renamed file. In exchange the
  verification can actually undo itself, and what it replaced is kept as
  `replaced_<ts>.db` so the restore is itself reversible.
