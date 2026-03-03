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
	"os"
	"strings"

	_ "github.com/mattn/go-sqlite3"
)

func main() {
	dbPath := flag.String("db", "data/point.db", "path to the SQLite database")
	apply := flag.Bool("apply", false, "commit changes (default is dry run)")
	flag.Parse()

	db, err := sql.Open("sqlite3", *dbPath)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	defer db.Close()

	if err := db.Ping(); err != nil {
		log.Fatalf("ping db: %v", err)
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
		log.Fatalf("preview thumbnail_path: %v", err)
	}

	contentCount, err := previewContentPaths(db)
	if err != nil {
		log.Fatalf("preview content: %v", err)
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
		log.Fatalf("begin tx: %v", err)
	}

	if err := applyThumbnailPaths(tx); err != nil {
		tx.Rollback()
		log.Fatalf("update thumbnail_path: %v", err)
	}

	if err := applyContentPaths(tx); err != nil {
		tx.Rollback()
		log.Fatalf("update content: %v", err)
	}

	if err := tx.Commit(); err != nil {
		log.Fatalf("commit: %v", err)
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
	defer rows.Close()

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
		WHERE content LIKE '%/media/originals/%'
		ORDER BY id
	`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	count := 0
	for rows.Next() {
		var id int
		var title, content string
		if err := rows.Scan(&id, &title, &content); err != nil {
			return 0, err
		}
		occurrences := strings.Count(content, "/media/originals/")
		fmt.Printf("content    post %4d  %-40s  (%d occurrence(s))\n",
			id, truncate(title, 40), occurrences)
		count++
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

func applyContentPaths(tx *sql.Tx) error {
	res, err := tx.Exec(`
		UPDATE posts
		SET content = REPLACE(content, '/media/originals/', '/')
		WHERE content LIKE '%/media/originals/%'
	`)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	fmt.Fprintf(os.Stderr, "  updated content:        %d rows\n", n)
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
