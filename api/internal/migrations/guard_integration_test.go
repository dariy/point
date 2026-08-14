//go:build !unit

package migrations

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"point-api/internal/repository"
	"point-api/internal/services"

	_ "modernc.org/sqlite"
)

// historyNames reads migration_history from a raw connection, sorted, so two
// databases can be compared without caring about insertion order.
func historyNames(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT name FROM migration_history ORDER BY name`)
	if err != nil {
		t.Fatalf("read migration_history: %v", err)
	}
	defer func() { _ = rows.Close() }()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("scan migration_history: %v", err)
	}
	return names
}

// The headline guarantee: when the migration phase fails part way through, the
// database that survives is the one from before it started — not a half-applied
// hybrid of two schemas.
func TestGuard_RestoresPreMigrationStateOnFailure(t *testing.T) {
	dataPath := t.TempDir()
	dbPath := filepath.Join(dataPath, "point.db")
	ctx := context.Background()

	repo, err := repository.NewRepository(dbPath)
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run on a fresh database: %v", err)
	}
	// Something worth losing.
	if _, err := repo.DB().ExecContext(ctx,
		`INSERT INTO tags (name, slug, post_count, created_at) VALUES ('probe', 'probe', 0, CURRENT_TIMESTAMP)`); err != nil {
		t.Fatalf("seed tag: %v", err)
	}

	sys := services.NewSystemService(repo, dataPath, dbPath)
	snapshot, err := sys.SnapshotForMigrations(ctx, 3)
	if err != nil {
		t.Fatalf("SnapshotForMigrations: %v", err)
	}
	if snapshot == "" {
		t.Fatal("no snapshot was taken for a database that exists")
	}

	wantHistory := historyNames(t, repo.DB())
	var wantTags int
	if err := repo.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM tags`).Scan(&wantTags); err != nil {
		t.Fatalf("count tags: %v", err)
	}

	// Break the schema the way a genuinely failing upgrade would: history
	// cleared so every step runs again, and a table every step depends on gone.
	for _, stmt := range []string{`DELETE FROM migration_history`, `DROP TABLE tags`} {
		if _, err := repo.DB().ExecContext(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	runErr := Run(ctx, repo)
	if runErr == nil {
		t.Fatal("Run succeeded against a broken schema; this test proves nothing")
	}

	if err := repo.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := sys.RestoreDBSnapshot(snapshot, runErr); err != nil {
		t.Fatalf("RestoreDBSnapshot: %v", err)
	}

	// Byte-for-byte, before anything reopens the file and touches it.
	restored, err := os.ReadFile(dbPath)
	if err != nil {
		t.Fatalf("read restored database: %v", err)
	}
	snapBytes, err := os.ReadFile(snapshot)
	if err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if !bytes.Equal(restored, snapBytes) {
		t.Errorf("restored database differs from the snapshot (%d vs %d bytes)", len(restored), len(snapBytes))
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(dbPath + suffix); !os.IsNotExist(err) {
			t.Errorf("%s sidecar of the broken database survived", suffix)
		}
	}

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer func() { _ = db.Close() }()

	var check string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&check); err != nil {
		t.Fatalf("integrity_check: %v", err)
	}
	if check != "ok" {
		t.Errorf("restored database fails integrity_check: %s", check)
	}
	var gotTags int
	if err := db.QueryRow(`SELECT COUNT(*) FROM tags`).Scan(&gotTags); err != nil {
		t.Fatalf("count tags after restore: %v", err)
	}
	if gotTags != wantTags {
		t.Errorf("tags count is %d after the restore, want %d", gotTags, wantTags)
	}
	if got := historyNames(t, db); !slices.Equal(got, wantHistory) {
		t.Errorf("migration_history changed across the restore:\n got %v\nwant %v", got, wantHistory)
	}

	// The broken database is still there to look at.
	entries, _ := os.ReadDir(filepath.Join(dataPath, "backups", "migrations"))
	var failed, note bool
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "failed_") {
			if strings.HasSuffix(e.Name(), ".db") {
				failed = true
			}
			if strings.HasSuffix(e.Name(), ".txt") {
				note = true
			}
		}
	}
	if !failed || !note {
		t.Errorf("failed database preserved=%v, note written=%v; want both", failed, note)
	}
}

// A boot with nothing to apply must not pay for a snapshot.
func TestSnapshotForMigrations_SkippedWhenNothingPending(t *testing.T) {
	dataPath := t.TempDir()
	dbPath := filepath.Join(dataPath, "point.db")
	ctx := context.Background()

	repo, err := repository.NewRepository(dbPath)
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run: %v", err)
	}

	pending, err := Pending(ctx, repo)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("a freshly migrated database still reports %v pending", pending)
	}
	// The caller skips the snapshot on an empty pending set; assert the
	// directory it would have written to stays absent.
	if _, err := os.Stat(filepath.Join(dataPath, "backups", "migrations")); !os.IsNotExist(err) {
		t.Error("a snapshot directory exists for a boot with nothing to migrate")
	}
}

// A brand-new install has no database file when the guard runs — that is not an
// error, there is simply nothing to protect yet.
func TestSnapshotForMigrations_FreshInstall(t *testing.T) {
	dataPath := t.TempDir()
	sys := services.NewSystemService(nil, dataPath, filepath.Join(dataPath, "point.db"))

	snapshot, err := sys.SnapshotForMigrations(context.Background(), 3)
	if err != nil {
		t.Fatalf("SnapshotForMigrations on a fresh install: %v", err)
	}
	if snapshot != "" {
		t.Errorf("snapshot %q taken with no database file", snapshot)
	}
}
