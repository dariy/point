package repository

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"
)

// Snapshot helpers read a database file that is not the live database: the
// VACUUM INTO copy a backup takes, or the copy a restore check unpacks. They
// open the file read-only, so they can never change it.

// openSnapshot opens path read-only. The URI form carries mode=ro to SQLite;
// query_only refuses a write statement even if a future caller sends one.
func openSnapshot(path string) (*sql.DB, error) {
	dsn := "file:" + (&url.URL{Path: path}).EscapedPath() + "?mode=ro&_pragma=query_only(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

// SnapshotTableCounts returns the row count of each ordinary table in the
// database file at path. Virtual tables (full-text indexes) are left out: their
// rows live in shadow tables, which are ordinary tables and are counted.
func SnapshotTableCounts(ctx context.Context, path string) (map[string]int64, error) {
	db, err := openSnapshot(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()

	rows, err := db.QueryContext(ctx, `SELECT name FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
		AND COALESCE(sql, '') NOT LIKE 'CREATE VIRTUAL TABLE%'
		ORDER BY name`)
	if err != nil {
		return nil, err
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			_ = rows.Close()
			return nil, err
		}
		names = append(names, n)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	counts := make(map[string]int64, len(names))
	for _, n := range names {
		var c int64
		// The name comes from sqlite_master of the same file and is quoted as
		// an identifier; it is not user input.
		q := `SELECT COUNT(*) FROM "` + strings.ReplaceAll(n, `"`, `""`) + `"` //nolint:gosec // G202: identifier from sqlite_master, quoted
		if err := db.QueryRowContext(ctx, q).Scan(&c); err != nil {
			return nil, fmt.Errorf("count %s: %w", n, err)
		}
		counts[n] = c
	}
	return counts, nil
}

// SnapshotQuickCheck runs PRAGMA quick_check on the database file at path and
// returns its first line: "ok" for a sound file.
func SnapshotQuickCheck(ctx context.Context, path string) (string, error) {
	db, err := openSnapshot(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = db.Close() }()
	var res string
	if err := db.QueryRowContext(ctx, `PRAGMA quick_check(1)`).Scan(&res); err != nil {
		return "", err
	}
	return res, nil
}
