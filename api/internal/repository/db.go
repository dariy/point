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

	// Enable WAL mode for better concurrency.
	// This might fail if the database or directory is read-only.
	if _, err := db.Exec("PRAGMA journal_mode = WAL;"); err != nil {
		// If it fails with "readonly", we want to know, but we might still
		// be able to operate in read-only mode if that's what's intended
		// (though usually it's not).
		fmt.Printf("Warning: failed to set journal_mode to WAL: %v\n", err)
	}

	// Check if the database needs initialization
	var tableName string
	err = db.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name='blog_settings';").Scan(&tableName)
	if err == sql.ErrNoRows {
		log.Println("Initializing new database with schema...")
		if _, err := db.Exec(pointsql.SchemaSQL); err != nil {
			return nil, fmt.Errorf("failed to initialize database schema: %w", err)
		}
		log.Println("Database schema initialized successfully.")
	} else if err != nil {
		return nil, fmt.Errorf("failed to check database schema: %w", err)
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
