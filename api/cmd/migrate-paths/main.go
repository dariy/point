// migrate-paths rewrites legacy /media/originals/… paths in the posts table
// to the simplified /YYYY/MM/… form served by the Go API.
//
// Usage:
//
//	migrate-paths [--db <path>] [--apply]
//
// By default it runs as a dry run and prints a summary of what would change.
// Pass --apply to commit the changes to the database.
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"os"
	"regexp"
	"strings"

	_ "modernc.org/sqlite"
)

var mdImageRe = regexp.MustCompile(`!\[.*?\]\(([^)]+)\)`)

func cleanContent(c string) (string, bool) {
	newC := c
	newC = mdImageRe.ReplaceAllString(newC, "$1")
	newC = strings.ReplaceAll(newC, "/media/originals/", "/")
	return newC, newC != c
}

func main() {
	// Initialize slog with TextHandler for logfmt output
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Redirect standard log to slog to handle legacy log.Printf calls
	log.SetOutput(slog.NewLogLogger(logger.Handler(), slog.LevelInfo).Writer())
	log.SetFlags(0)

	dbPath := flag.String("db", "data/point.db", "path to the SQLite database")
	apply := flag.Bool("apply", false, "commit changes (default is dry run)")
	flag.Parse()

	db, err := sql.Open("sqlite", *dbPath)
	if err != nil {
		slog.Error("open db", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := db.Close(); err != nil {
			slog.Error("error closing db", "error", err)
		}
	}()

	if err := db.Ping(); err != nil {
		slog.Error("ping db", "error", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "database: %s\n", *dbPath)
	if !*apply {
		fmt.Fprintln(os.Stderr, "mode:     dry run  (pass --apply to commit)")
	} else {
		fmt.Fprintln(os.Stderr, "mode:     APPLY")
	}
	fmt.Fprintln(os.Stderr)

	thumbnailCount, err := previewThumbnailPaths(db)
	if err != nil {
		slog.Error("preview thumbnail_path", "error", err)
		os.Exit(1)
	}

	contentCount, err := previewContentPaths(db)
	if err != nil {
		slog.Error("preview content", "error", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stderr, "\nSummary: %d thumbnail_path rows, %d content rows will be updated.\n",
		thumbnailCount, contentCount)

	if thumbnailCount == 0 && contentCount == 0 {
		fmt.Fprintln(os.Stderr, "Nothing to do.")
		return
	}

	if !*apply {
		fmt.Fprintln(os.Stderr, "\nRe-run with --apply to commit the changes.")
		return
	}

	// Apply within a transaction so it's atomic.
	tx, err := db.Begin()
	if err != nil {
		slog.Error("begin tx", "error", err)
		os.Exit(1)
	}

	if err := applyThumbnailPaths(tx); err != nil {
		_ = tx.Rollback()
		slog.Error("update thumbnail_path", "error", err)
		os.Exit(1)
	}

	if err := applyContentPaths(tx, db); err != nil {
		_ = tx.Rollback()
		slog.Error("update content", "error", err)
		os.Exit(1)
	}

	if err := tx.Commit(); err != nil {
		slog.Error("commit", "error", err)
		os.Exit(1)
	}

	fmt.Fprintln(os.Stderr, "Done.")
}

// previewThumbnailPaths prints each affected post and returns the count.
func previewThumbnailPaths(db *sql.DB) (int, error) {
	rows, err := db.Query(`
		SELECT id, title, thumbnail_path
		FROM posts
		WHERE thumbnail_path LIKE '/media/originals/%'
		ORDER BY id
	`)
	if err != nil {
		return 0, err
	}
	defer func() {
		_ = rows.Close()
	}()

	count := 0
	for rows.Next() {
		var id int
		var title, path string
		if err := rows.Scan(&id, &title, &path); err != nil {
			return 0, err
		}
		newPath := stripMediaOriginals(path)
		fmt.Printf("thumbnail  post %4d  %-40s\n  old: %s\n  new: %s\n",
			id, truncate(title, 40), path, newPath)
		count++
	}
	return count, rows.Err()
}

// previewContentPaths prints a per-post count of path occurrences and returns total posts.
func previewContentPaths(db *sql.DB) (int, error) {
	rows, err := db.Query(`
		SELECT id, title, content
		FROM posts
		ORDER BY id
	`)
	if err != nil {
		return 0, err
	}
	defer func() {
		_ = rows.Close()
	}()

	count := 0
	for rows.Next() {
		var id int
		var title, content string
		if err := rows.Scan(&id, &title, &content); err != nil {
			return 0, err
		}

		_, changed := cleanContent(content)
		if changed {
			fmt.Printf("content    post %4d  %-40s  (will be updated)\n",
				id, truncate(title, 40))
			count++
		}
	}
	return count, rows.Err()
}

func applyThumbnailPaths(tx *sql.Tx) error {
	res, err := tx.Exec(`
		UPDATE posts
		SET thumbnail_path = REPLACE(thumbnail_path, '/media/originals/', '/')
		WHERE thumbnail_path LIKE '/media/originals/%'
	`)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	fmt.Fprintf(os.Stderr, "  updated thumbnail_path: %d rows\n", n)
	return nil
}

func applyContentPaths(tx *sql.Tx, db *sql.DB) error {
	// First fetch all posts
	rows, err := db.Query(`SELECT id, content FROM posts`)
	if err != nil {
		return err
	}
	defer func() {
		_ = rows.Close()
	}()

	type update struct {
		id      int
		content string
	}
	var updates []update

	for rows.Next() {
		var id int
		var content string
		if err := rows.Scan(&id, &content); err != nil {
			return err
		}
		if newC, changed := cleanContent(content); changed {
			updates = append(updates, update{id, newC})
		}
	}
	_ = rows.Close()

	stmt, err := tx.Prepare(`UPDATE posts SET content = ? WHERE id = ?`)
	if err != nil {
		return err
	}
	defer func() {
		_ = stmt.Close()
	}()

	count := 0
	for _, u := range updates {
		if _, err := stmt.Exec(u.content, u.id); err != nil {
			return err
		}
		count++
	}

	fmt.Fprintf(os.Stderr, "  updated content:        %d rows\n", count)
	return nil
}

// stripMediaOriginals converts /media/originals/YYYY/MM/file → /YYYY/MM/file.
func stripMediaOriginals(p string) string {
	return strings.Replace(p, "/media/originals/", "/", 1)
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max-1] + "…"
}
