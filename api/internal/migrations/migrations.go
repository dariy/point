// Package migrations applies the database schema and data migrations Point
// needs on every startup. Ordering is significant and explicit: the schema
// list runs first (each ALTER/CREATE guarded by IF NOT EXISTS or the
// migration_history table via repository.ApplyMigration), then the multi-step
// system-tag migrations run in sequence. Every step is idempotent, so Run is
// safe to call on each boot.
//
// Run and Pending share one ordered list, steps(), so the set of migrations a
// build declares and the set it reports as outstanding can never drift. Run
// then ends with one thing steps() does not declare — a statistics refresh,
// which is maintenance and deliberately not one-shot.
package migrations

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"point-api/internal/repository"
)

// schema is the ordered list of one-shot SQL migrations. Append new entries at
// the end with a unique name — ApplyMigration records applied names in
// migration_history and skips ones already run.
var schema = []struct{ name, sql string }{
	{
		"add_tags_include_in_breadcrumbs",
		`ALTER TABLE tags ADD COLUMN include_in_breadcrumbs BOOLEAN NOT NULL DEFAULT 1`,
	},
	{
		"add_tags_sort_order",
		`ALTER TABLE tags ADD COLUMN sort_order INTEGER`,
	},
	{
		"add_media_is_public",
		`ALTER TABLE media ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0`,
	},
	{
		"add_media_metadata",
		`ALTER TABLE media ADD COLUMN metadata TEXT`,
	},
	{
		"add_media_original_metadata",
		`ALTER TABLE media ADD COLUMN original_metadata TEXT`,
	},
	{
		"create_media_visibility_log",
		`CREATE TABLE IF NOT EXISTS media_visibility_log (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
				is_public  INTEGER NOT NULL,
				changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				post_id    INTEGER REFERENCES posts(id) ON DELETE SET NULL
			)`,
	},
	{
		"create_media_visibility_log_index",
		`CREATE INDEX IF NOT EXISTS idx_media_visibility_log_media_id ON media_visibility_log(media_id)`,
	},
	{
		"create_tag_locations_table",
		`CREATE TABLE IF NOT EXISTS tag_locations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tag_id INTEGER NOT NULL UNIQUE REFERENCES tags(id) ON DELETE CASCADE,
				latitude FLOAT NOT NULL,
				longitude FLOAT NOT NULL
			)`,
	},
	{
		"create_tag_locations_index",
		`CREATE INDEX IF NOT EXISTS idx_tag_locations_tag_id ON tag_locations(tag_id)`,
	},
	{
		"normalize_post_status_case",
		`UPDATE posts SET status = LOWER(status) WHERE status != LOWER(status)`,
	},
	{
		"add_tags_show_in_ancestors",
		`ALTER TABLE tags ADD COLUMN show_in_ancestors INTEGER NOT NULL DEFAULT 1`,
	},
	{
		"drop_tags_show_in_ancestors",
		`ALTER TABLE tags DROP COLUMN show_in_ancestors`,
	},
	{
		"seed_no_ancestors_system_tag",
		`INSERT OR IGNORE INTO tags (name, slug, sort_order, post_count, created_at)
			 VALUES ('_no_ancestors', '_no_ancestors', NULL, 0, CURRENT_TIMESTAMP)`,
	},
	{
		"link_no_ancestors_to_system",
		`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			 SELECT s.id, c.id FROM tags s, tags c
			 WHERE s.slug = '_system' AND c.slug = '_no_ancestors'`,
	},
	{
		"add_scheduled_at_to_posts",
		`ALTER TABLE posts ADD COLUMN scheduled_at DATETIME`,
	},
	{
		"add_scheduled_at_to_posts_index",
		`CREATE INDEX IF NOT EXISTS idx_posts_scheduled_at ON posts(scheduled_at)`,
	},
	{
		"create_blog_secrets_table",
		`CREATE TABLE IF NOT EXISTS blog_secrets (
				key        VARCHAR(100) PRIMARY KEY,
				value      TEXT,
				updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
	},
	{
		"migrate_gemini_key_to_secrets",
		`INSERT OR IGNORE INTO blog_secrets (key, value, updated_at)
			 SELECT 'gemini_api_key', value, updated_at FROM blog_settings WHERE key = 'GEMINI_API_KEY'`,
	},
	{
		"migrate_secret_key_to_secrets",
		`INSERT OR IGNORE INTO blog_secrets (key, value, updated_at)
			 SELECT key, value, updated_at FROM blog_settings WHERE key = '_secret_key'`,
	},
	{
		"migrate_photo_library_path_to_secrets",
		`INSERT OR IGNORE INTO blog_secrets (key, value, updated_at)
			 SELECT 'photo_library_path', value, updated_at FROM blog_settings WHERE key = 'media_import_path'`,
	},
	{
		"cleanup_settings_secrets_keys",
		`DELETE FROM blog_settings WHERE key IN ('GEMINI_API_KEY', '_secret_key', 'media_import_path', 'genai_api_endpoint')`,
	},
	{
		"rename_show_map_to_map_mode",
		`INSERT OR IGNORE INTO blog_settings (key, value, value_type, updated_at)
			 SELECT 'map_mode', value, value_type, updated_at FROM blog_settings WHERE key = 'show_map'`,
	},
	{
		"cleanup_show_map_key",
		`DELETE FROM blog_settings WHERE key = 'show_map'`,
	},
	{
		"add_in_timeline_system_tag",
		`INSERT OR IGNORE INTO tags (name, slug, sort_order, post_count, created_at)
			 VALUES ('in_timeline', '_in_timeline', NULL, 0, CURRENT_TIMESTAMP)`,
	},
	{
		"add_in_timeline_to_system",
		`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			 SELECT s.id, c.id FROM tags s, tags c
			 WHERE s.slug = '_system' AND c.slug = '_in_timeline'`,
	},
	{
		"add_timeline_mode_setting",
		`INSERT OR IGNORE INTO blog_settings (key, value, value_type, updated_at)
			 VALUES ('timeline_mode', 'off', 'string', CURRENT_TIMESTAMP)`,
	},
	{
		"link_year_tags_to_in_timeline",
		`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			 SELECT p.id, t.id FROM tags p, tags t
			 WHERE p.slug = '_in_timeline'
			   AND (t.slug GLOB '[0-9][0-9][0-9][0-9]' OR t.slug GLOB '[0-9][0-9][0-9][0-9]s')`,
	},
	{
		"add_deleted_at_to_posts",
		`ALTER TABLE posts ADD COLUMN deleted_at DATETIME`,
	},
	{
		"add_deleted_at_to_posts_index",
		`CREATE INDEX IF NOT EXISTS idx_posts_deleted_at ON posts(deleted_at)`,
	},
	{
		"add_posts_type_column",
		`ALTER TABLE posts ADD COLUMN type TEXT NOT NULL DEFAULT 'post'`,
	},
	{
		"migrate_post_type_audio_from_tags",
		`UPDATE posts SET type = 'audio' WHERE id IN (SELECT post_id FROM post_tags WHERE tag_id IN (SELECT id FROM tags WHERE slug = '_type_audio'))`,
	},
	{
		"migrate_post_type_page_from_tags",
		`UPDATE posts SET type = 'page' WHERE id IN (SELECT post_id FROM post_tags WHERE tag_id IN (SELECT id FROM tags WHERE slug = '_type_page'))`,
	},
	{
		"migrate_post_type_from_status_page",
		`UPDATE posts SET type = 'page', status = 'published' WHERE status = 'page'`,
	},
	{
		"create_webauthn_credentials_table",
		`CREATE TABLE IF NOT EXISTS webauthn_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				credential_id BLOB NOT NULL UNIQUE,
				public_key BLOB NOT NULL,
				aaguid BLOB NOT NULL,
				sign_count INTEGER NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				last_used_at DATETIME
			)`,
	},
	{
		"create_webauthn_credentials_user_id_index",
		`CREATE INDEX IF NOT EXISTS idx_webauthn_user_id ON webauthn_credentials(user_id)`,
	},
	{
		"add_webauthn_backup_eligible_column",
		`ALTER TABLE webauthn_credentials ADD COLUMN backup_eligible INTEGER NOT NULL DEFAULT 0`,
	},
	{
		"add_webauthn_backup_state_column",
		`ALTER TABLE webauthn_credentials ADD COLUMN backup_state INTEGER NOT NULL DEFAULT 0`,
	},
	{
		"add_tags_module_setting",
		`INSERT OR IGNORE INTO blog_settings (key, value, value_type, updated_at)
			 VALUES ('tags_module', 'atlas', 'string', CURRENT_TIMESTAMP)`,
	},
	{
		"add_tags_visibility_setting",
		`INSERT OR IGNORE INTO blog_settings (key, value, value_type, updated_at)
			 VALUES ('tags_visibility', 'hidden', 'string', CURRENT_TIMESTAMP)`,
	},
	{
		// Reconcile the deprecated `tags_module` selector into the exclusive
		// tags-viz plugin toggles (point-lk2h): the enabled plugin now IS the
		// selected viz. One statement per plugin so at most one ends up true.
		"reconcile_tags_module_atlas",
		`INSERT OR REPLACE INTO blog_settings (key, value, value_type, updated_at)
			 SELECT 'plugin.tags-atlas.enabled',
			        CASE WHEN value = 'atlas' THEN 'true' ELSE 'false' END,
			        'string', CURRENT_TIMESTAMP
			   FROM blog_settings WHERE key = 'tags_module'`,
	},
	{
		"reconcile_tags_module_map",
		`INSERT OR REPLACE INTO blog_settings (key, value, value_type, updated_at)
			 SELECT 'plugin.tags-map.enabled',
			        CASE WHEN value = 'map' THEN 'true' ELSE 'false' END,
			        'string', CURRENT_TIMESTAMP
			   FROM blog_settings WHERE key = 'tags_module'`,
	},
	{
		"reconcile_tags_module_graph",
		`INSERT OR REPLACE INTO blog_settings (key, value, value_type, updated_at)
			 SELECT 'plugin.tags-graph.enabled',
			        CASE WHEN value IN ('graph', 'cloud') THEN 'true' ELSE 'false' END,
			        'string', CURRENT_TIMESTAMP
			   FROM blog_settings WHERE key = 'tags_module'`,
	},
	{
		// post_tags PRIMARY KEY (post_id, tag_id) only indexes the leading
		// column; lookups/joins by tag_id (hot-tag listings, counts) scanned
		// the PK without this. tag_relationships similarly lacks a child_id
		// index for child→parent (ancestor) traversal.
		"create_post_tags_tag_id_index",
		`CREATE INDEX IF NOT EXISTS idx_post_tags_tag_id ON post_tags(tag_id)`,
	},
	{
		"create_tag_relationships_child_id_index",
		`CREATE INDEX IF NOT EXISTS idx_tag_relationships_child_id ON tag_relationships(child_id)`,
	},
	{
		// Every media byte-serve looks a row up by original_path
		// (GetMediaByPath), which was a full table scan.
		"create_media_original_path_index",
		`CREATE INDEX IF NOT EXISTS idx_media_original_path ON media(original_path)`,
	},
	{
		// Retired settings. None of these was ever read: session TTL is
		// SESSION_EXPIRY_HOURS, there is no cleanup job, no registration flow
		// and no way to create a second user, and use_thumbnails only ever
		// hid post-card images. storage_quota_mb moved to STORAGE_QUOTA_MB —
		// a hosted install's quota belongs to the plan, not to the blog admin.
		"drop_unused_blog_settings",
		`DELETE FROM blog_settings WHERE key IN (
				'session_ttl_days',
				'cleanup_interval_days',
				'multi_user_mode',
				'require_registration_code',
				'use_thumbnails',
				'storage_quota_mb'
			)`,
	},
	{
		// The post-viewer slot takes exactly one plugin (plugins.SlotCardinality),
		// which the toggle endpoint enforces from here on. Installs configured
		// while both viewers could be on at once are reconciled to the standard
		// viewer — the one the frontend already mounted when both were enabled
		// (single-claim slots resolve in registry order), so nothing visibly
		// changes for those blogs.
		"reconcile_post_viewer_single_claim",
		`UPDATE blog_settings SET value = 'false', updated_at = CURRENT_TIMESTAMP
			 WHERE key = 'plugin.immersive-sheet.enabled' AND value = 'true'
			   AND EXISTS (SELECT 1 FROM blog_settings
			                WHERE key = 'plugin.immersive.enabled' AND value = 'true')`,
	},
	{
		// ...and the same slot may not be left empty, which used to render an
		// immersive post as a blank page. Only touches installs whose viewer
		// settings were already seeded, so a fresh database still gets its
		// defaults from the registry at setup time.
		"reconcile_post_viewer_requires_one",
		`INSERT OR REPLACE INTO blog_settings (key, value, value_type, updated_at)
			 SELECT 'plugin.immersive.enabled', 'true', 'string', CURRENT_TIMESTAMP
			  WHERE EXISTS (SELECT 1 FROM blog_settings
			                 WHERE key IN ('plugin.immersive.enabled', 'plugin.immersive-sheet.enabled'))
			    AND NOT EXISTS (SELECT 1 FROM blog_settings
			                     WHERE key IN ('plugin.immersive.enabled', 'plugin.immersive-sheet.enabled')
			                       AND value = 'true')`,
	},
	{
		// Thumbnails are a fixed ladder of longest-side widths now, so there is
		// no dimension left for an operator to configure: nothing has read
		// these two keys since the ladder landed. jpeg_quality is still live
		// and stays.
		"drop_unused_thumbnail_dimension_settings",
		`DELETE FROM blog_settings WHERE key IN (
				'thumbnail_width',
				'thumbnail_height'
			)`,
	},
	{
		// Widen the tag_id index to cover post_id. Every list query reads
		// post_tags by tag_id and wants only post_id back — the tag filter,
		// and the hides_posts exclusion that runs on every public page — so
		// the narrow index cost one table lookup per matching row.
		//
		// Measured over the three index changes below together, at 20k posts /
		// 82k post_tags with a hides_posts tag on a tenth of them: a tag page
		// 2.97ms -> 2.33ms, and the feed 28.8ms -> 2.06ms. The feed's order of
		// magnitude is the deleted_at index two entries down, not this one.
		"create_post_tags_tag_id_post_id_index",
		`CREATE INDEX IF NOT EXISTS idx_post_tags_tag_id_post_id ON post_tags(tag_id, post_id)`,
	},
	{
		// ...which makes the narrow one dead weight: same leading column, so it
		// serves nothing the composite does not, and every post_tags write pays
		// for it. Ordered after the CREATE above so no boot is left with
		// neither.
		"drop_post_tags_tag_id_index",
		`DROP INDEX IF EXISTS idx_post_tags_tag_id`,
	},
	{
		// The feed's ORDER BY had no index behind it, so every page built a
		// temp B-tree. Partial on deleted_at because that is the filter the
		// feed always carries, and all three sort columns because whatever the
		// ORDER BY names and the index does not is a temp B-tree again — id
		// included, spelled out DESC, since the rowid an index carries
		// implicitly is ascending.
		"create_posts_live_index",
		`CREATE INDEX IF NOT EXISTS idx_posts_live ON posts(published_at DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL`,
	},
	{
		// ...which the planner will not use while a whole-column index on
		// deleted_at exists. deleted_at is NULL for all but a handful of rows,
		// so `deleted_at IS NULL` looks to SQLite like a seek it can satisfy —
		// and it takes it, reading nearly every post through that index and
		// then sorting the feed in a temp B-tree. Only the trash view wants
		// deleted_at, and only the rows that have one, so the replacement is
		// partial: too small to tempt the planner into it for the feed, and
		// still the index ListTrashedPosts sorts on.
		"create_posts_trashed_index",
		`CREATE INDEX IF NOT EXISTS idx_posts_trashed ON posts(deleted_at DESC) WHERE deleted_at IS NOT NULL`,
	},
	{
		"drop_posts_deleted_at_index",
		`DROP INDEX IF EXISTS idx_posts_deleted_at`,
	},
	{
		// Search was five leading-wildcard LIKEs over title, slug, content and
		// tag names — unindexable by construction, so every post body came off
		// disk per keystroke of the admin search box. FTS5 makes it a lookup.
		//
		// External content (content='posts') means the virtual table holds the
		// inverted index and nothing else: posts stays the one copy of the
		// text. What SQLite does not then do is keep the two in step, which is
		// what the three triggers below are for. Same statements as in
		// sql/schema.sql, which is where a fresh database gets them; these are
		// for the databases that already exist.
		"create_posts_fts",
		`CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
				title, slug, content,
				content='posts',
				content_rowid='id',
				tokenize='unicode61'
			)`,
	},
	{
		"create_posts_fts_insert_trigger",
		`CREATE TRIGGER IF NOT EXISTS posts_fts_insert AFTER INSERT ON posts BEGIN
				INSERT INTO posts_fts(rowid, title, slug, content)
				VALUES (new.id, new.title, new.slug, new.content);
			END`,
	},
	{
		"create_posts_fts_delete_trigger",
		`CREATE TRIGGER IF NOT EXISTS posts_fts_delete AFTER DELETE ON posts BEGIN
				INSERT INTO posts_fts(posts_fts, rowid, title, slug, content)
				VALUES ('delete', old.id, old.title, old.slug, old.content);
			END`,
	},
	{
		// OF title, slug, content — an unqualified UPDATE trigger would
		// reindex a whole post body every time a view counter ticked.
		"create_posts_fts_update_trigger",
		`CREATE TRIGGER IF NOT EXISTS posts_fts_update AFTER UPDATE OF title, slug, content ON posts BEGIN
				INSERT INTO posts_fts(posts_fts, rowid, title, slug, content)
				VALUES ('delete', old.id, old.title, old.slug, old.content);
				INSERT INTO posts_fts(rowid, title, slug, content)
				VALUES (new.id, new.title, new.slug, new.content);
			END`,
	},
	{
		// The triggers only see writes made after they exist, so the index
		// starts empty and every post already in the database is invisible to
		// search until it is filled. 'rebuild' reads the content table and
		// builds the whole index from it — the one-time backfill, and the
		// repair if the two ever drift.
		"backfill_posts_fts",
		`INSERT INTO posts_fts(posts_fts) VALUES ('rebuild')`,
	},
}

// step is one named unit of migration work. Every step gates on its own name in
// migration_history and records that name once it succeeds, which is what makes
// both Run and Pending exact: a name already in the table means the step is a
// no-op, so an empty pending set means Run has nothing to do at all.
type step struct {
	name string
	run  func(ctx context.Context, repo repository.Repository) error
}

// steps returns every migration this build declares, in the order they must be
// applied. The order is historical, not arbitrary — the tag steps below assume
// the schema list has already run, and the two renames assume the system tags
// they rewrite exist. Appending is safe; reordering is not.
func steps() []step {
	out := make([]step, 0, len(schema)+6)

	for _, m := range schema {
		out = append(out, step{m.name, func(ctx context.Context, repo repository.Repository) error {
			return repo.ApplyMigration(ctx, m.name, m.sql)
		}})
	}

	return append(out,
		// Phase A: seed system tags and migrate old boolean flag data into tag_relationships.
		step{"system_tags_phase_a", func(ctx context.Context, repo repository.Repository) error {
			return repo.MigrateFlagsToSystemTags(ctx)
		}},
		// Phase B: rebuild tags table to drop the now-migrated boolean columns.
		step{"system_tags_phase_b", func(ctx context.Context, repo repository.Repository) error {
			return repo.RebuildTagsTableDropBooleans(ctx)
		}},
		// Ensure all required system tags exist.
		step{"ensure_system_tags", func(ctx context.Context, repo repository.Repository) error {
			return repo.EnsureSystemTags(ctx)
		}},
		// Rename all system tags so that name == slug (e.g. "_root", "_pending").
		// This was the first pass — kept so the migration_history entry is preserved.
		step{"rename_system_tags_to_slug", func(ctx context.Context, repo repository.Repository) error {
			return repo.ApplyMigration(ctx, "rename_system_tags_to_slug",
				`UPDATE tags SET name = slug WHERE slug LIKE '\_%%' ESCAPE '\'`)
		}},
		// Strip the leading '_' from system tag display names so the UI shows
		// "root", "pending", "hidden", etc. instead of "_root", "_pending".
		step{"rename_system_tags_names_no_underscore", func(ctx context.Context, repo repository.Repository) error {
			return repo.ApplyMigration(ctx, "rename_system_tags_names_no_underscore",
				`UPDATE tags SET name = LTRIM(slug, '_') WHERE slug LIKE '\_%%' ESCAPE '\'`)
		}},
		// Migrate tag system: translate system-tag graph edges to typed columns, fold
		// tag_locations into tags, drop old columns, delete system tags.
		step{"tag_flags_from_system_tags", func(ctx context.Context, repo repository.Repository) error {
			return repo.MigrateTagFlagsFromSystemTags(ctx)
		}},
	)
}

