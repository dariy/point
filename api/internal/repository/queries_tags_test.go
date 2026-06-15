package repository

import (
	"context"
	"testing"
)

func TestRepository_Tags(t *testing.T) {
	repo := setupNewSchemaTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	// Insert tags
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug) VALUES ('T1', 't1'), ('T2', 't2')`)

	tags, err := repo.FindTagsByNames(ctx, []string{"t1", "t2"})
	if err != nil || len(tags) != 2 {
		t.Errorf("FindTagsByNames failed: %v, len=%d", err, len(tags))
	}

	// Hierarchy
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1, 2)`)
	desc, _ := repo.GetTagDescendants(ctx, 1)
	if len(desc) != 1 {
		t.Errorf("GetTagDescendants failed, got %d", len(desc))
	}

	anc, _ := repo.GetTagAncestors(ctx, 2)
	if len(anc) != 1 {
		t.Errorf("GetTagAncestors failed, got %d", len(anc))
	}
}

func TestRepository_TagRelationships(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'P','p'),(2,'C','c')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)

	rels, err := repo.GetAllTagRelationships(ctx)
	if err != nil || len(rels) != 1 {
		t.Errorf("GetAllTagRelationships: err=%v len=%d", err, len(rels))
	}

	if err := repo.ClearTagParents(ctx, 2); err != nil {
		t.Errorf("ClearTagParents failed: %v", err)
	}
	rels, _ = repo.GetAllTagRelationships(ctx)
	if len(rels) != 0 {
		t.Errorf("expected 0 rels after ClearTagParents, got %d", len(rels))
	}

	// Re-insert and test ClearTagChildren
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)
	if err := repo.ClearTagChildren(ctx, 1); err != nil {
		t.Errorf("ClearTagChildren failed: %v", err)
	}
	rels, _ = repo.GetAllTagRelationships(ctx)
	if len(rels) != 0 {
		t.Errorf("expected 0 rels after ClearTagChildren, got %d", len(rels))
	}
}

func TestRepository_TagHierarchy(t *testing.T) {
	repo := setupNewSchemaTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'P','p'),(2,'C','c')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)

	children, err := repo.GetChildrenOfTag(ctx, 1)
	if err != nil || len(children) != 1 {
		t.Errorf("GetChildrenOfTag: err=%v len=%d", err, len(children))
	}

	roots, err := repo.GetRootTags(ctx)
	if err != nil {
		t.Fatalf("GetRootTags failed: %v", err)
	}
	// only tag 1 is a root (no parent)
	if len(roots) != 1 || roots[0].ID != 1 {
		t.Errorf("GetRootTags: unexpected %v", roots)
	}

	if err := repo.UpdateTagSortOrder(ctx, 1, 5); err != nil {
		t.Errorf("UpdateTagSortOrder failed: %v", err)
	}
}

// TestGetTagAncestors_PrefersBreadcrumbParent verifies that when a tag has
// multiple parents, GetTagAncestors follows the branch whose parent has
// in_breadcrumbs=1 rather than the first-inserted (lower-rowid) parent.
//
// Mirrors the real Kyiv case: Kyiv has two parents, city (in_breadcrumbs=0,
// inserted first → lower rowid) and Ukraine (in_breadcrumbs=1, inserted
// second → higher rowid). Without the fix the traversal follows city and
// never reaches Ukraine.
func TestGetTagAncestors_PrefersBreadcrumbParent(t *testing.T) {
	repo := setupNewSchemaTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Tags: location(1), city(2, ib=0), country(3, ib=0), Ukraine(4, ib=1), Kyiv(5, ib=1)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, in_breadcrumbs) VALUES
		(1,'location','location',0),
		(2,'city','city',0),
		(3,'country','country',0),
		(4,'Ukraine','ukraine',1),
		(5,'Kyiv','kyiv',1)`)

	// Relationships: city→Kyiv inserted before Ukraine→Kyiv so city has the
	// lower rowid and would be chosen first by the old (unfixed) code.
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`) // location → city
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,3)`) // location → country
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (2,5)`) // city → Kyiv   (lower rowid: wrong branch)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (4,5)`) // Ukraine → Kyiv (higher rowid: right branch)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (3,4)`) // country → Ukraine

	ancestors, err := repo.GetTagAncestors(ctx, 5) // Kyiv
	if err != nil {
		t.Fatalf("GetTagAncestors: %v", err)
	}

	// Build a name-set for easy assertion.
	names := make(map[string]bool, len(ancestors))
	for _, a := range ancestors {
		names[a.Name] = true
	}

	if !names["Ukraine"] {
		t.Errorf("expected Ukraine in ancestors, got %v", ancestors)
	}
	if names["city"] {
		t.Errorf("expected city NOT in ancestors (wrong branch), got %v", ancestors)
	}
	// country and location have in_breadcrumbs=0 but are still valid ancestors
	// in the traversal chain (they'll be filtered by the handler, not here).
	if !names["country"] {
		t.Errorf("expected country in ancestors, got %v", ancestors)
	}
}

func TestRepository_GetCoOccurringTags(t *testing.T) {
	repo := setupNewSchemaTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES (1,'T1','t1',1),(2,'T2','t2',1)`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (id, title, slug, content, author_id, status, published_at) VALUES (1,'P','p','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1,1),(1,2)`)

	if _, err := repo.GetCoOccurringTags(ctx, 1, false); err != nil {
		t.Fatalf("GetCoOccurringTags failed: %v", err)
	}
	if _, err := repo.GetCoOccurringTags(ctx, 1, true); err != nil {
		t.Fatalf("GetCoOccurringTags (public) failed: %v", err)
	}
}

