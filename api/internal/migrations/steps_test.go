package migrations

import (
	"context"
	"path/filepath"
	"slices"
	"testing"

	"point-api/internal/repository"
)

// tailSteps is the order of the non-schema steps, written out so a refactor
// cannot quietly move one. Order here is historical: the two renames assume the
// system tags they rewrite already exist, and tag_flags_from_system_tags reads
// the graph the earlier phases built. A reordering would still pass every other
// test — each step records its own name, so the damage only shows on a database
// that upgrades through this range.
var tailSteps = []string{
	"system_tags_phase_a",
	"system_tags_phase_b",
	"ensure_system_tags",
	"rename_system_tags_to_slug",
	"rename_system_tags_names_no_underscore",
	"tag_flags_from_system_tags",
}

func TestSteps_OrderIsStable(t *testing.T) {
	all := steps()
	if len(all) != len(schema)+len(tailSteps) {
		t.Fatalf("steps() has %d entries, want %d schema + %d tail", len(all), len(schema), len(tailSteps))
	}
	for i, m := range schema {
		if all[i].name != m.name {
			t.Errorf("step %d is %q, want the schema entry %q", i, all[i].name, m.name)
		}
	}
	for i, want := range tailSteps {
		if got := all[len(schema)+i].name; got != want {
			t.Errorf("tail step %d is %q, want %q", i, got, want)
		}
	}
}

// Identity is the name: a duplicate means the second one is recorded as applied
// by the first and never runs, on every database, forever.
func TestSteps_NamesUnique(t *testing.T) {
	seen := map[string]int{}
	for i, s := range steps() {
		if first, ok := seen[s.name]; ok {
			t.Errorf("step %d duplicates the name %q first used by step %d", i, s.name, first)
		}
		seen[s.name] = i
	}
}

func TestPending_FreshDatabaseListsEveryStep(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// A database built straight from schema.sql has no migration_history table
	// at all — GetMigrations reports an empty list for it, and every step must
	// therefore come back as pending.
	pending, err := Pending(ctx, repo)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(pending) != len(steps()) {
		t.Errorf("Pending reported %d steps on an empty history, want all %d", len(pending), len(steps()))
	}
}

// The guarantee that makes the pre-migration snapshot free at steady state: a
// boot with nothing to apply must report nothing pending, so it takes no
// snapshot.
func TestPending_EmptyAfterRun(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run: %v", err)
	}
	pending, err := Pending(ctx, repo)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(pending) != 0 {
		t.Errorf("Pending after a clean Run reported %v, want none", pending)
	}
}

func TestPending_ReportsExactlyTheMissingStep(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run: %v", err)
	}
	const target = "ensure_system_tags"
	if _, err := repo.DB().ExecContext(ctx,
		`DELETE FROM migration_history WHERE name = ?`, target); err != nil {
		t.Fatalf("delete history row: %v", err)
	}

	pending, err := Pending(ctx, repo)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if !slices.Equal(pending, []string{target}) {
		t.Errorf("Pending = %v, want exactly [%s]", pending, target)
	}
}