// Pending returns the names of the steps not yet recorded in migration_history,
// in declared order. It is what lets the caller decide whether this boot has any
// schema work to do — and therefore whether the database is worth snapshotting
// before that work starts (see cmd/api/migrations_guard.go).
//
// GetMigrations already reports an empty list for a database with no
// migration_history table, so a fresh or very old database reports every step.
func Pending(ctx context.Context, repo repository.Repository) ([]string, error) {
	records, err := repo.GetMigrations(ctx)
	if err != nil {
		return nil, fmt.Errorf("read migration history: %w", err)
	}
	applied := make(map[string]struct{}, len(records))
	for _, r := range records {
		applied[r.Name] = struct{}{}
	}

	var pending []string
	for _, s := range steps() {
		if _, ok := applied[s.name]; !ok {
			pending = append(pending, s.name)
		}
	}
	return pending, nil
}

// Run applies all pending schema migrations, then the special multi-step tag
// migrations, in order.
//
// A returned error is fatal to the caller by design: it means the database is
// not at the schema this build expects, and a server that boots anyway will
// fail later, further from the cause, with whatever the mismatched schema
// happens to break. ApplyMigration already treats "already exists" and
// "duplicate column" as no-ops, so an error here is never merely a
// re-application of something idempotent.
//
// Every step is attempted even after one fails, so the logs name every problem
// rather than only the first; the errors are then joined and returned together.
// That is also why the caller restores a snapshot rather than rolling back: by
// the time Run returns, several steps may have written.
//
// A clean pass ends by refreshing the query planner's statistics — see
// refreshQueryPlannerStats, which is maintenance rather than a migration.
func Run(ctx context.Context, repo repository.Repository) error {
	var errs []error
	for _, s := range steps() {
		if err := s.run(ctx, repo); err != nil {
			slog.Error("migration failed", "name", s.name, "error", err)
			errs = append(errs, fmt.Errorf("%s: %w", s.name, err))
		}
	}
	if len(errs) > 0 {
		// The caller is about to restore a snapshot over this database; there
		// is no point analysing the copy that loses.
		return errors.Join(errs...)
	}
	if err := refreshQueryPlannerStats(ctx, repo); err != nil {
		// Stale statistics cost speed, not correctness, and Run's error is
		// fatal to the boot — so this one is reported and not returned.
		slog.Warn("could not refresh query planner statistics", "error", err)
	}
	return nil
}

// refreshQueryPlannerStats brings sqlite_stat1 up to date so the planner has
// something better than its default guesses to choose the indexes above with.
// It is maintenance rather than migration — the only thing in Run that steps()
// does not declare — because it is not a one-shot: statistics go stale as a
// blog grows, so it has to be free to run on every boot.
//
// PRAGMA optimize is the conditional form of ANALYZE, and each half of that
// matters here. It does nothing on the empty database a fresh install migrates,
// where a bare ANALYZE would record "no rows" and leave the planner believing
// that for the life of the install; and it does run the first time it meets a
// database that has content or an index it has not seen, which is what makes
// the indexes above take effect without an operator step. analysis_limit bounds
// how much of each index it reads, so a large blog does not pay an unbounded
// scan at boot. Both are per-connection settings, hence the single connection.
func refreshQueryPlannerStats(ctx context.Context, repo repository.Repository) error {
	conn, err := repo.DB().Conn(ctx)
	if err != nil {
		return fmt.Errorf("open connection: %w", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.ExecContext(ctx, `PRAGMA analysis_limit = 400`); err != nil {
		return fmt.Errorf("set analysis_limit: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `PRAGMA optimize`); err != nil {
		return fmt.Errorf("optimize: %w", err)
	}
	return nil
}
