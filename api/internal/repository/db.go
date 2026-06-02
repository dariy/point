package repository

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"strings"

	_ "modernc.org/sqlite"
	"point-api/internal/models"
	pointsql "point-api/sql"
)

type Repository struct {
	*models.Queries
	db *sql.DB
}

func NewRepository(dbURL string) (*Repository, error) {
	db, err := sql.Open("sqlite", dbURL)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Set busy timeout to handle concurrent access
	if _, err := db.Exec("PRAGMA busy_timeout = 5000;"); err != nil {
		return nil, fmt.Errorf("failed to set busy timeout: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Enable foreign keys
	if _, err := db.Exec("PRAGMA foreign_keys = ON;"); err != nil {
		return nil, fmt.Errorf("failed to enable foreign keys: %w", err)
	}

	// Enable WAL mode and verify the database is writable.
	// If either fails, the data directory has wrong permissions and we
	// must exit now rather than letting the server start in a broken state
	// where reads succeed but every write (e.g. first-run setup) silently fails.
	var journalMode string
	if err := db.QueryRow("PRAGMA journal_mode = WAL;").Scan(&journalMode); err != nil {
		return nil, fmt.Errorf("database is not writable — check permissions on the data directory: %w", err)
	}

	// Check if the database needs initialization.
	// We check for multiple core tables to detect partially-initialized databases.
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users', 'posts', 'tags', 'blog_settings');").Scan(&count)
	if err != nil {
		return nil, fmt.Errorf("failed to check database schema: %w", err)
	}

	if count < 4 {
		log.Println("Initializing new database with schema...")
		tx, err := db.Begin()
		if err != nil {
			return nil, fmt.Errorf("failed to begin transaction: %w", err)
		}
		defer func() { _ = tx.Rollback() }()

		// Use SplitSeq for efficient iteration without allocating a full slice
		for stmt := range strings.SplitSeq(pointsql.SchemaSQL, ";") {
			trimmed := strings.TrimSpace(stmt)
			if trimmed == "" {
				continue
			}
			if _, err := tx.Exec(trimmed); err != nil {
				return nil, fmt.Errorf("failed to execute schema statement: %w\nStatement: %s", err, trimmed)
			}
		}

		if err := tx.Commit(); err != nil {
			return nil, fmt.Errorf("failed to commit schema transaction: %w", err)
		}
		log.Println("Database schema initialized successfully.")
	} else {
		// Run migrations for existing databases.
		// SQLite returns an error if the column already exists — that's safe to ignore.
		if _, err := db.Exec(`ALTER TABLE posts ADD COLUMN css TEXT NOT NULL DEFAULT ''`); err != nil {
			if !isDuplicateColumnError(err) {
				return nil, fmt.Errorf("migration failed (add posts.css): %w", err)
			}
		}
		if _, err := db.Exec(`ALTER TABLE posts ADD COLUMN immersive_mode TEXT NOT NULL DEFAULT 'auto'`); err != nil {
			if !isDuplicateColumnError(err) {
				return nil, fmt.Errorf("migration failed (add posts.immersive_mode): %w", err)
			}
		}
	}

	queries := models.New(db)
	repo := &Repository{
		Queries: queries,
		db:      db,
	}

	if count >= 4 {
		// Run migrations for existing databases.
		if err := repo.ApplyMigration(context.Background(), "add_api_keys", `
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
`); err != nil {
			return nil, fmt.Errorf("migration failed (add_api_keys): %w", err)
		}
	}

	return repo, nil
}

func (r *Repository) Close() error {
	return r.db.Close()
}

func isDuplicateColumnError(err error) bool {
	return strings.Contains(err.Error(), "duplicate column name")
}

func (r *Repository) DB() *sql.DB {
	return r.db
}
