package migrations

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/repository"
)

// Run must report failures rather than swallow them: a server that boots
// against a schema the code does not expect fails later, somewhere unrelated.
// See point-fix-migration-boot-failure.
func TestRun_ReportsFailure(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	ctx := context.Background()

	// A healthy database migrates cleanly.
	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run on a fresh database: %v", err)
	}

	// Break the schema out from under the migrations: dropping a table every
	// step depends on makes them genuinely fail rather than no-op. Migration
	// history is cleared too, so they are all attempted again.
	if _, err := repo.DB().ExecContext(ctx, `DELETE FROM migration_history`); err != nil {
		t.Fatalf("clear history: %v", err)
	}
	if _, err := repo.DB().ExecContext(ctx, `DROP TABLE tags`); err != nil {
		t.Fatalf("drop tags: %v", err)
	}

	err = Run(ctx, repo)
	if err == nil {
		t.Fatal("Run returned nil against a broken schema; a failed migration must not be silent")
	}
	// Every step is attempted, so the joined error names more than the first.
	if n := strings.Count(err.Error(), "\n") + 1; n < 2 {
		t.Errorf("expected the joined error to name several failed steps, got %d: %v", n, err)
	}
	_ = repo.Close()
}

// Run is called on every boot, so it has to be safe to re-run.
func TestRun_Idempotent(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	for i := range 3 {
		if err := Run(ctx, repo); err != nil {
			t.Fatalf("Run pass %d: %v", i+1, err)
		}
	}
}
