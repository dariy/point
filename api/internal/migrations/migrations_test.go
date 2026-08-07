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

// The post-viewer slot went from "at least one viewer" to "exactly one", so
// installs configured under the old rule are reconciled on boot: two enabled
// viewers collapse to the standard one (what the frontend already mounted), and
// none at all — which rendered immersive posts blank — gets a viewer back. A
// database with no viewer settings is left alone so setup can seed the registry
// defaults.
func TestRun_ReconcilesPostViewerSettings(t *testing.T) {
	const (
		standard = "plugin.immersive.enabled"
		sheet    = "plugin.immersive-sheet.enabled"
	)

	cases := []struct {
		name          string
		seed          map[string]string
		wantStandard  string
		wantSheet     string
		wantUntouched bool
	}{
		{name: "both enabled collapse to standard", seed: map[string]string{standard: "true", sheet: "true"}, wantStandard: "true", wantSheet: "false"},
		{name: "sheet only is left alone", seed: map[string]string{standard: "false", sheet: "true"}, wantStandard: "false", wantSheet: "true"},
		{name: "neither enabled gets a viewer back", seed: map[string]string{standard: "false", sheet: "false"}, wantStandard: "true", wantSheet: "false"},
		{name: "unseeded database keeps its defaults", seed: nil, wantUntouched: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
			if err != nil {
				t.Fatalf("NewRepository: %v", err)
			}
			defer func() { _ = repo.Close() }()
			ctx := context.Background()

			for key, value := range tc.seed {
				if _, err := repo.DB().ExecContext(ctx,
					`INSERT OR REPLACE INTO blog_settings (key, value, value_type, updated_at)
					 VALUES (?, ?, 'string', CURRENT_TIMESTAMP)`, key, value); err != nil {
					t.Fatalf("seed %s: %v", key, err)
				}
			}

			if err := Run(ctx, repo); err != nil {
				t.Fatalf("Run: %v", err)
			}

			get := func(key string) (string, bool) {
				var v string
				err := repo.DB().QueryRowContext(ctx, `SELECT value FROM blog_settings WHERE key = ?`, key).Scan(&v)
				return v, err == nil
			}
			if tc.wantUntouched {
				if v, ok := get(standard); ok {
					t.Errorf("%s = %q on an unseeded database; migrations must not pre-empt setup", standard, v)
				}
				if v, ok := get(sheet); ok {
					t.Errorf("%s = %q on an unseeded database; migrations must not pre-empt setup", sheet, v)
				}
				return
			}
			if v, _ := get(standard); v != tc.wantStandard {
				t.Errorf("%s = %q, want %q", standard, v, tc.wantStandard)
			}
			if v, _ := get(sheet); v != tc.wantSheet {
				t.Errorf("%s = %q, want %q", sheet, v, tc.wantSheet)
			}
		})
	}
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
