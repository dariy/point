package services

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

// ImportProgress is sent via the progress callback during ImportAccount.
type ImportProgress struct {
	Total    int
	Done     int
	Imported int
	Skipped  int
	Errors   int
	Current  string // human-readable description of the item being processed
}

// ImportResult is returned when ImportAccount finishes.
type ImportResult struct {
	Imported int
	Skipped  int
	Errors   int
	Messages []string
}

// InstagramImportService orchestrates importing an entire Instagram account
// into Point as draft posts.
type InstagramImportService struct {
	ig          *InstagramService
	media       *MediaService
	postService *PostService
	httpClient  *http.Client
}

func NewInstagramImportService(ig *InstagramService, media *MediaService, post *PostService) *InstagramImportService {
	return &InstagramImportService{
		ig:          ig,
		media:       media,
		postService: post,
		httpClient:  &http.Client{Timeout: 60 * time.Second},
	}
}

// downloadMediaURL fetches bytes from a CDN URL and uploads them via
// MediaService.UploadFile (which deduplicates by SHA-256 checksum).
// Returns the stored bare originalPath for use in post content.
func (s *InstagramImportService) downloadMediaURL(ctx context.Context, mediaURL, filename string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, mediaURL, nil)
	if err != nil {
		return "", fmt.Errorf("build request for %s: %w", mediaURL, err)
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("fetch %s: %w", mediaURL, err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("fetch %s: HTTP %d", mediaURL, resp.StatusCode)
	}

	content, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", mediaURL, err)
	}

	mimeType := resp.Header.Get("Content-Type")
	if idx := strings.Index(mimeType, ";"); idx != -1 {
		mimeType = mimeType[:idx]
	}
	mimeType = strings.TrimSpace(mimeType)
	if mimeType == "" {
		mimeType = "image/jpeg"
	}

	// Derive a filename if none supplied.
	if filename == "" {
		ext := filepath.Ext(resp.Request.URL.Path)
		if ext == "" {
			ext = ".jpg"
		}
		filename = fmt.Sprintf("ig_%d%s", time.Now().UnixNano(), ext)
	}

	m, err := s.media.UploadFile(ctx, UploadFileParams{
		Content:  content,
		Filename: filename,
		MimeType: mimeType,
	})
	if err != nil {
		return "", fmt.Errorf("upload %s: %w", mediaURL, err)
	}
	return m.OriginalPath, nil
}

// buildPostContent converts a list of image paths into the block-based content
// format used by PostEditPage (one IMAGE_PATH per line, wrapped in a node block).
//
// The format must match IMAGE_PATH_RE in the frontend PostEditPage:
//
//	/2025/06/originals/2025/06/...jpg
func buildPostContent(imagePaths []string) string {
	var parts []string
	for _, p := range imagePaths {
		// Strip the leading "originals/" prefix if present — the frontend expects
		// paths starting with the year.
		trimmed := strings.TrimPrefix(p, "originals/")
		parts = append(parts, "/"+trimmed)
	}
	return strings.Join(parts, "\n")
}

// splitCaption splits an Instagram caption into (title, body).
// The first line becomes the title; the remainder is the body.
func splitCaption(caption string) (title, body string) {
	caption = strings.TrimSpace(caption)
	if caption == "" {
		return "", ""
	}
	lines := strings.SplitN(caption, "\n", 2)
	title = strings.TrimSpace(lines[0])
	if len(lines) > 1 {
		body = strings.TrimSpace(lines[1])
	}
	return title, body
}

