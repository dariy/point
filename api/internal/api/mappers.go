package api

import (
	"database/sql"
	"encoding/json"
	"regexp"
	"strings"

	"point-api/internal/models"
	"point-api/internal/repository"
)

var (
	// videoTagRe extracts src from <video>/<source> tags.
	// [^>]* (zero-or-more) matches even when src is the first attribute.
	videoTagRe = regexp.MustCompile(`(?i)<(?:video|source)[^>]*\ssrc="([^"]+)"`)

	// markdownImageRe matches standard markdown image syntax ![alt](url).
	markdownImageRe = regexp.MustCompile(`!\[.*\]\(([^)]+)\)`)

	// bareMediaRe matches a line containing only a media file path or URL.
	bareMediaRe = regexp.MustCompile(`(?im)^[ \t]*((?:https?://|/)\S+\.(?:mp4|webm|mov|ogv|m4v|avi|mkv|mp3|m4a|ogg|wav|flac|aac|opus|jpg|jpeg|png|gif|webp|svg))[ \t]*$`)
)

// extractMediaURL returns a single preview URL for list responses:
// thumbnail path if set, else first markdown image URL, else first video/audio src from a <video>/<source>
// tag in the content, else first bare media path found in the content.
func extractMediaURL(thumbPath sql.NullString, content string) *string {
	var rawURL string
	if thumbPath.Valid && thumbPath.String != "" {
		rawURL = thumbPath.String
	} else if m := markdownImageRe.FindStringSubmatch(content); m != nil {
		rawURL = m[1]
	} else if m := videoTagRe.FindStringSubmatch(content); m != nil {
		rawURL = m[1]
	} else if m := bareMediaRe.FindStringSubmatch(content); m != nil {
		rawURL = m[1]
	} else {
		return nil
	}

	// Normalize: strip /media/originals/ or originals/ to return the simplified path
	normalized := rawURL
	normalized = strings.TrimPrefix(normalized, "/media/originals/")
	normalized = strings.TrimPrefix(normalized, "originals/")
	if !strings.HasPrefix(normalized, "http") && !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	return &normalized
}

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

func postToResponse(p models.Post, tags []repository.PostTagInfo) map[string]interface{} {
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
		"content":             p.Content,
		"excerpt":             nullString(p.Excerpt),
		"formatter":           p.Formatter,
		"status":              p.Status,
		"is_featured":         p.IsFeatured,
		"view_count":          p.ViewCount,
		"published_at":        nullTime(p.PublishedAt),
		"created_at":          p.CreatedAt,
		"updated_at":          p.UpdatedAt,
		"media_url":           extractMediaURL(p.ThumbnailPath, p.Content),
		"meta_description":    nullString(p.MetaDescription),
		"tags":                tagObjs,
	}
}

func tagToListItem(t models.Tag) map[string]interface{} {
	return map[string]interface{}{
		"id":         t.ID,
		"name":       t.Name,
		"slug":       t.Slug,
		"sort_order": nullInt64(t.SortOrder),
		"post_count": t.PostCount,
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
		"id":          t.ID,
		"name":        t.Name,
		"slug":        t.Slug,
		"description": nullString(t.Description),
		"custom_url":  nullString(t.CustomUrl),
		"sort_order": nullInt64(t.SortOrder),
		"post_count": t.PostCount,
		"created_at": t.CreatedAt,
		"parents":     parentItems,
		"children":    childItems,
		"locations":   tagLocationsResponse(loc),
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
				tagList[i]["is_hidden_posts"] = effectiveHiddenPostsTagIDs[t.ID]
			}
		}
	}
}

// injectPostHiddenFieldsFromInfo adds is_hidden/is_hidden_by_tag for list endpoints using PostTagInfo.
// It also adds is_hidden_posts to each tag object in resp["tags"].
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
				tagList[i]["is_hidden_posts"] = effectiveHiddenPostsTagIDs[t.ID]
			}
		}
	}
}

// injectTagHiddenFields adds is_hidden_posts to a tag response map for admin users.
// is_hidden_posts reflects effective inheritance: true if the tag or any ancestor effectively hides posts.
func injectTagHiddenFields(resp map[string]interface{}, t models.Tag, effectiveHiddenPostsTagIDs map[int64]bool) {
	resp["is_hidden_posts"] = effectiveHiddenPostsTagIDs[t.ID]
}

// mediaToResponse converts a Medium model into an API response map with
// normalised URL fields:
//
//	path          = "/<year>/<month>/<filename>"          (e.g. /2026/02/photo.jpg)
//	original_path = "/media/originals/<year>/<month>/…"
//	thumbnail_path = "/media/thumbnails/<year>/<month>/…"  (nil when absent)
//
// The DB stores relative paths without a leading slash
// ("originals/YYYY/MM/file"), so we strip the prefix and prepend the
// canonical web root.
func mediaToResponse(m models.Medium) map[string]interface{} {
	// mediaPath is the public-facing simplified URL, e.g. "/2026/03/ts_file.jpg"
	mediaPath := "/" + strings.TrimPrefix(m.OriginalPath, "originals/")

	var thumbPath interface{}
	if m.ThumbnailPath.Valid {
		// Thumbnail served via the same route with ?thumb query parameter.
		thumbPath = mediaPath + "?thumb"
	}

	var metadata map[string]interface{}
	if m.Metadata.Valid && m.Metadata.String != "" {
		_ = json.Unmarshal([]byte(m.Metadata.String), &metadata)
	}

	return map[string]interface{}{
		"id":             m.ID,
		"filename":       m.Filename,
		"path":           mediaPath,
		"thumbnail_path": thumbPath,
		"file_type":      strings.ToLower(m.FileType),
		"mime_type":      m.MimeType,
		"file_size":      m.FileSize,
		"width":          nullInt64(m.Width),
		"height":         nullInt64(m.Height),
		"post_id":        nullInt64(m.PostID),
		"uploaded_at":    m.UploadedAt,
		"alt_text":       nullString(m.AltText),
		"caption":        nullString(m.Caption),
		"metadata":       metadata,
		"is_public":      m.IsPublic,
	}
}
