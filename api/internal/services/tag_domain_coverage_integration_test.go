//go:build !unit

package services

// Integration coverage for the tag-domain paths that go through the
// repository: graph construction, tag CRUD, the cloud and count rollups, and
// the hierarchy write path. The pure graph reads are unit-tested in
// tag_graph_test.go and tag_graph_type_test.go.
//
// Failure branches are reached two ways. Where a whole table going missing is
// a faithful stand-in for the failure — the first query a method makes — the
// test drops the table, matching the existing tag tests. Where the branch sits
// behind several calls that must succeed first, failRepo fails exactly the one
// call in question, so the test cannot pass for the wrong reason.

import (
	"context"
	"errors"
	"testing"

	"point-api/internal/models"
	"point-api/internal/repository"
)

var errRepoBoom = errors.New("repository failed")

// failRepo delegates to a real repository except for the named methods, which
// return errRepoBoom.
type failRepo struct {
	repository.Repository
	fail map[string]bool
}

func failing(repo repository.Repository, methods ...string) *TagService {
	m := make(map[string]bool, len(methods))
	for _, name := range methods {
		m[name] = true
	}
	return NewTagService(failRepo{Repository: repo, fail: m})
}

func (r failRepo) AddTagRelationship(ctx context.Context, arg models.AddTagRelationshipParams) error {
	if r.fail["AddTagRelationship"] {
		return errRepoBoom
	}
	return r.Repository.AddTagRelationship(ctx, arg)
}

func (r failRepo) ClearTagParents(ctx context.Context, childID int64) error {
	if r.fail["ClearTagParents"] {
		return errRepoBoom
	}
	return r.Repository.ClearTagParents(ctx, childID)
}

func (r failRepo) GetTagChildren(ctx context.Context, parentID int64) ([]models.Tag, error) {
	if r.fail["GetTagChildren"] {
		return nil, errRepoBoom
	}
	return r.Repository.GetTagChildren(ctx, parentID)
}

func (r failRepo) GetChildrenOfTag(ctx context.Context, parentID int64) ([]models.Tag, error) {
	if r.fail["GetChildrenOfTag"] {
		return nil, errRepoBoom
	}
	return r.Repository.GetChildrenOfTag(ctx, parentID)
}

func (r failRepo) GetRootTags(ctx context.Context) ([]models.Tag, error) {
	if r.fail["GetRootTags"] {
		return nil, errRepoBoom
	}
	return r.Repository.GetRootTags(ctx)
}

func (r failRepo) UpdateTagSortOrder(ctx context.Context, id int64, sortOrder int32) error {
	if r.fail["UpdateTagSortOrder"] {
		return errRepoBoom
	}
	return r.Repository.UpdateTagSortOrder(ctx, id, sortOrder)
}

func (r failRepo) UpdateEdgeSortOrder(ctx context.Context, parentID, childID int64, sortOrder int32) error {
	if r.fail["UpdateEdgeSortOrder"] {
		return errRepoBoom
	}
	return r.Repository.UpdateEdgeSortOrder(ctx, parentID, childID, sortOrder)
}

func (r failRepo) CountPostsByTagIDs(ctx context.Context, tagIDs []int64, publishedOnly, includeDrafts, includeHidden bool) (int64, error) {
	if r.fail["CountPostsByTagIDs"] {
		return 0, errRepoBoom
	}
	return r.Repository.CountPostsByTagIDs(ctx, tagIDs, publishedOnly, includeDrafts, includeHidden)
}

func (r failRepo) CountPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly, includeDrafts, includeHidden bool) (int64, error) {
	if r.fail["CountPostsByTagIDsInYearRange"] {
		return 0, errRepoBoom
	}
	return r.Repository.CountPostsByTagIDsInYearRange(ctx, tagIDs, fromYear, toYear, publishedOnly, includeDrafts, includeHidden)
}

func (r failRepo) GetPostsByTagIDsInYearRange(ctx context.Context, tagIDs []int64, fromYear, toYear int, publishedOnly, includeDrafts, includeHidden bool, limit, offset int64) ([]models.Post, error) {
	if r.fail["GetPostsByTagIDsInYearRange"] {
		return nil, errRepoBoom
	}
	return r.Repository.GetPostsByTagIDsInYearRange(ctx, tagIDs, fromYear, toYear, publishedOnly, includeDrafts, includeHidden, limit, offset)
}

