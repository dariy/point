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

func (r *Repository) GetMigrations(ctx context.Context) ([]MigrationRecord, error) {
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
func (r *Repository) ApplyMigration(ctx context.Context, name, sql string) error {
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
func (r *Repository) MigrateFlagsToSystemTags(ctx context.Context) error {
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
func (r *Repository) RebuildTagsTableDropBooleans(ctx context.Context) error {
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

// EnsureSystemTags is an idempotent migration that guarantees all required
// system tags exist and are linked to _system. It handles the case where a regular tag
// was previously created with name="_pending" but slug="pending" (via Slugify).
func (r *Repository) EnsureSystemTags(ctx context.Context) error {
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
			`INSERT OR IGNORE INTO tags (name, slug, sort_order, post_count, created_at)
			 VALUES (?, ?, NULL, 0, CURRENT_TIMESTAMP)`, displayName, st,
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
