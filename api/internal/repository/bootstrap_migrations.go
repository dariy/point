package repository

// Bootstrap migrations run inside NewRepository, before any query is served.
//
// They are separate from internal/migrations for one structural reason: that
// package imports this one, so it cannot run during repository construction.
// Anything a query in this package needs in order to compile-and-run against an
// older database has to be applied here; everything else belongs in
// internal/migrations, which is the list to append to by default.
//
// Both lists are keyed by name and idempotent, and a failure in either is fatal
// — see migrations.Run for why booting against an unexpected schema is worse
// than not booting.
//
// KEEP BOTH LISTS ADDITIVE. Everything here runs before the boot can snapshot
// the database (the snapshot needs an open repository, and this is what opens
// it), so a failure in this file has no automatic way back. That is acceptable
// only because every statement here is individually atomic: ADD COLUMN, CREATE
// TABLE/INDEX IF NOT EXISTS, a per-row UPDATE. Nothing here may drop or rebuild
// a table, and nothing here may need several statements to leave the schema
// consistent — that work belongs in internal/migrations, which runs after the
// snapshot exists and is rolled back to it on failure. bootstrapColumns in
// particular are not recorded in migration_history at all, so the boot cannot
// even tell whether they are outstanding.

// bootstrapColumns are ALTER TABLE ... ADD COLUMN statements applied directly,
// before the models.Queries wrapper exists. SQLite has no ADD COLUMN IF NOT
// EXISTS, so re-running one on a database that already has the column returns a
// "duplicate column name" error that the caller treats as a no-op — which is
// why these cannot go through ApplyMigration's history table alone.
var bootstrapColumns = []struct{ name, sql string }{
	{"add posts.css", `ALTER TABLE posts ADD COLUMN css TEXT NOT NULL DEFAULT ''`},
	{"add posts.immersive_mode", `ALTER TABLE posts ADD COLUMN immersive_mode TEXT NOT NULL DEFAULT 'auto'`},
	// Instagram cross-posting columns (point-xq28).
	{"add posts.instagram_share", `ALTER TABLE posts ADD COLUMN instagram_share BOOLEAN NOT NULL DEFAULT 0`},
	{"add posts.instagram_status", `ALTER TABLE posts ADD COLUMN instagram_status TEXT NOT NULL DEFAULT 'none'`},
	{"add posts.instagram_media_id", `ALTER TABLE posts ADD COLUMN instagram_media_id TEXT`},
	{"add posts.instagram_published_at", `ALTER TABLE posts ADD COLUMN instagram_published_at DATETIME`},
	{"add posts.instagram_error", `ALTER TABLE posts ADD COLUMN instagram_error TEXT`},
	{"add posts.instagram_id", `ALTER TABLE posts ADD COLUMN instagram_id TEXT`},
}

// bootstrapMigrations go through ApplyMigration, so each runs once and is
// recorded in migration_history — the same mechanism internal/migrations uses.
var bootstrapMigrations = []struct{ name, sql string }{
	{"add_api_keys", `
CREATE TABLE IF NOT EXISTS api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        VARCHAR(100) NOT NULL,
    key_hash    VARCHAR(64) NOT NULL UNIQUE,
    prefix      VARCHAR(16) NOT NULL,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at DATETIME,
    expires_at  DATETIME,
    revoked_at  DATETIME
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
`},
	{"posts_instagram_id_unique_idx",
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_instagram_id ON posts(instagram_id) WHERE instagram_id IS NOT NULL`},
	// Denormalized list-preview URL so list/grid queries no longer read the
	// full content body. BackfillPostMediaURLs fills existing rows in.
	{"posts_media_url", `ALTER TABLE posts ADD COLUMN media_url VARCHAR(500)`},
}