// tagRepo returns a repository closed at test end.
func tagRepo(t *testing.T) repository.Repository {
	t.Helper()
	repo := setupTestDB(t)
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func mustExec(t *testing.T, repo repository.Repository, q string, args ...any) {
	t.Helper()
	if _, err := repo.DB().Exec(q, args...); err != nil {
		t.Fatalf("mustExec %q: %v", q, err)
	}
}

// seedPost inserts a published post and tags it. Note that the year filters
// key off tags of kind 'year', not published_at, so a test that filters by year
// tags its posts with a year tag rather than dating them.
func seedPost(t *testing.T, repo repository.Repository, id int64, slug string, tagIDs ...int64) {
	t.Helper()
	mustExec(t, repo, `INSERT OR IGNORE INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	mustExec(t, repo,
		`INSERT INTO posts (id,title,slug,content,author_id,status,published_at) VALUES (?,?,?,'body',1,'published',datetime('now'))`,
		id, slug, slug)
	for _, tid := range tagIDs {
		mustExec(t, repo, `INSERT INTO post_tags (post_id, tag_id) VALUES (?,?)`, id, tid)
	}
}

// ── buildGraph ──────────────────────────────────────────────────────────────

func TestTagService_BuildGraph(t *testing.T) {
	ctx := context.Background()

	t.Run("year tags are collected and slug-sorted", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug,kind) VALUES (1,'2020','2020','year'),(2,'2011','2011','year'),(3,'Travel','travel','tag')`)

		g, err := svc.GetTagSnapshot(ctx)
		if err != nil {
			t.Fatalf("GetTagSnapshot: %v", err)
		}
		if len(g.YearTags) != 2 || g.YearTags[0].Slug != "2011" || g.YearTags[1].Slug != "2020" {
			t.Errorf("YearTags = %+v, want [2011 2020] and no 'tag' kinds", g.YearTags)
		}
	})

	t.Run("a failed tag list fails the build", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `DROP TABLE tags`)

		if _, err := svc.GetTagSnapshot(ctx); err == nil {
			t.Error("GetTagSnapshot with no tags table: expected an error")
		}
	})

	t.Run("a failed relationship list fails the build", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'T','t')`)
		mustExec(t, repo, `DROP TABLE tag_relationships`)

		if _, err := svc.GetTagSnapshot(ctx); err == nil {
			t.Error("GetTagSnapshot with no tag_relationships table: expected an error")
		}
	})

	t.Run("hides_posts is inherited by descendants but hidden is not", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug,hidden,hides_posts) VALUES (1,'Root','root',1,1),(2,'Mid','mid',0,0),(3,'Leaf','leaf',0,0)`)
		mustExec(t, repo, `INSERT INTO tag_relationships (parent_id,child_id) VALUES (1,2),(2,3)`)

		g, err := svc.GetTagSnapshot(ctx)
		if err != nil {
			t.Fatalf("GetTagSnapshot: %v", err)
		}
		for _, id := range []int64{1, 2, 3} {
			if !g.EffectiveHidesPosts[id] {
				t.Errorf("EffectiveHidesPosts[%d] = false, want hides_posts to cascade", id)
			}
		}
		if g.EffectiveHidden[2] || g.EffectiveHidden[3] {
			t.Error("hidden must not cascade to descendants")
		}
		if g.HiddenVia[1] != 1 {
			t.Errorf("HiddenVia[1] = %d, want the tag itself", g.HiddenVia[1])
		}
	})
}

// ── CRUD ────────────────────────────────────────────────────────────────────

func TestTagService_CreateTag_Errors(t *testing.T) {
	ctx := context.Background()

	t.Run("a duplicate slug is reported as a conflict", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		if _, err := svc.CreateTag(ctx, CreateTagParams{Name: "Travel"}); err != nil {
			t.Fatalf("CreateTag: %v", err)
		}
		if _, err := svc.CreateTag(ctx, CreateTagParams{Name: "Travel"}); !errors.Is(err, ErrTagSlugExists) {
			t.Errorf("duplicate CreateTag = %v, want ErrTagSlugExists", err)
		}
	})

	t.Run("any other insert failure is surfaced as-is", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `DROP TABLE tags`)

		_, err := svc.CreateTag(ctx, CreateTagParams{Name: "Travel"})
		if err == nil || errors.Is(err, ErrTagSlugExists) {
			t.Errorf("CreateTag with no tags table = %v, want a plain error", err)
		}
	})

	t.Run("a failure attaching parents fails the create", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		// The tag row inserts fine; wiring its parents is what breaks.
		mustExec(t, repo, `DROP TABLE tag_relationships`)

		if _, err := svc.CreateTag(ctx, CreateTagParams{Name: "Travel", ParentIDs: []int64{1}}); err == nil {
			t.Error("CreateTag with no tag_relationships table: expected an error")
		}
	})
}

