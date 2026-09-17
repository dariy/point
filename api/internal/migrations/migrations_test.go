package migrations

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"point-api/internal/models"
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

// indexNames reads the indexes SQLite holds for one table.
func indexNames(t *testing.T, repo repository.Repository, table string) []string {
	t.Helper()
	rows, err := repo.DB().Query(
		`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`, table)
	if err != nil {
		t.Fatalf("read indexes of %s: %v", table, err)
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
		t.Fatalf("scan indexes of %s: %v", table, err)
	}
	return names
}

// A database that predates the composite index has the narrow one, from the
// earlier migration that created it. Both cannot be left in place: they share a
// leading column, so the narrow one serves nothing and every post_tags write
// still pays to maintain it. The plan assertions live next to the query
// (internal/repository); this is only about what survives the swap.
func TestRun_WidensThePostTagsIndex(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Stand in for an old database: schema.sql no longer creates the narrow
	// index, so put it back before migrating.
	if _, err := repo.DB().ExecContext(ctx,
		`CREATE INDEX IF NOT EXISTS idx_post_tags_tag_id ON post_tags(tag_id)`); err != nil {
		t.Fatalf("seed the narrow index: %v", err)
	}

	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run: %v", err)
	}

	names := indexNames(t, repo, "post_tags")
	if slices.Contains(names, "idx_post_tags_tag_id") {
		t.Errorf("the narrow idx_post_tags_tag_id survived the widening: %v", names)
	}
	if !slices.Contains(names, "idx_post_tags_tag_id_post_id") {
		t.Errorf("idx_post_tags_tag_id_post_id is missing after Run: %v", names)
	}
}

// A fresh install migrates an empty database. ANALYZE there would record "no
// rows" for every table and the planner would believe it until something ran
// ANALYZE again — so the statistics refresh has to hold off until there is
// something to measure, and then not need an operator to ask for it.
func TestRun_RefreshesStatisticsOnlyOnceThereAreRows(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Migrations seed system tags and settings, so parts of a fresh database
	// legitimately have rows to measure. posts is the one that does not.
	postsStats := func() int {
		var n int
		// sqlite_stat1 does not exist until something analyses, which is itself
		// the answer on a fresh database.
		if err := repo.DB().QueryRowContext(ctx,
			`SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl = 'posts'`).Scan(&n); err != nil {
			return 0
		}
		return n
	}

	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run on a fresh database: %v", err)
	}
	if n := postsStats(); n != 0 {
		t.Errorf("an empty posts table was analysed anyway (%d sqlite_stat1 rows); "+
			"the planner would carry those zeroes for the life of the install", n)
	}

	if _, err := repo.DB().ExecContext(ctx,
		`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','e','h','D')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	for i := range 200 {
		if _, err := repo.DB().ExecContext(ctx,
			`INSERT INTO posts (title, slug, content, author_id, status, published_at)
			 VALUES ('t', ?, 'c', 1, 'published', datetime('now'))`, fmt.Sprint(i)); err != nil {
			t.Fatalf("seed post %d: %v", i, err)
		}
	}

	// The next boot has no migrations left to apply, so this is the refresh
	// running on its own — which is the point of it not being a one-shot step.
	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run on a populated database: %v", err)
	}
	if n := postsStats(); n == 0 {
		t.Error("a populated posts table was left with no statistics; the planner is guessing")
	}
}

func TestRefreshQueryPlannerStats_ContextCancellation(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err = refreshQueryPlannerStats(ctx, repo)
	if err == nil {
		t.Error("expected error on cancelled context")
	}
}

// Search reads posts_fts, so a database that predates it has to come out of Run
// with the index built and every post already in it — the triggers only see
// writes made after they exist, which for an existing blog is none of them.
func TestRun_BuildsAndBackfillsTheSearchIndex(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Stand in for a database written before the FTS index existed: drop what
	// schema.sql just created, leaving a post behind that no trigger ever saw.
	// Nothing has to be undone in migration_history — NewRepository does not
	// write it, so this database has no record of having run anything.
	for _, stmt := range []string{
		`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','e','h','D')`,
		`INSERT INTO posts (title, slug, content, author_id, status, published_at)
		     VALUES ('Old Post', 'old-post', 'written before the index', 1, 'published', datetime('now'))`,
		`DROP TRIGGER IF EXISTS posts_fts_insert`,
		`DROP TRIGGER IF EXISTS posts_fts_delete`,
		`DROP TRIGGER IF EXISTS posts_fts_update`,
		`DROP TABLE IF EXISTS posts_fts`,
	} {
		if _, err := repo.DB().ExecContext(ctx, stmt); err != nil {
			t.Fatalf("seed the old database (%s): %v", stmt, err)
		}
	}

	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run: %v", err)
	}

	rows, err := repo.ListPostsWithSearch(ctx, false, "", false, false, false, "written", "", false, 10, 0)
	if err != nil {
		t.Fatalf("search after Run: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("search found %d posts written before the index, want 1", len(rows))
	}

	// And the triggers are back, so writes from here on keep it current.
	if _, err := repo.DB().ExecContext(ctx,
		`UPDATE posts SET content = 'rewritten afterwards' WHERE slug = 'old-post'`); err != nil {
		t.Fatalf("update post: %v", err)
	}
	if rows, err := repo.ListPostsWithSearch(ctx, false, "", false, false, false, "afterwards", "", false, 10, 0); err != nil || len(rows) != 1 {
		t.Errorf("search for the rewritten body = (%d rows, %v), want (1, nil)", len(rows), err)
	}
	if rows, err := repo.ListPostsWithSearch(ctx, false, "", false, false, false, "written", "", false, 10, 0); err != nil || len(rows) != 0 {
		t.Errorf("search for the replaced body = (%d rows, %v), want (0, nil)", len(rows), err)
	}
}

