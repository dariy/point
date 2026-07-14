// Package migrations applies the database schema and data migrations Point
// needs on every startup. Ordering is significant and explicit: the schema
// list runs first (each ALTER/CREATE guarded by IF NOT EXISTS or the
// migration_history table via repository.ApplyMigration), then the multi-step
// system-tag migrations run in sequence. Every step is idempotent, so Run is
// safe to call on each boot.
package migrations

import (
	"context"
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
}

// Run applies all pending schema migrations, then the special multi-step tag
// migrations, in order. Failures are logged (not fatal): a failed idempotent
// migration must not stop the server from booting.
func Run(ctx context.Context, repo repository.Repository) {
	for _, m := range schema {
		if err := repo.ApplyMigration(ctx, m.name, m.sql); err != nil {
			slog.Warn("migration failed", "name", m.name, "error", err)
		}
	}

	// Phase A: seed system tags and migrate old boolean flag data into tag_relationships.
	if err := repo.MigrateFlagsToSystemTags(ctx); err != nil {
		slog.Warn("system_tags_phase_a failed", "error", err)
	}
	// Phase B: rebuild tags table to drop the now-migrated boolean columns.
	if err := repo.RebuildTagsTableDropBooleans(ctx); err != nil {
		slog.Warn("system_tags_phase_b failed", "error", err)
	}

	// Ensure all required system tags exist.
	if err := repo.EnsureSystemTags(ctx); err != nil {
		slog.Warn("ensure_system_tags failed", "error", err)
	}

	// Rename all system tags so that name == slug (e.g. "_root", "_pending").
	// This was the first pass — kept so the migration_history entry is preserved.
	if err := repo.ApplyMigration(ctx, "rename_system_tags_to_slug",
		`UPDATE tags SET name = slug WHERE slug LIKE '\_%%' ESCAPE '\'`); err != nil {
		slog.Warn("migration failed", "name", "rename_system_tags_to_slug", "error", err)
	}

	// Strip the leading '_' from system tag display names so the UI shows
	// "root", "pending", "hidden", etc. instead of "_root", "_pending".
	if err := repo.ApplyMigration(ctx, "rename_system_tags_names_no_underscore",
		`UPDATE tags SET name = LTRIM(slug, '_') WHERE slug LIKE '\_%%' ESCAPE '\'`); err != nil {
		slog.Warn("migration failed", "name", "rename_system_tags_names_no_underscore", "error", err)
	}

	// Migrate tag system: translate system-tag graph edges to typed columns, fold
	// tag_locations into tags, drop old columns, delete system tags.
	if err := repo.MigrateTagFlagsFromSystemTags(ctx); err != nil {
		slog.Warn("tag_flags_from_system_tags failed", "error", err)
	}
}