func TestTagService_UpdateTag_DuplicateSlug(t *testing.T) {
	ctx := context.Background()
	repo := tagRepo(t)
	svc := NewTagService(repo)

	first, err := svc.CreateTag(ctx, CreateTagParams{Name: "Travel"})
	if err != nil {
		t.Fatalf("CreateTag: %v", err)
	}
	second, err := svc.CreateTag(ctx, CreateTagParams{Name: "Food"})
	if err != nil {
		t.Fatalf("CreateTag: %v", err)
	}

	_, err = svc.UpdateTag(ctx, UpdateTagParams{ID: second.ID, Name: "Food", Slug: first.Slug})
	if !errors.Is(err, ErrTagSlugExists) {
		t.Errorf("UpdateTag onto a taken slug = %v, want ErrTagSlugExists", err)
	}
}

func TestTagService_DeleteTag_Errors(t *testing.T) {
	ctx := context.Background()

	t.Run("an unknown tag is not found", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		if err := svc.DeleteTag(ctx, 404); !errors.Is(err, ErrTagNotFound) {
			t.Errorf("DeleteTag(unknown) = %v, want ErrTagNotFound", err)
		}
	})

	t.Run("a repository failure after the lookup is surfaced", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'T','t')`)
		// Warm the cache so the lookup succeeds off the snapshot, then take the
		// table away so only the delete itself fails.
		if _, err := svc.GetTagSnapshot(ctx); err != nil {
			t.Fatalf("GetTagSnapshot: %v", err)
		}
		mustExec(t, repo, `DROP TABLE tags`)

		if err := svc.DeleteTag(ctx, 1); err == nil {
			t.Error("DeleteTag with no tags table: expected an error")
		}
	})
}

func TestTagService_MergeTags(t *testing.T) {
	ctx := context.Background()

	t.Run("the loser is absorbed and the graph is rebuilt", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'Winner','winner'),(2,'Loser','loser')`)
		seedPost(t, repo, 1, "p1", 2)
		if _, err := svc.GetTagSnapshot(ctx); err != nil {
			t.Fatalf("GetTagSnapshot: %v", err)
		}

		if err := svc.MergeTags(ctx, 1, 2); err != nil {
			t.Fatalf("MergeTags: %v", err)
		}
		g, err := svc.GetTagSnapshot(ctx)
		if err != nil {
			t.Fatalf("GetTagSnapshot: %v", err)
		}
		if _, ok := g.ByID[2]; ok {
			t.Error("the merged-away tag is still in the graph: MergeTags did not invalidate")
		}
		if g.CountsAdmin[1] != 1 {
			t.Errorf("winner count = %d, want the loser's post moved across", g.CountsAdmin[1])
		}
	})

	t.Run("a repository failure is surfaced", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `DROP TABLE post_tags`)

		if err := svc.MergeTags(ctx, 1, 2); err == nil {
			t.Error("MergeTags with no post_tags table: expected an error")
		}
	})
}

func TestTagService_SearchTags(t *testing.T) {
	ctx := context.Background()
	repo := tagRepo(t)
	svc := NewTagService(repo)
	mustExec(t, repo, `INSERT INTO tags (id,name,slug,post_count) VALUES (1,'Travel','travel',5),(2,'Travelling','travelling',9),(3,'Food','food',1)`)

	got, err := svc.SearchTags(ctx, "trav", 10)
	if err != nil {
		t.Fatalf("SearchTags: %v", err)
	}
	if len(got) != 2 || got[0].Slug != "travelling" {
		t.Errorf("SearchTags(trav) = %v, want both travel tags, most-used first", tagNames(got))
	}
	if got, err := svc.SearchTags(ctx, "trav", 1); err != nil || len(got) != 1 {
		t.Errorf("SearchTags with limit 1 returned %d tags (%v)", len(got), err)
	}
}

