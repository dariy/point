package repository

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// MigrationRecord holds a single row from migration_history.
type MigrationRecord struct {
	ID        int64     `json:"id"`
	Name      string    `json:"name"`
	AppliedAt time.Time `json:"applied_at"`
}

func (r *sqliteRepository) GetMigrations(ctx context.Context) ([]MigrationRecord, error) {
	const q = `SELECT id, name, applied_at FROM migration_history ORDER BY applied_at DESC`
	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		// Table may not exist in older databases — return empty list rather than error.
		return []MigrationRecord{}, nil
	}
	defer func() {
		_ = rows.Close()
	}()

	var items []MigrationRecord
	for rows.Next() {
		var m MigrationRecord
		if err := rows.Scan(&m.ID, &m.Name, &m.AppliedAt); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	if items == nil {
		items = []MigrationRecord{}
	}
	return items, rows.Err()
}

// ApplyMigration executes raw SQL and records it in migration_history.
// It is idempotent: if the migration name already exists it is skipped.
func (r *sqliteRepository) ApplyMigration(ctx context.Context, name, sql string) error {
	if _, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS migration_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255) NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("failed to create migration_history table: %w", err)
	}

	var count int64
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM migration_history WHERE name = ?`, name,
	).Scan(&count); err != nil {
		return fmt.Errorf("failed to check migration history for %q: %w", name, err)
	}
	if count > 0 {
		return nil
	}
	if _, err := r.db.ExecContext(ctx, sql); err != nil {
		errMsg := strings.ToLower(err.Error())
		// Treat "already exists" errors as no-ops: the migration's intent is already
		// satisfied (e.g. a column added by schema.sql that a migration also adds).
		// Record it in history so we stop retrying on every startup.
		if !strings.Contains(errMsg, "already exists") &&
			!strings.Contains(errMsg, "duplicate column") &&
			!strings.Contains(errMsg, "duplicate column name") {
			return fmt.Errorf("migration %s: %w", name, err)
		}
	}
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name, applied_at) VALUES (?, CURRENT_TIMESTAMP)`, name)
	if err != nil {
		return fmt.Errorf("failed to record migration %q in history: %w", name, err)
	}
	return nil
}

// MigrateFlagsToSystemTags is an idempotent migration that seeds system tags and
// migrates the old boolean flag columns (is_featured, is_hidden, is_hidden_posts,
// include_in_breadcrumbs, show_related_tags_as_children) into tag_relationships.
// It records "system_tags_phase_a" in migration_history when complete.
func (r *sqliteRepository) MigrateFlagsToSystemTags(ctx context.Context) error {
	// Ensure migration_history table exists.
	if _, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS migration_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255) NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migration_history: %w", err)
	}

	// Check if already applied.
	var count int64
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM migration_history WHERE name = 'system_tags_phase_a'`,
	).Scan(&count); err != nil {
		return fmt.Errorf("check migration_history: %w", err)
	}
	if count > 0 {
		return nil
	}

	// Check if is_featured column still exists.
	rows, err := r.db.QueryContext(ctx, "SELECT name FROM pragma_table_info('tags') WHERE name = 'is_featured'")
	if err != nil {
		return fmt.Errorf("pragma table_info: %w", err)
	}
	columnExists := rows.Next()
	_ = rows.Close()

	if columnExists {
		// Seed system tags (old schema still has boolean columns).
		if _, err := r.db.ExecContext(ctx, `
			INSERT OR IGNORE INTO tags (name, slug, is_important, is_featured, is_hidden, is_hidden_posts, include_in_breadcrumbs, show_related_tags_as_children, sort_order, post_count, created_at) VALUES
				('_system',            '_system',            0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_root',              '_root',              0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_hidden',            '_hidden',            0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_hide_posts',        '_hide_posts',        0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_is_in_breadcrumbs', '_is_in_breadcrumbs', 0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_with_related',      '_with_related',      0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP),
				('_pending',           '_pending',           0, 0, 0, 0, 0, 0, NULL, 0, CURRENT_TIMESTAMP)
		`); err != nil {
			return fmt.Errorf("seed system tags: %w", err)
		}

		// Seed system tag relationships (all 6 are children of _system).
		if _, err := r.db.ExecContext(ctx, `
			INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			SELECT s.id, c.id FROM tags s, tags c
			WHERE s.slug = '_system' AND c.slug IN ('_root', '_hidden', '_hide_posts', '_is_in_breadcrumbs', '_with_related', '_pending')
		`); err != nil {
			return fmt.Errorf("seed system tag relationships: %w", err)
		}

		// Migrate flag data to relationships.
		flagMigrations := []struct {
			parentSlug string
			condition  string
		}{
			{"_root", "is_featured = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
			{"_hidden", "is_hidden = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
			{"_hide_posts", "is_hidden_posts = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
			{"_is_in_breadcrumbs", "include_in_breadcrumbs = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
			{"_with_related", "show_related_tags_as_children = 1 AND slug NOT LIKE '\\_%%' ESCAPE '\\'"},
		}
		for _, fm := range flagMigrations {
			q := fmt.Sprintf(`
				INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
				SELECT (SELECT id FROM tags WHERE slug = '%s'), id FROM tags WHERE %s`,
				fm.parentSlug, fm.condition)
			if _, err := r.db.ExecContext(ctx, q); err != nil {
				return fmt.Errorf("migrate flag to %s: %w", fm.parentSlug, err)
			}
		}

		// Assign _pending to orphaned non-system tags.
		if _, err := r.db.ExecContext(ctx, `
			INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			SELECT (SELECT id FROM tags WHERE slug = '_pending'), t.id
			FROM tags t
			WHERE t.slug NOT LIKE '\_%%' ESCAPE '\'
			AND NOT EXISTS (SELECT 1 FROM tag_relationships tr WHERE tr.child_id = t.id)
		`); err != nil {
			return fmt.Errorf("assign _pending to orphans: %w", err)
		}
	}

	// Record migration.
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name, applied_at) VALUES ('system_tags_phase_a', CURRENT_TIMESTAMP)`,
	); err != nil {
		return fmt.Errorf("record system_tags_phase_a: %w", err)
	}
	return nil
}

