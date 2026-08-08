package repository

import (
	"path/filepath"
	"strings"
	"testing"
)

// A database that has lost a core table but still holds data must not be
// treated as a new one. schema.sql is all IF NOT EXISTS, so initializing over
// it would quietly recreate the missing table empty and boot as if nothing had
// happened — and because the "fresh database" branch also skips both bootstrap
// lists, the result would be wrong twice over. Stopping keeps the file, and the
// snapshots beside it, recoverable.
func TestNewRepository_RefusesToInitializeOverDamagedDatabase(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "point.db")

	repo, err := NewRepository(dbPath)
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	if _, err := repo.DB().Exec(
		`INSERT INTO users (username, email, password_hash, display_name) VALUES ('keep','k@x.com','h','Keep')`,
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, err := repo.DB().Exec(`DROP TABLE tags`); err != nil {
		t.Fatalf("drop tags: %v", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := NewRepository(dbPath)
	if err == nil {
		_ = reopened.Close()
		t.Fatal("NewRepository initialized over a populated database missing a core table")
	}
	for _, want := range []string{"tags", "refusing to initialize", "restore-db.sh"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q: %v", want, err)
		}
	}

	// The data is still there to recover.
	check, err := NewRepository(dbPath + "?_pragma=busy_timeout(5000)")
	if err == nil {
		_ = check.Close()
		t.Fatal("second attempt succeeded; the refusal must be stable")
	}
}

// An initialization that died part way through has the same missing tables but
// nothing to lose, so it is completed rather than refused.
func TestNewRepository_CompletesPartialInitialization(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "point.db")

	repo, err := NewRepository(dbPath)
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	if _, err := repo.DB().Exec(`DROP TABLE tags`); err != nil {
		t.Fatalf("drop tags: %v", err)
	}
	if err := repo.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := NewRepository(dbPath)
	if err != nil {
		t.Fatalf("NewRepository on an empty partial database: %v", err)
	}
	defer func() { _ = reopened.Close() }()

	present, populated, err := inspectCoreSchema(reopened.DB())
	if err != nil {
		t.Fatalf("inspectCoreSchema: %v", err)
	}
	if len(present) != len(coreTables) {
		t.Errorf("core tables after completion: %v, want all of %v", present, coreTables)
	}
	if populated {
		t.Error("a completed empty database reports as populated")
	}
}

func TestInspectCoreSchema(t *testing.T) {
	repo, err := NewRepository(filepath.Join(t.TempDir(), "point.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()

	present, populated, err := inspectCoreSchema(repo.DB())
	if err != nil {
		t.Fatalf("inspectCoreSchema: %v", err)
	}
	if len(present) != len(coreTables) {
		t.Fatalf("fresh database reports %v, want all core tables", present)
	}
	if populated {
		t.Error("a fresh database reports as populated")
	}
	if missing := missingFrom(present); len(missing) != 0 {
		t.Errorf("missingFrom = %v, want none", missing)
	}

	if _, err := repo.DB().Exec(
		`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','u@x.com','h','U')`,
	); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if _, _, err := inspectCoreSchema(repo.DB()); err != nil {
		t.Fatalf("inspectCoreSchema after seed: %v", err)
	}
	if _, populated, _ := inspectCoreSchema(repo.DB()); !populated {
		t.Error("a database with a user reports as empty")
	}

	if got := missingFrom([]string{"users", "posts"}); len(got) != 2 || got[0] != "tags" {
		t.Errorf("missingFrom([users posts]) = %v, want [tags blog_settings]", got)
	}
}