// ── locations ───────────────────────────────────────────────────────────────

func TestTagService_Locations_Roundtrip(t *testing.T) {
	ctx := context.Background()

	t.Run("upsert, read back and delete", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'Lisbon','lisbon')`)

		if err := svc.UpsertTagLocation(ctx, 1, 38.7, -9.1); err != nil {
			t.Fatalf("UpsertTagLocation: %v", err)
		}
		locs, err := svc.GetTagLocationsByTagIDs(ctx, []int64{1})
		if err != nil {
			t.Fatalf("GetTagLocationsByTagIDs: %v", err)
		}
		if got, ok := locs[1]; !ok || got.Latitude != 38.7 || got.Longitude != -9.1 {
			t.Errorf("location = %+v (present=%v), want 38.7/-9.1", got, ok)
		}

		if err := svc.DeleteTagLocation(ctx, 1); err != nil {
			t.Fatalf("DeleteTagLocation: %v", err)
		}
		if locs, _ := svc.GetTagLocationsByTagIDs(ctx, []int64{1}); len(locs) != 0 {
			t.Errorf("location survived the delete: %+v", locs)
		}
	})

	t.Run("SetTagLocations stores only the first pair and clears on empty", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'Lisbon','lisbon')`)

		err := svc.SetTagLocations(ctx, 1, []TagLocationInput{{Latitude: 1, Longitude: 2}, {Latitude: 3, Longitude: 4}})
		if err != nil {
			t.Fatalf("SetTagLocations: %v", err)
		}
		locs, _ := svc.GetTagLocationsByTagIDs(ctx, []int64{1})
		if locs[1].Latitude != 1 {
			t.Errorf("stored latitude = %v, want the first entry only", locs[1].Latitude)
		}

		if err := svc.SetTagLocations(ctx, 1, nil); err != nil {
			t.Fatalf("SetTagLocations(nil): %v", err)
		}
		if locs, _ := svc.GetTagLocationsByTagIDs(ctx, []int64{1}); len(locs) != 0 {
			t.Errorf("location survived SetTagLocations(nil): %+v", locs)
		}
	})

	t.Run("repository failures are surfaced", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `DROP TABLE tags`)

		if err := svc.UpsertTagLocation(ctx, 1, 1, 2); err == nil {
			t.Error("UpsertTagLocation with no tags table: expected an error")
		}
		if err := svc.DeleteTagLocation(ctx, 1); err == nil {
			t.Error("DeleteTagLocation with no tags table: expected an error")
		}
		if err := svc.SetTagLocations(ctx, 1, []TagLocationInput{{Latitude: 1, Longitude: 2}}); err == nil {
			t.Error("SetTagLocations with no tags table: expected an error")
		}
	})
}

// ── counts and cloud ────────────────────────────────────────────────────────

func TestTagService_Counts(t *testing.T) {
	ctx := context.Background()

	t.Run("hierarchical counts roll descendants up", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'Parent','parent'),(2,'Child','child')`)
		mustExec(t, repo, `INSERT INTO tag_relationships (parent_id,child_id) VALUES (1,2)`)
		seedPost(t, repo, 1, "p1", 2)

		counts, err := svc.GetHierarchicalPostCounts(ctx, true)
		if err != nil {
			t.Fatalf("GetHierarchicalPostCounts: %v", err)
		}
		if counts[1] != 1 {
			t.Errorf("parent count = %d, want the child's post rolled up", counts[1])
		}
	})

	t.Run("UpdateAllPostCounts refreshes and invalidates", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug,post_count) VALUES (1,'T','t',99)`)
		seedPost(t, repo, 1, "p1", 1)

		if err := svc.UpdateAllPostCounts(ctx); err != nil {
			t.Fatalf("UpdateAllPostCounts: %v", err)
		}
		tag, err := svc.GetTagByID(ctx, 1)
		if err != nil {
			t.Fatalf("GetTagByID: %v", err)
		}
		if tag.PostCount != 1 {
			t.Errorf("post_count = %d, want the stale 99 recomputed to 1", tag.PostCount)
		}
	})

	t.Run("a repository failure is surfaced", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `DROP TABLE tags`)

		if err := svc.UpdateAllPostCounts(ctx); err == nil {
			t.Error("UpdateAllPostCounts with no tags table: expected an error")
		}
		if _, err := svc.GetHierarchicalPostCounts(ctx, true); err == nil {
			t.Error("GetHierarchicalPostCounts with no tags table: expected an error")
		}
	})
}

