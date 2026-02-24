package api

import (
	"database/sql"
	"point-api/internal/models"
	"point-api/internal/repository"
)

func nullString(s sql.NullString) *string {
	if s.Valid {
		return &s.String
	}
	return nil
}

func nullTime(t sql.NullTime) *interface{} {
	if t.Valid {
		var val interface{} = t.Time
		return &val
	}
	return nil
}

func nullInt64(i sql.NullInt64) *int64 {
	if i.Valid {
		return &i.Int64
	}
	return nil
}

func nullFloat64(f sql.NullFloat64) *float64 {
	if f.Valid {
		return &f.Float64
	}
	return nil
}

func postTagsOrEmpty(tags []repository.PostTagInfo) []repository.PostTagInfo {
	if tags == nil {
		return []repository.PostTagInfo{}
	}
	return tags
}

func postToResponse(p models.ListPostsRow, tags []repository.PostTagInfo) map[string]interface{} {
	tagObjs := make([]map[string]interface{}, 0, len(tags))
	for _, t := range tags {
		tagObjs = append(tagObjs, map[string]interface{}{
			"name": t.Name,
			"slug": t.Slug,
		})
	}

	return map[string]interface{}{
		"id":                  p.ID,
		"title":               p.Title,
		"slug":                p.Slug,
		"excerpt":             nullString(p.Excerpt),
		"formatter":           p.Formatter,
		"status":              p.Status,
		"is_featured":         p.IsFeatured,
		"view_count":          p.ViewCount,
		"published_at":        nullTime(p.PublishedAt),
		"created_at":          p.CreatedAt,
		"updated_at":          p.UpdatedAt,
		"author_id":           p.AuthorID,
		"thumbnail_path":      nullString(p.ThumbnailPath),
		"meta_description":    nullString(p.MetaDescription),
		"author_username":     p.AuthorUsername,
		"author_display_name": p.AuthorDisplayName,
		"author_avatar":       nullString(p.AuthorAvatar),
		"tags":                tagObjs,
	}
}

func postByTagToResponse(p models.GetPostsByTagRow, tags []repository.PostTagInfo) map[string]interface{} {
	tagObjs := make([]map[string]interface{}, 0, len(tags))
	for _, t := range tags {
		tagObjs = append(tagObjs, map[string]interface{}{
			"name": t.Name,
			"slug": t.Slug,
		})
	}

	return map[string]interface{}{
		"id":                  p.ID,
		"title":               p.Title,
		"slug":                p.Slug,
		"excerpt":             nullString(p.Excerpt),
		"formatter":           p.Formatter,
		"status":              p.Status,
		"is_featured":         p.IsFeatured,
		"view_count":          p.ViewCount,
		"published_at":        nullTime(p.PublishedAt),
		"created_at":          p.CreatedAt,
		"updated_at":          p.UpdatedAt,
		"author_id":           p.AuthorID,
		"thumbnail_path":      nullString(p.ThumbnailPath),
		"meta_description":    nullString(p.MetaDescription),
		"author_username":     p.AuthorUsername,
		"author_display_name": p.AuthorDisplayName,
		"author_avatar":       nullString(p.AuthorAvatar),
		"tags":                tagObjs,
	}
}

func tagToListItem(t models.Tag) map[string]interface{} {
	return map[string]interface{}{
		"id":                     t.ID,
		"name":                   t.Name,
		"slug":                   t.Slug,
		"is_important":           t.IsImportant,
		"include_in_breadcrumbs": t.IncludeInBreadcrumbs,
		"sort_order":             nullInt64(t.SortOrder),
		"post_count":             t.PostCount,
	}
}

func tagLocationsResponse(loc *models.TagLocation) []map[string]interface{} {
	if loc == nil {
		return []map[string]interface{}{}
	}
	return []map[string]interface{}{
		{"id": loc.ID, "latitude": loc.Latitude, "longitude": loc.Longitude},
	}
}

func tagToFullResponse(t models.Tag, parents, children []models.Tag, loc *models.TagLocation) map[string]interface{} {
	parentItems := make([]map[string]interface{}, len(parents))
	for i, p := range parents {
		parentItems[i] = tagToListItem(p)
	}
	childItems := make([]map[string]interface{}, len(children))
	for i, ch := range children {
		childItems[i] = tagToListItem(ch)
	}

	return map[string]interface{}{
		"id":                            t.ID,
		"name":                          t.Name,
		"slug":                          t.Slug,
		"description":                   nullString(t.Description),
		"custom_url":                    nullString(t.CustomUrl),
		"is_important":                  t.IsImportant,
		"is_featured":                   t.IsFeatured,
		"include_in_breadcrumbs":        t.IncludeInBreadcrumbs,
		"show_related_tags_as_children": t.ShowRelatedTagsAsChildren,
		"sort_order":                    nullInt64(t.SortOrder),
		"post_count":                    t.PostCount,
		"created_at":                    t.CreatedAt,
		"parents":                       parentItems,
		"children":                      childItems,
		"locations":                     tagLocationsResponse(loc),
	}
}

// injectPostHiddenFields adds is_hidden/is_hidden_by_tag to a post response map for admin users.
// It also adds is_hidden to each tag object in resp["tags"].
// effectiveHiddenPostsTagIDs is the set of tag IDs that effectively hide their posts (including inherited).
func injectPostHiddenFields(resp map[string]interface{}, status string, tags []models.Tag, effectiveHiddenPostsTagIDs map[int64]bool) {
	isHiddenByTag := false
	for _, t := range tags {
		if effectiveHiddenPostsTagIDs[t.ID] {
			isHiddenByTag = true
		}
	}
	resp["is_hidden"] = status == "hidden"
	resp["is_hidden_by_tag"] = isHiddenByTag

	if tagList, ok := resp["tags"].([]map[string]interface{}); ok {
		for i, t := range tags {
			if i < len(tagList) {
				tagList[i]["is_hidden"] = t.IsHidden
			}
		}
	}
}

// injectPostHiddenFieldsFromInfo adds is_hidden/is_hidden_by_tag for list endpoints using PostTagInfo.
// It also adds is_hidden to each tag object in resp["tags"].
func injectPostHiddenFieldsFromInfo(resp map[string]interface{}, status string, tags []repository.PostTagInfo, effectiveHiddenPostsTagIDs map[int64]bool) {
	isHiddenByTag := false
	for _, t := range tags {
		if effectiveHiddenPostsTagIDs[t.ID] {
			isHiddenByTag = true
		}
	}
	resp["is_hidden"] = status == "hidden"
	resp["is_hidden_by_tag"] = isHiddenByTag

	if tagList, ok := resp["tags"].([]map[string]interface{}); ok {
		for i, t := range tags {
			if i < len(tagList) {
				tagList[i]["is_hidden"] = t.IsHidden
			}
		}
	}
}

// injectTagHiddenFields adds is_hidden/is_hidden_posts to a tag response map for admin users.
// is_hidden_posts reflects effective inheritance: true if the tag or any ancestor has is_hidden_posts=true.
func injectTagHiddenFields(resp map[string]interface{}, t models.Tag, effectiveHiddenPostsTagIDs map[int64]bool) {
	resp["is_hidden"] = t.IsHidden
	resp["is_hidden_posts"] = t.IsHiddenPosts || effectiveHiddenPostsTagIDs[t.ID]
}