// A post could hold one carousel, keyed post_id UNIQUE; it can hold several
// now, keyed by the block. The row an install already has must survive that
// without its post's content being rewritten — so the backfill is the empty
// key, "the first fence, the one with no id yet", which is the key an unkeyed
// request resolves to (api.firstBlockKey) until the studio saves a real one.
func TestRun_RekeysCarouselsByBlock(t *testing.T) {
	repo, err := repository.NewRepository(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Stand in for a database written before block keys: put back the table as
	// it was, one carousel per post, and a row in it. As in the FTS test above,
	// NewRepository writes no migration_history, so nothing has to be undone.
	for _, stmt := range []string{
		`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','e','h','D')`,
		`INSERT INTO posts (id, title, slug, content, author_id, status) VALUES (1,'P','p','body',1,'draft')`,
		`DROP TABLE IF EXISTS carousels`,
		`CREATE TABLE carousels (
			id         INTEGER PRIMARY KEY AUTOINCREMENT,
			post_id    INTEGER NOT NULL UNIQUE REFERENCES posts(id) ON DELETE CASCADE,
			doc        TEXT NOT NULL,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`INSERT INTO carousels (id, post_id, doc) VALUES (7, 1, '{"version":1,"aspect":"4:5"}')`,
	} {
		if _, err := repo.DB().ExecContext(ctx, stmt); err != nil {
			t.Fatalf("seed the old database (%s): %v", stmt, err)
		}
	}

	if err := Run(ctx, repo); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// The row is still there, same id, same document, and now addressable by
	// the keyless key.
	got, err := repo.GetCarouselByBlockKey(ctx, models.GetCarouselByBlockKeyParams{PostID: 1, BlockKey: ""})
	if err != nil {
		t.Fatalf("the pre-existing carousel is unreachable after the rekey: %v", err)
	}
	if got.ID != 7 || got.Doc != `{"version":1,"aspect":"4:5"}` {
		t.Fatalf("the rekey changed the row: %+v", got)
	}

	// And the post can hold a second carousel now, which the old post_id UNIQUE
	// constraint would have rejected.
	if _, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{
		PostID: 1, BlockKey: "c-7f3a", Doc: `{"version":1}`,
	}); err != nil {
		t.Fatalf("second carousel in the same post: %v", err)
	}
	list, err := repo.ListCarouselsByPostID(ctx, 1)
	if err != nil {
		t.Fatalf("ListCarouselsByPostID: %v", err)
	}
	if len(list) != 2 || list[0].BlockKey != "" || list[1].BlockKey != "c-7f3a" {
		t.Fatalf("after the rekey the post holds %+v", list)
	}

	// The cascade survives the table rebuild — the foreign key is declared on
	// the new table, not inherited.
	if _, err := repo.DB().ExecContext(ctx, `DELETE FROM posts WHERE id = 1`); err != nil {
		t.Fatalf("delete post: %v", err)
	}
	var n int
	if err := repo.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM carousels`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("%d carousel rows survived the post delete; the rebuilt table lost its cascade", n)
	}

	// Re-running is a no-op: the step is recorded, and nothing is pending.
	if err := Run(ctx, repo); err != nil {
		t.Fatalf("second Run: %v", err)
	}
	pending, err := Pending(ctx, repo)
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("still pending after two runs: %v", pending)
	}
}