func TestTagService_GetTagCloud_Filters(t *testing.T) {
	ctx := context.Background()

	t.Run("no tags at all", func(t *testing.T) {
		svc := NewTagService(tagRepo(t))
		got, err := svc.GetTagCloud(ctx, 0, false, 0)
		if err != nil || len(got) != 0 {
			t.Errorf("GetTagCloud on an empty database = (%v, %v)", got, err)
		}
	})

	t.Run("every candidate hidden", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug,hidden) VALUES (1,'H','h',1)`)
		seedPost(t, repo, 1, "p1", 1)

		got, err := svc.GetTagCloud(ctx, 0, true, 0)
		if err != nil || len(got) != 0 {
			t.Errorf("GetTagCloud(public) with only hidden tags = (%v, %v), want empty", got, err)
		}
	})

	t.Run("nothing meets the threshold", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'T','t')`)

		got, err := svc.GetTagCloud(ctx, 0, false, 0)
		if err != nil || len(got) != 0 {
			t.Errorf("GetTagCloud with no posts = (%v, %v), want empty", got, err)
		}
	})

	t.Run("limit truncates and weights are relative to the maximum", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'Alpha','alpha'),(2,'Beta','beta')`)
		seedPost(t, repo, 1, "p1", 1, 2)
		seedPost(t, repo, 2, "p2", 1)

		full, err := svc.GetTagCloud(ctx, 0, false, 0)
		if err != nil {
			t.Fatalf("GetTagCloud: %v", err)
		}
		if len(full) != 2 {
			t.Fatalf("GetTagCloud returned %d items, want 2", len(full))
		}
		for _, item := range full {
			if item.Count == 2 && item.Weight != 1 {
				t.Errorf("the busiest tag has weight %v, want 1", item.Weight)
			}
			if item.Count == 1 && item.Weight != 0.5 {
				t.Errorf("a half-as-busy tag has weight %v, want 0.5", item.Weight)
			}
		}

		limited, err := svc.GetTagCloud(ctx, 1, false, 0)
		if err != nil || len(limited) != 1 {
			t.Errorf("GetTagCloud(limit=1) returned %d items (%v)", len(limited), err)
		}
	})

	t.Run("a failed tag list is surfaced", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `DROP TABLE tags`)

		if _, err := svc.GetTagCloud(ctx, 0, false, 0); err == nil {
			t.Error("GetTagCloud with no tags table: expected an error")
		}
	})

	t.Run("a failed graph build is surfaced on the public path", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'T','t')`)
		// Listing tags still works; assembling the graph to resolve visibility
		// does not.
		mustExec(t, repo, `DROP TABLE tag_relationships`)

		if _, err := svc.GetTagCloud(ctx, 0, true, 0); err == nil {
			t.Error("GetTagCloud(public) with no tag_relationships table: expected an error")
		}
	})
}

// ── posts by tag ────────────────────────────────────────────────────────────

