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

