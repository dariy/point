package services

// Post counts and the queries that hang off them: the tag cloud, the counts
// rollup, and the tag→post and post→tag lookups. Split out of tag_service.go
// because none of it is about a tag's own record — it is all about the posts
// attached to a tag, so the counts are hierarchical (a parent tag counts its
// descendants' posts) and every read is scoped by public vs. admin visibility.
//
// The counts themselves live on the graph snapshot, which is where the
// descendant rollup happens; this file reads them rather than computing them.

import (
	"context"

	"point-api/internal/models"
	"point-api/internal/repository"
)

type TagCloudItem struct {
	ID     int64   `json:"id"`
	Name   string  `json:"name"`
	Slug   string  `json:"slug"`
	Count  int64   `json:"count"`
	Weight float64 `json:"weight"`
}

func (s *TagService) GetTagCloud(ctx context.Context, limit int, publicOnly bool, minPosts int64) ([]TagCloudItem, error) {
	tags, err := s.repo.ListTags(ctx, true)
	if err != nil {
		return nil, err
	}

	if len(tags) == 0 {
		return []TagCloudItem{}, nil
	}

	var candidates []models.Tag
	if publicOnly {
		g, err := s.getGraph(ctx)
		if err != nil {
			return nil, err
		}
		for _, t := range tags {
			if !g.EffectiveHidden[t.ID] {
				candidates = append(candidates, t)
			}
		}
	} else {
		candidates = append(candidates, tags...)
	}

	if len(candidates) == 0 {
		return []TagCloudItem{}, nil
	}

	// Fetch hierarchical counts (includes descendant posts).
	g, _ := s.getGraph(ctx)
	effectiveCounts := g.CountsAdmin
	if publicOnly {
		effectiveCounts = g.CountsPublic
	}

	var filtered []models.Tag
	threshold := minPosts
	if threshold == 0 {
		threshold = 1
	}
	for _, t := range candidates {
		if effectiveCounts[t.ID] >= threshold {
			filtered = append(filtered, t)
		}
	}

	if len(filtered) == 0 {
		return []TagCloudItem{}, nil
	}

	// Find max count for weight calculation.
	var maxCount int64
	for _, t := range filtered {
		if c := effectiveCounts[t.ID]; c > maxCount {
			maxCount = c
		}
	}

	// Limit
	if limit > 0 && len(filtered) > limit {
		filtered = filtered[:limit]
	}

	result := make([]TagCloudItem, len(filtered))
	for i, t := range filtered {
		count := effectiveCounts[t.ID]
		weight := 1.0
		if maxCount > 0 {
			weight = float64(count) / float64(maxCount)
		}
		result[i] = TagCloudItem{
			ID:     t.ID,
			Name:   t.Name,
			Slug:   t.Slug,
			Count:  count,
			Weight: weight,
		}
	}
	return result, nil
}

func (s *TagService) UpdateAllPostCounts(ctx context.Context) error {
	if err := s.repo.UpdateAllTagPostCounts(ctx); err != nil {
		return err
	}
	s.Invalidate()
	return nil
}

// GetHierarchicalPostCounts returns a map of tagID → effective post count
// including all descendant tags. publishedOnly=true for public, false for admin.
func (s *TagService) GetHierarchicalPostCounts(ctx context.Context, publishedOnly bool) (map[int64]int64, error) {
	return s.repo.GetHierarchicalPostCounts(ctx, publishedOnly)
}

func (s *TagService) GetTagsByPostIDs(ctx context.Context, postIDs []int64) (map[int64][]repository.PostTagInfo, error) {
	return s.repo.GetTagsByPostIDs(ctx, postIDs)
}

// tagWithDescendantIDs is the set of tags a tag page draws its posts from: the
// tag itself plus everything below it, so a parent tag page (e.g.
// /tags/countries) shows posts from all nested sub-tags.
func (s *TagService) tagWithDescendantIDs(ctx context.Context, tagID int64) []int64 {
	descendants, _ := s.GetTagDescendants(ctx, tagID)
	tagIDs := make([]int64, 0, 1+len(descendants))
	tagIDs = append(tagIDs, tagID)
	for _, d := range descendants {
		tagIDs = append(tagIDs, d.ID)
	}
	return tagIDs
}

func (s *TagService) GetPostsByTag(ctx context.Context, tagID int64, page, perPage int32, publicOnly bool, includeDrafts bool, yearFrom, yearTo int) ([]models.Post, int64, error) {
	tagIDs := s.tagWithDescendantIDs(ctx, tagID)

	includeHidden := !publicOnly
	offset := (page - 1) * perPage
	hasYearFilter := yearFrom > 0 && yearTo > 0 && yearFrom <= yearTo

	var posts []models.Post
	var total int64
	var err error
	if hasYearFilter {
		posts, err = s.repo.GetPostsByTagIDsInYearRange(ctx, tagIDs, yearFrom, yearTo, publicOnly, includeDrafts, includeHidden, int64(perPage), int64(offset))
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPostsByTagIDsInYearRange(ctx, tagIDs, yearFrom, yearTo, publicOnly, includeDrafts, includeHidden)
	} else {
		posts, err = s.repo.GetPostsByTagIDs(ctx, tagIDs, publicOnly, includeDrafts, includeHidden, int64(perPage), int64(offset))
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPostsByTagIDs(ctx, tagIDs, publicOnly, includeDrafts, includeHidden)
	}
	if err != nil {
		return nil, 0, err
	}

	return posts, total, nil
}

// CountPostsByTag is the total GetPostsByTag would report for the same scope
// without reading a page of rows. The tag page needs it while rendering a
// scheduled page, where the rows come from the queue but the paginator still
// has to describe the published list behind it.
func (s *TagService) CountPostsByTag(ctx context.Context, tagID int64, publicOnly bool, yearFrom, yearTo int) (int64, error) {
	tagIDs := s.tagWithDescendantIDs(ctx, tagID)
	includeHidden := !publicOnly
	if yearFrom > 0 && yearTo > 0 && yearFrom <= yearTo {
		return s.repo.CountPostsByTagIDsInYearRange(ctx, tagIDs, yearFrom, yearTo, publicOnly, false, includeHidden)
	}
	return s.repo.CountPostsByTagIDs(ctx, tagIDs, publicOnly, false, includeHidden)
}

// GetScheduledPostsByTag returns one page of this tag's publishing queue,
// soonest first — the tag page's counterpart to PostService.ListScheduledPosts,
// scoped to the same tag-plus-descendants set as GetPostsByTag. `page` is
// 1-based within the queue; the tag page maps its non-positive page numbers
// onto it (see resolveScheduledPage in api/pages.go).
func (s *TagService) GetScheduledPostsByTag(ctx context.Context, tagID int64, page, perPage int32) ([]models.Post, error) {
	if page < 1 {
		page = 1
	}
	offset := int64(page-1) * int64(perPage)
	posts, err := s.repo.ListScheduledPostsByTagIDs(ctx, s.tagWithDescendantIDs(ctx, tagID), int64(perPage), offset)
	if err != nil {
		return nil, err
	}
	if posts == nil {
		posts = []models.Post{}
	}
	return posts, nil
}

// CountScheduledPostsByTag is the tag's queue length on its own — the tag page
// needs it on every page to know how far left the reader may swipe.
func (s *TagService) CountScheduledPostsByTag(ctx context.Context, tagID int64) (int64, error) {
	return s.repo.CountScheduledPostsByTagIDs(ctx, s.tagWithDescendantIDs(ctx, tagID))
}