func TestTagService_GetPostsByTag(t *testing.T) {
	ctx := context.Background()

	// seed builds parent -> child with one post on each, in different years.
	seed := func(t *testing.T) repository.Repository {
		repo := tagRepo(t)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'Parent','parent'),(2,'Child','child')`)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug,kind) VALUES (10,'2011','2011','year'),(11,'2020','2020','year')`)
		mustExec(t, repo, `INSERT INTO tag_relationships (parent_id,child_id) VALUES (1,2)`)
		seedPost(t, repo, 1, "old", 1, 10)
		seedPost(t, repo, 2, "new", 2, 11)
		return repo
	}

	t.Run("a parent page includes descendant posts", func(t *testing.T) {
		svc := NewTagService(seed(t))
		posts, total, err := svc.GetPostsByTag(ctx, 1, 1, 10, true, false, 0, 0)
		if err != nil {
			t.Fatalf("GetPostsByTag: %v", err)
		}
		if total != 2 || len(posts) != 2 {
			t.Errorf("GetPostsByTag(parent) = %d posts / total %d, want 2 and 2", len(posts), total)
		}
	})

	t.Run("a year range filters both the page and the total", func(t *testing.T) {
		svc := NewTagService(seed(t))
		posts, total, err := svc.GetPostsByTag(ctx, 1, 1, 10, true, false, 2020, 2021)
		if err != nil {
			t.Fatalf("GetPostsByTag: %v", err)
		}
		if total != 1 || len(posts) != 1 || posts[0].Slug != "new" {
			t.Errorf("GetPostsByTag(2020-2021) = %d posts / total %d, want just the 2020 post", len(posts), total)
		}
	})

	t.Run("an inverted year range is ignored", func(t *testing.T) {
		svc := NewTagService(seed(t))
		_, total, err := svc.GetPostsByTag(ctx, 1, 1, 10, true, false, 2021, 2020)
		if err != nil {
			t.Fatalf("GetPostsByTag: %v", err)
		}
		if total != 2 {
			t.Errorf("total = %d, want the bad range to fall back to no filter", total)
		}
	})

	t.Run("failures in either query are surfaced", func(t *testing.T) {
		for _, tc := range []struct {
			name             string
			method           string
			yearFrom, yearTo int
		}{
			{"page query", "GetPostsByTagIDsInYearRange", 2020, 2021},
			{"count query, year range", "CountPostsByTagIDsInYearRange", 2020, 2021},
			{"count query, no range", "CountPostsByTagIDs", 0, 0},
		} {
			t.Run(tc.name, func(t *testing.T) {
				svc := failing(seed(t), tc.method)
				if _, _, err := svc.GetPostsByTag(ctx, 1, 1, 10, true, false, tc.yearFrom, tc.yearTo); !errors.Is(err, errRepoBoom) {
					t.Errorf("GetPostsByTag with %s failing = %v, want errRepoBoom", tc.method, err)
				}
			})
		}
	})

	t.Run("a failed page query without a year range is surfaced", func(t *testing.T) {
		repo := seed(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `DROP TABLE posts`)

		if _, _, err := svc.GetPostsByTag(ctx, 1, 1, 10, true, false, 0, 0); err == nil {
			t.Error("GetPostsByTag with no posts table: expected an error")
		}
	})
}

// ── hierarchy writes ────────────────────────────────────────────────────────

func TestTagService_AddTagRelationship_Errors(t *testing.T) {
	ctx := context.Background()

	t.Run("a cycle is refused", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'A','a'),(2,'B','b')`)
		if err := svc.AddTagRelationship(ctx, 1, 2); err != nil {
			t.Fatalf("AddTagRelationship: %v", err)
		}
		if err := svc.AddTagRelationship(ctx, 2, 1); err == nil {
			t.Error("adding the reverse edge: expected a cycle error")
		}
	})

	t.Run("an unknown child fails cycle detection", func(t *testing.T) {
		repo := tagRepo(t)
		svc := NewTagService(repo)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'A','a')`)

		if err := svc.AddTagRelationship(ctx, 1, 404); err == nil {
			t.Error("AddTagRelationship with an unknown child: expected an error")
		}
	})

	t.Run("a failed child walk fails cycle detection", func(t *testing.T) {
		repo := tagRepo(t)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'A','a'),(2,'B','b')`)
		svc := failing(repo, "GetTagChildren")

		if err := svc.AddTagRelationship(ctx, 1, 2); !errors.Is(err, errRepoBoom) {
			t.Errorf("AddTagRelationship = %v, want errRepoBoom from the descendant walk", err)
		}
	})

	t.Run("a failed insert is surfaced", func(t *testing.T) {
		repo := tagRepo(t)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'A','a'),(2,'B','b')`)
		svc := failing(repo, "AddTagRelationship")

		if err := svc.AddTagRelationship(ctx, 1, 2); !errors.Is(err, errRepoBoom) {
			t.Errorf("AddTagRelationship = %v, want errRepoBoom from the insert", err)
		}
	})
}

