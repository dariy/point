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
		"tags":                postTagsOrEmpty(tags),
	}
}

func postByTagToResponse(p models.GetPostsByTagRow, tags []repository.PostTagInfo) map[string]interface{} {
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
		"tags":                postTagsOrEmpty(tags),
	}
}

func tagToListItem(t models.Tag) map[string]interface{} {
	return map[string]interface{}{
		"id":                     t.ID,
		"name":                   t.Name,
		"slug":                   t.Slug,
		"is_important":           t.IsImportant,
		"is_hidden":              t.IsHidden,
		"is_hidden_posts":        t.IsHiddenPosts,
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
		"is_hidden":                     t.IsHidden,
		"is_hidden_posts":               t.IsHiddenPosts,
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
