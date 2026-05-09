package repository

import (
	"database/sql"
	"fmt"
	"log"

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

	// Check if the database needs initialization
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='blog_settings';").Scan(&count)
	if err != nil {
		return nil, fmt.Errorf("failed to check database schema: %w", err)
	}

	if count == 0 {
		log.Println("Initializing new database with schema...")
		if _, err := db.Exec(pointsql.SchemaSQL); err != nil {
			return nil, fmt.Errorf("failed to initialize database schema: %w", err)
		}
		log.Println("Database schema initialized successfully.")
	}

	queries := models.New(db)
	return &Repository{
		Queries: queries,
		db:      db,
	}, nil
}

func (r *Repository) Close() error {
	return r.db.Close()
}

func (r *Repository) DB() *sql.DB {
	return r.db
}