func TestTagService_ReorderTag_Errors(t *testing.T) {
	ctx := context.Background()

	// three siblings under one parent, plus an outsider under another parent
	seed := func(t *testing.T) repository.Repository {
		repo := tagRepo(t)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'P','p'),(2,'A','a'),(3,'B','b'),(4,'C','c'),(5,'Q','q'),(6,'Out','out')`)
		mustExec(t, repo, `INSERT INTO tag_relationships (parent_id,child_id,sort_order) VALUES (1,2,10),(1,3,20),(1,4,30),(5,6,10)`)
		return repo
	}

	t.Run("an invalid position is rejected", func(t *testing.T) {
		svc := NewTagService(seed(t))
		if err := svc.ReorderTag(ctx, ReorderTagParams{ID: 2, Position: "sideways"}); err == nil {
			t.Error("ReorderTag with a bad position: expected an error")
		}
	})

	t.Run("an unknown tag is rejected", func(t *testing.T) {
		svc := NewTagService(seed(t))
		if err := svc.ReorderTag(ctx, ReorderTagParams{ID: 404, Position: "before"}); err == nil {
			t.Error("ReorderTag on an unknown tag: expected an error")
		}
	})

	t.Run("a failed sibling read is surfaced", func(t *testing.T) {
		parent := int64(1)
		svc := failing(seed(t), "GetChildrenOfTag")
		if err := svc.ReorderTag(ctx, ReorderTagParams{ID: 2, Position: "before", ParentID: &parent}); !errors.Is(err, errRepoBoom) {
			t.Errorf("ReorderTag = %v, want errRepoBoom from the sibling read", err)
		}
	})

	t.Run("a failed root read is surfaced", func(t *testing.T) {
		svc := failing(seed(t), "GetRootTags")
		if err := svc.ReorderTag(ctx, ReorderTagParams{ID: 2, Position: "before"}); !errors.Is(err, errRepoBoom) {
			t.Errorf("ReorderTag at root level = %v, want errRepoBoom", err)
		}
	})

	t.Run("a failed reparent on a cross-hierarchy move is surfaced", func(t *testing.T) {
		parent := int64(1)
		// Tag 6 lives under parent 5, so reordering it into parent 1 has to
		// reparent it first — and that is the call that fails.
		svc := failing(seed(t), "ClearTagParents")
		err := svc.ReorderTag(ctx, ReorderTagParams{ID: 6, Position: "before", ParentID: &parent})
		if !errors.Is(err, errRepoBoom) {
			t.Errorf("ReorderTag across hierarchies = %v, want errRepoBoom from the reparent", err)
		}
	})

	t.Run("a failed sort-order write is surfaced", func(t *testing.T) {
		parent := int64(1)
		svc := failing(seed(t), "UpdateTagSortOrder")
		if err := svc.ReorderTag(ctx, ReorderTagParams{ID: 2, Position: "before", ParentID: &parent}); !errors.Is(err, errRepoBoom) {
			t.Errorf("ReorderTag = %v, want errRepoBoom from the sort-order write", err)
		}
	})

	t.Run("a cross-hierarchy move reparents and renumbers", func(t *testing.T) {
		repo := seed(t)
		svc := NewTagService(repo)
		parent, target := int64(1), int64(3)

		if err := svc.ReorderTag(ctx, ReorderTagParams{ID: 6, TargetID: &target, Position: "after", ParentID: &parent}); err != nil {
			t.Fatalf("ReorderTag: %v", err)
		}
		kids, err := repo.GetChildrenOfTag(ctx, 1)
		if err != nil {
			t.Fatalf("GetChildrenOfTag: %v", err)
		}
		if names := tagNames(kids); len(names) != 4 || names[2] != "Out" {
			t.Errorf("children of P = %v, want Out inserted after B", names)
		}
	})
}

func TestTagService_MoveTag_Errors(t *testing.T) {
	ctx := context.Background()

	seed := func(t *testing.T) repository.Repository {
		repo := tagRepo(t)
		mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'P','p'),(2,'A','a'),(3,'B','b'),(4,'Loose','loose')`)
		mustExec(t, repo, `INSERT INTO tag_relationships (parent_id,child_id,sort_order) VALUES (1,2,10),(1,3,20)`)
		return repo
	}

	t.Run("an unknown tag is not found", func(t *testing.T) {
		svc := NewTagService(seed(t))
		if err := svc.MoveTag(ctx, MoveTagParams{ID: 404, ParentID: 1}); !errors.Is(err, ErrTagNotFound) {
			t.Errorf("MoveTag(unknown) = %v, want ErrTagNotFound", err)
		}
	})

	t.Run("a tag outside the parent is refused", func(t *testing.T) {
		svc := NewTagService(seed(t))
		if err := svc.MoveTag(ctx, MoveTagParams{ID: 4, ParentID: 1}); !errors.Is(err, ErrTagNotAChild) {
			t.Errorf("MoveTag on a non-child = %v, want ErrTagNotAChild", err)
		}
	})

	t.Run("a failed sibling read is surfaced", func(t *testing.T) {
		svc := failing(seed(t), "GetChildrenOfTag")
		if err := svc.MoveTag(ctx, MoveTagParams{ID: 2, ParentID: 1}); !errors.Is(err, errRepoBoom) {
			t.Errorf("MoveTag = %v, want errRepoBoom from the sibling read", err)
		}
	})

	t.Run("a failed edge write is surfaced", func(t *testing.T) {
		svc := failing(seed(t), "UpdateEdgeSortOrder")
		if err := svc.MoveTag(ctx, MoveTagParams{ID: 2, ParentID: 1}); !errors.Is(err, errRepoBoom) {
			t.Errorf("MoveTag = %v, want errRepoBoom from the edge write", err)
		}
	})

	t.Run("moving to the front and after a sibling", func(t *testing.T) {
		repo := seed(t)
		svc := NewTagService(repo)

		if err := svc.MoveTag(ctx, MoveTagParams{ID: 3, ParentID: 1}); err != nil {
			t.Fatalf("MoveTag to front: %v", err)
		}
		kids, _ := repo.GetChildrenOfTag(ctx, 1)
		if names := tagNames(kids); len(names) != 2 || names[0] != "B" {
			t.Fatalf("children = %v, want B moved to the front", names)
		}

		after := int64(2)
		if err := svc.MoveTag(ctx, MoveTagParams{ID: 3, ParentID: 1, AfterID: &after}); err != nil {
			t.Fatalf("MoveTag after: %v", err)
		}
		kids, _ = repo.GetChildrenOfTag(ctx, 1)
		if names := tagNames(kids); len(names) != 2 || names[0] != "A" {
			t.Errorf("children = %v, want B moved back behind A", names)
		}
	})
}