// RebuildTagsTableDropBooleans drops the 6 boolean columns from the tags table via
// a table rebuild (SQLite does not support DROP COLUMN in older versions).
// It is idempotent: it checks for "system_tags_phase_b" in migration_history first.
func (r *sqliteRepository) RebuildTagsTableDropBooleans(ctx context.Context) error {
	// Ensure migration_history table exists.
	if _, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS migration_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255) NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migration_history: %w", err)
	}

	// Check if already applied.
	var count int64
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM migration_history WHERE name = 'system_tags_phase_b'`,
	).Scan(&count); err != nil {
		return fmt.Errorf("check migration_history: %w", err)
	}
	if count > 0 {
		return nil
	}

	// Check if is_featured column still exists.
	rows, err := r.db.QueryContext(ctx, "SELECT name FROM pragma_table_info('tags') WHERE name = 'is_featured'")
	if err != nil {
		return fmt.Errorf("pragma table_info: %w", err)
	}
	columnExists := rows.Next()
	_ = rows.Close()

	if columnExists {
		stmts := []string{
			"PRAGMA foreign_keys = OFF",
			`CREATE TABLE IF NOT EXISTS tags_new (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name VARCHAR(100) NOT NULL,
				slug VARCHAR(100) NOT NULL UNIQUE,
				description TEXT,
				custom_url VARCHAR(200),
				sort_order INTEGER,
				post_count INTEGER NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
			`INSERT INTO tags_new (id, name, slug, description, custom_url, sort_order, post_count, created_at)
			SELECT id, name, slug, description, custom_url, sort_order, post_count, created_at FROM tags`,
			`DROP TABLE tags`,
			`ALTER TABLE tags_new RENAME TO tags`,
			`CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)`,
			`CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug)`,
			"PRAGMA foreign_keys = ON",
		}
		for _, stmt := range stmts {
			if _, err := r.db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("rebuild tags: %w", err)
			}
		}
	}

	// Record migration.
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name, applied_at) VALUES ('system_tags_phase_b', CURRENT_TIMESTAMP)`,
	); err != nil {
		return fmt.Errorf("record system_tags_phase_b: %w", err)
	}
	return nil
}

// MigrateTagFlagsFromSystemTags is the "tag_flags_from_system_tags" migration.
// It translates the system-tag graph model (12 _-prefixed reserved tags) into
// typed columns on the tags table, folds tag_locations into tags.latitude/longitude,
// drops sort_order/custom_url from tags, adds sort_order to tag_relationships, and
// deletes all system tags. Idempotent: skipped if already recorded in migration_history.
func (r *sqliteRepository) MigrateTagFlagsFromSystemTags(ctx context.Context) error {
	const migrationName = "tag_flags_from_system_tags"

	if _, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS migration_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255) NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migration_history: %w", err)
	}

	var count int64
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM migration_history WHERE name = ?`, migrationName,
	).Scan(&count); err != nil {
		return fmt.Errorf("check migration_history: %w", err)
	}
	if count > 0 {
		return nil
	}

	// Detect old schema: sort_order column exists on tags.
	rows, err := r.db.QueryContext(ctx, "SELECT name FROM pragma_table_info('tags') WHERE name = 'sort_order'")
	if err != nil {
		return fmt.Errorf("detect schema: %w", err)
	}
	oldSchema := rows.Next()
	_ = rows.Close()

	if oldSchema {
		// Disable FK enforcement for table rebuilds.
		if _, err := r.db.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
			return fmt.Errorf("disable foreign_keys: %w", err)
		}

		// Add new flag columns to tags (ignore duplicates from partial runs).
		newCols := []struct{ name, stmt string }{
			{"kind", `ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT 'tag'`},
			{"hidden", `ALTER TABLE tags ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`},
			{"hides_posts", `ALTER TABLE tags ADD COLUMN hides_posts INTEGER NOT NULL DEFAULT 0`},
			{"nav_order", `ALTER TABLE tags ADD COLUMN nav_order INTEGER`},
			{"in_breadcrumbs", `ALTER TABLE tags ADD COLUMN in_breadcrumbs INTEGER NOT NULL DEFAULT 0`},
			{"show_related", `ALTER TABLE tags ADD COLUMN show_related INTEGER NOT NULL DEFAULT 0`},
			{"in_ancestor_flyout", `ALTER TABLE tags ADD COLUMN in_ancestor_flyout INTEGER NOT NULL DEFAULT 1`},
			{"latitude", `ALTER TABLE tags ADD COLUMN latitude REAL`},
			{"longitude", `ALTER TABLE tags ADD COLUMN longitude REAL`},
		}
		for _, col := range newCols {
			if _, err := r.db.ExecContext(ctx, col.stmt); err != nil {
				if !strings.Contains(err.Error(), "duplicate column") {
					return fmt.Errorf("add column %s: %w", col.name, err)
				}
			}
		}

		// Copy tag_locations into tags.latitude/longitude (table may not exist in test DBs).
		var tlExists int
		_ = r.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tag_locations'`).Scan(&tlExists)
		if tlExists > 0 {
			if _, err := r.db.ExecContext(ctx, `
				UPDATE tags SET
					latitude  = (SELECT latitude  FROM tag_locations WHERE tag_id = tags.id),
					longitude = (SELECT longitude FROM tag_locations WHERE tag_id = tags.id)
				WHERE id IN (SELECT tag_id FROM tag_locations)
			`); err != nil {
				return fmt.Errorf("copy tag_locations: %w", err)
			}
		}

		// Translate system-tag edges to typed flag columns.
		// Queries are no-ops if the system tag slug doesn't exist.
		flagUpdates := []string{
			// _hidden → hidden = 1
			`UPDATE tags SET hidden = 1
			WHERE slug NOT LIKE '\_%%' ESCAPE '\'
			AND id IN (
				SELECT child_id FROM tag_relationships
				WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hidden')
			)`,
			// _page → hidden = 1
			`UPDATE tags SET hidden = 1
			WHERE slug NOT LIKE '\_%%' ESCAPE '\'
			AND id IN (
				SELECT child_id FROM tag_relationships
				WHERE parent_id = (SELECT id FROM tags WHERE slug = '_page')
			)`,
			// _hide_posts → hides_posts = 1
			`UPDATE tags SET hides_posts = 1
			WHERE slug NOT LIKE '\_%%' ESCAPE '\'
			AND id IN (
				SELECT child_id FROM tag_relationships
				WHERE parent_id = (SELECT id FROM tags WHERE slug = '_hide_posts')
			)`,
			// _root → nav_order (seed from existing sort_order, fallback 0)
			`UPDATE tags SET nav_order = COALESCE(sort_order, 0)
			WHERE slug NOT LIKE '\_%%' ESCAPE '\'
			AND id IN (
				SELECT child_id FROM tag_relationships
				WHERE parent_id = (SELECT id FROM tags WHERE slug = '_root')
			)`,
			// _is_in_breadcrumbs → in_breadcrumbs = 1
			`UPDATE tags SET in_breadcrumbs = 1
			WHERE slug NOT LIKE '\_%%' ESCAPE '\'
			AND id IN (
				SELECT child_id FROM tag_relationships
				WHERE parent_id = (SELECT id FROM tags WHERE slug = '_is_in_breadcrumbs')
			)`,
			// _with_related → show_related = 1
			`UPDATE tags SET show_related = 1
			WHERE slug NOT LIKE '\_%%' ESCAPE '\'
			AND id IN (
				SELECT child_id FROM tag_relationships
				WHERE parent_id = (SELECT id FROM tags WHERE slug = '_with_related')
			)`,
			// _no_ancestors → in_ancestor_flyout = 0 (default is 1)
			`UPDATE tags SET in_ancestor_flyout = 0
			WHERE slug NOT LIKE '\_%%' ESCAPE '\'
			AND id IN (
				SELECT child_id FROM tag_relationships
				WHERE parent_id = (SELECT id FROM tags WHERE slug = '_no_ancestors')
			)`,
			// _in_timeline descendants → kind = 'year'
			`WITH RECURSIVE timeline_desc(id) AS (
				SELECT child_id FROM tag_relationships
				WHERE parent_id = (SELECT id FROM tags WHERE slug = '_in_timeline')
				UNION ALL
				SELECT tr.child_id FROM tag_relationships tr
				JOIN timeline_desc td ON tr.parent_id = td.id
			)
			UPDATE tags SET kind = 'year'
			WHERE slug NOT LIKE '\_%%' ESCAPE '\'
			AND id IN (SELECT id FROM timeline_desc)`,
		}
		for _, stmt := range flagUpdates {
			if _, err := r.db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("translate flag: %w", err)
			}
		}

		// Rebuild tag_relationships to add sort_order; seed from child's sort_order.
		trRebuild := []string{
			`CREATE TABLE IF NOT EXISTS tag_relationships_new (
				parent_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
				child_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
				sort_order INTEGER,
				PRIMARY KEY (parent_id, child_id)
			)`,
			`INSERT INTO tag_relationships_new (parent_id, child_id, sort_order)
			SELECT tr.parent_id, tr.child_id, t.sort_order
			FROM tag_relationships tr
			JOIN tags t ON t.id = tr.child_id`,
			`DROP TABLE tag_relationships`,
			`ALTER TABLE tag_relationships_new RENAME TO tag_relationships`,
		}
		for _, stmt := range trRebuild {
			if _, err := r.db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("rebuild tag_relationships: %w", err)
			}
		}

		// Remove all edges involving system tags (both parent and child sides).
		if _, err := r.db.ExecContext(ctx, `
			DELETE FROM tag_relationships
			WHERE parent_id IN (SELECT id FROM tags WHERE slug LIKE '\_%%' ESCAPE '\')
			   OR child_id  IN (SELECT id FROM tags WHERE slug LIKE '\_%%' ESCAPE '\')
		`); err != nil {
			return fmt.Errorf("delete system tag edges: %w", err)
		}

		// Remove any post_tags rows pointing to system tags (shouldn't exist, but be safe).
		if _, err := r.db.ExecContext(ctx, `
			DELETE FROM post_tags WHERE tag_id IN (SELECT id FROM tags WHERE slug LIKE '\_%%' ESCAPE '\')
		`); err != nil {
			return fmt.Errorf("delete system post_tags: %w", err)
		}

		// Delete all system tags.
		if _, err := r.db.ExecContext(ctx, `DELETE FROM tags WHERE slug LIKE '\_%%' ESCAPE '\'`); err != nil {
			return fmt.Errorf("delete system tags: %w", err)
		}

		// Rebuild tags table: drop custom_url and sort_order, promote new columns.
		tagsRebuild := []string{
			`CREATE TABLE IF NOT EXISTS tags_new (
				id                INTEGER PRIMARY KEY AUTOINCREMENT,
				name              VARCHAR(100) NOT NULL,
				slug              VARCHAR(100) NOT NULL UNIQUE,
				description       TEXT,
				kind              TEXT NOT NULL DEFAULT 'tag',
				hidden            INTEGER NOT NULL DEFAULT 0,
				hides_posts       INTEGER NOT NULL DEFAULT 0,
				nav_order         INTEGER,
				in_breadcrumbs    INTEGER NOT NULL DEFAULT 0,
				show_related      INTEGER NOT NULL DEFAULT 0,
				in_ancestor_flyout INTEGER NOT NULL DEFAULT 1,
				latitude          REAL,
				longitude         REAL,
				post_count        INTEGER NOT NULL DEFAULT 0,
				created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
			`INSERT INTO tags_new (id, name, slug, description, kind, hidden, hides_posts, nav_order, in_breadcrumbs, show_related, in_ancestor_flyout, latitude, longitude, post_count, created_at)
			SELECT id, name, slug, description, kind, hidden, hides_posts, nav_order, in_breadcrumbs, show_related, in_ancestor_flyout, latitude, longitude, post_count, created_at
			FROM tags`,
			`DROP TABLE tags`,
			`ALTER TABLE tags_new RENAME TO tags`,
			`CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)`,
			`CREATE INDEX IF NOT EXISTS idx_tags_slug ON tags(slug)`,
		}
		for _, stmt := range tagsRebuild {
			if _, err := r.db.ExecContext(ctx, stmt); err != nil {
				return fmt.Errorf("rebuild tags table: %w", err)
			}
		}

		// Drop the now-folded tag_locations table.
		if _, err := r.db.ExecContext(ctx, `DROP TABLE IF EXISTS tag_locations`); err != nil {
			return fmt.Errorf("drop tag_locations: %w", err)
		}

		// Re-enable foreign key enforcement.
		if _, err := r.db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
			return fmt.Errorf("re-enable foreign_keys: %w", err)
		}

		// Recompute post_count for all remaining tags.
		if _, err := r.db.ExecContext(ctx, `
			UPDATE tags SET post_count = (
				SELECT COUNT(*) FROM post_tags
				JOIN posts ON post_tags.post_id = posts.id
				WHERE post_tags.tag_id = tags.id
				  AND posts.status != 'draft'
				  AND posts.deleted_at IS NULL
			)
		`); err != nil {
			return fmt.Errorf("recompute post_count: %w", err)
		}
	}

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name, applied_at) VALUES (?, CURRENT_TIMESTAMP)`, migrationName,
	); err != nil {
		return fmt.Errorf("record %s: %w", migrationName, err)
	}
	return nil
}