// ImportAccount imports all Instagram media items as draft posts.
// It is idempotent: items already present (by instagram_id or instagram_media_id) are skipped.
// The optional progress callback is called after each item is processed.
func (s *InstagramImportService) ImportAccount(ctx context.Context, authorID int64, progress func(ImportProgress)) (ImportResult, error) {
	// 1. Fetch all media from Instagram.
	items, err := s.ig.ListUserMedia(ctx)
	if err != nil {
		return ImportResult{}, fmt.Errorf("list user media: %w", err)
	}

	// 2. Batch dedup.
	allIDs := make([]string, len(items))
	for i, m := range items {
		allIDs[i] = m.ID
	}
	existingIDs, err := s.postService.repo.GetExistingInstagramIDs(ctx, allIDs)
	if err != nil {
		return ImportResult{}, fmt.Errorf("dedup query: %w", err)
	}
	existingSet := make(map[string]struct{}, len(existingIDs))
	for _, id := range existingIDs {
		existingSet[id] = struct{}{}
	}

	var result ImportResult
	total := len(items)

	for idx, item := range items {
		if progress != nil {
			progress(ImportProgress{
				Total:    total,
				Done:     idx,
				Imported: result.Imported,
				Skipped:  result.Skipped,
				Errors:   result.Errors,
				Current:  item.ID,
			})
		}

		// Skip already-imported items.
		if _, exists := existingSet[item.ID]; exists {
			result.Skipped++
			continue
		}

		// 3. Download media.
		var imagePaths []string
		var downloadErr error

		switch item.MediaType {
		case "CAROUSEL_ALBUM":
			for _, child := range item.Children {
				mediaURL := child.MediaURL
				if mediaURL == "" {
					mediaURL = child.ThumbnailURL
				}
				if mediaURL == "" {
					continue
				}
				p, err := s.downloadMediaURL(ctx, mediaURL, "")
				if err != nil {
					downloadErr = err
					break
				}
				imagePaths = append(imagePaths, p)
			}
		case "VIDEO":
			// Use thumbnail for video posts.
			u := item.ThumbnailURL
			if u == "" {
				u = item.MediaURL
			}
			if u != "" {
				p, err := s.downloadMediaURL(ctx, u, "")
				if err != nil {
					downloadErr = err
				} else {
					imagePaths = append(imagePaths, p)
				}
			}
		default: // IMAGE
			if item.MediaURL != "" {
				p, err := s.downloadMediaURL(ctx, item.MediaURL, "")
				if err != nil {
					downloadErr = err
				} else {
					imagePaths = append(imagePaths, p)
				}
			}
		}

		if downloadErr != nil {
			result.Errors++
			result.Messages = append(result.Messages, fmt.Sprintf("download %s: %v", item.ID, downloadErr))
			continue
		}

		// 4. Build post fields.
		title, body := splitCaption(item.Caption)
		if title == "" {
			title = fmt.Sprintf("Instagram %s", item.Timestamp.Format("2006-01-02"))
		}
		content := buildPostContent(imagePaths)
		if body != "" && content != "" {
			content = content + "\n\n" + body
		} else if body != "" {
			content = body
		}

		// 5. Create draft post.
		post, _, err := s.postService.CreatePost(ctx, CreatePostParams{
			Title:     title,
			Content:   content,
			Excerpt:   item.Permalink, // link to original post
			Status:    "draft",
			Type:      "post",
			Formatter: "markdown",
			AuthorID:  authorID,
		})
		if err != nil {
			result.Errors++
			result.Messages = append(result.Messages, fmt.Sprintf("create post for %s: %v", item.ID, err))
			continue
		}

		// 6. Store instagram_id on post for future dedup.
		if setErr := s.postService.repo.SetPostInstagramID(ctx, post.ID, item.ID); setErr != nil {
			// Non-fatal: the post was created; dedup might not catch this ID on next run.
			result.Messages = append(result.Messages, fmt.Sprintf("set instagram_id for post %d: %v", post.ID, setErr))
		}

		result.Imported++
	}

	if progress != nil {
		progress(ImportProgress{
			Total:    total,
			Done:     total,
			Imported: result.Imported,
			Skipped:  result.Skipped,
			Errors:   result.Errors,
			Current:  "done",
		})
	}

	return result, nil
}