func TestTagService_GetAllTagRelationships(t *testing.T) {
	ctx := context.Background()
	repo := tagRepo(t)
	svc := NewTagService(repo)
	mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'P','p'),(2,'C','c')`)
	mustExec(t, repo, `INSERT INTO tag_relationships (parent_id,child_id) VALUES (1,2)`)

	rels, err := svc.GetAllTagRelationships(ctx)
	if err != nil {
		t.Fatalf("GetAllTagRelationships: %v", err)
	}
	if len(rels) != 1 || rels[0].ParentID != 1 || rels[0].ChildID != 2 {
		t.Errorf("relationships = %+v, want the single 1->2 edge", rels)
	}
}

func TestTagService_SetTagParentsAndChildren_Replace(t *testing.T) {
	ctx := context.Background()
	repo := tagRepo(t)
	svc := NewTagService(repo)
	mustExec(t, repo, `INSERT INTO tags (id,name,slug) VALUES (1,'P1','p1'),(2,'P2','p2'),(3,'T','t'),(4,'C','c')`)

	if err := svc.SetTagParents(ctx, 3, []int64{1, 2}); err != nil {
		t.Fatalf("SetTagParents: %v", err)
	}
	parents, err := svc.GetTagParents(ctx, 3)
	if err != nil {
		t.Fatalf("GetTagParents: %v", err)
	}
	if names := tagNames(parents); len(names) != 2 {
		t.Fatalf("parents = %v, want both", names)
	}

	// Replacing with a single parent must drop the other edge.
	if err := svc.SetTagParents(ctx, 3, []int64{1}); err != nil {
		t.Fatalf("SetTagParents: %v", err)
	}
	if parents, _ := svc.GetTagParents(ctx, 3); len(parents) != 1 {
		t.Errorf("parents = %v, want the replaced set", tagNames(parents))
	}

	if err := svc.SetTagChildren(ctx, 3, []int64{4}); err != nil {
		t.Fatalf("SetTagChildren: %v", err)
	}
	kids, err := svc.GetTagChildren(ctx, 3, false, 0)
	if err != nil {
		t.Fatalf("GetTagChildren: %v", err)
	}
	if names := tagNames(kids); len(names) != 1 || names[0] != "C" {
		t.Errorf("children = %v, want [C]", names)
	}
}