// EnsureSystemTags is an idempotent migration that guarantees all required
// system tags exist and are linked to _system. It handles the case where a regular tag
// was previously created with name="_pending" but slug="pending" (via Slugify).
func (r *sqliteRepository) EnsureSystemTags(ctx context.Context) error {
	if _, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS migration_history (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name VARCHAR(255) NOT NULL UNIQUE,
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("create migration_history: %w", err)
	}

	var count int64
	if err := r.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM migration_history WHERE name = 'ensure_system_tags'`,
	).Scan(&count); err != nil {
		return fmt.Errorf("check migration_history: %w", err)
	}
	if count > 0 {
		return nil
	}

	// Rename any tag with name='_pending' but wrong slug (e.g. 'pending').
	// This clears the UNIQUE name constraint so the correct system tag can be inserted.
	if _, err := r.db.ExecContext(ctx,
		`UPDATE tags SET name = slug WHERE name = '_pending' AND slug != '_pending'`,
	); err != nil {
		return fmt.Errorf("rename conflicting _pending tag: %w", err)
	}

	systemTags := []string{
		"_system",
		"_root",
		"_hidden",
		"_hide_posts",
		"_is_in_breadcrumbs",
		"_with_related",
		"_pending",
		"_page",
		"_no_ancestors",
		"_in_timeline",
	}

	for _, st := range systemTags {
		// Display name strips the leading '_' (e.g. "_root" → "root").
		displayName := strings.TrimLeft(st, "_")
		if _, err := r.db.ExecContext(ctx,
			`INSERT OR IGNORE INTO tags (name, slug, post_count, created_at)
			 VALUES (?, ?, 0, CURRENT_TIMESTAMP)`, displayName, st,
		); err != nil {
			return fmt.Errorf("create %s system tag: %w", st, err)
		}
	}

	// Make system tags children of _system (except _system itself)
	for _, st := range systemTags {
		if st == "_system" {
			continue
		}
		if _, err := r.db.ExecContext(ctx,
			`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			 SELECT s.id, c.id FROM tags s, tags c
			 WHERE s.slug = '_system' AND c.slug = ?`, st,
		); err != nil {
			return fmt.Errorf("link %s to _system: %w", st, err)
		}
	}

	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO migration_history (name, applied_at) VALUES ('ensure_system_tags', CURRENT_TIMESTAMP)`,
	); err != nil {
		return fmt.Errorf("record ensure_system_tags: %w", err)
	}
	return nil
}
