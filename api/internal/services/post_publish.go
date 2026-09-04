package services

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"runtime/debug"
	"strings"
	"time"

	"point-api/internal/models"
)

func (s *PostService) PublishPost(ctx context.Context, id int64) (models.Post, error) {
	post, err := s.repo.PublishPost(ctx, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return post, ErrPostNotFound
		}
		return post, err
	}
	s.onPostsChanged(ctx)
	if s.settingsService != nil && post.InstagramShare {
		enabledStr, _ := s.settingsService.GetSetting(ctx, "enable_instagram", "false")
		if enabledStr == "true" || enabledStr == "1" {
			go s.crossPostToInstagramAsync(id)
		}
	}
	return post, nil
}

// crossPostToInstagramAsync runs a cross-post in the background with its own
// timeout, logging failures and recovering panics (a panic in a raw goroutine
// would otherwise kill the server). CrossPostToInstagram also records the
// failure on the post itself via updateInstagramStatus, so the admin UI shows
// it too.
func (s *PostService) crossPostToInstagramAsync(postID int64) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("instagram cross-post panicked",
				"post_id", postID, "panic", r, "stack", string(debug.Stack()))
			s.health.Record(healthTaskInstagramCrossPost, fmt.Errorf("panic: %v", r))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()
	err := s.CrossPostToInstagram(ctx, postID)
	s.health.Record(healthTaskInstagramCrossPost, err)
	if err != nil {
		slog.Error("instagram cross-post failed", "post_id", postID, "error", err)
	}
}

func (s *PostService) WithdrawPost(ctx context.Context, id int64) (models.Post, error) {
	post, err := s.repo.WithdrawPost(ctx, id)
	if err == nil {
		s.onPostsChanged(ctx)
	}
	return post, err
}

func (s *PostService) PublishDueScheduledPosts(ctx context.Context) ([]models.Post, error) {
	published, err := s.repo.BulkPublishScheduledPosts(ctx)
	if err != nil {
		return nil, err
	}
	if len(published) > 0 {
		s.onPostsChanged(ctx)
		slog.Info("scheduled publishing: published posts", "count", len(published))
		if s.settingsService != nil {
			enabledStr, _ := s.settingsService.GetSetting(ctx, "enable_instagram", "false")
			if enabledStr == "true" || enabledStr == "1" {
				for _, p := range published {
					if p.InstagramShare {
						go s.crossPostToInstagramAsync(p.ID)
					}
				}
			}
		}
	}
	return published, nil
}

// CrossPostToInstagram publishes a post's images to Instagram if enabled.
// It resolves absolute image URLs using APP_URL and builds a caption from a template.
func (s *PostService) CrossPostToInstagram(ctx context.Context, postID int64) error {
	post, err := s.repo.GetPost(ctx, postID)
	if err != nil {
		return err
	}

	if !post.InstagramShare {
		return nil
	}

	// 1. Validate APP_URL
	appURL := s.appURL
	if appURL == "" || strings.Contains(appURL, "localhost") {
		_ = s.updateInstagramStatus(ctx, post.ID, "error", "", "APP_URL not configured or not public")
		return fmt.Errorf("instagram: APP_URL not public or empty")
	}

	// 2. Get images referenced in post content (by path, not post_id FK).
	// A :::{.carousel-block}, when present, IS the Instagram carousel: its
	// slides in order, and none of the post's other loose photos
	// (docs/features/carousel-studio.md, bead C8).
	paths := ExtractMediaPaths(post.Content, "")
	if slides := carouselBlockPaths(post.Content); len(slides) > 0 {
		paths = slides
	}
	media, err := s.repo.GetMediaByPaths(ctx, paths)
	if err != nil {
		return err
	}

	images := orderImagesByPaths(media, paths)

	if len(images) == 0 {
		_ = s.updateInstagramStatus(ctx, post.ID, "error", "", "Post has no images")
		return fmt.Errorf("instagram: post has no images")
	}

	// mediaURL converts a DB original_path ("originals/YYYY/MM/file") to a public URL.
	mediaURL := func(orig string) string {
		return appURL + strings.TrimPrefix(orig, "originals")
	}

	// 3. Build caption from template.
	template, _ := s.settingsService.GetSetting(ctx, "instagram_caption_template", "{title}\n\n{excerpt}\n\n{tags}\n\n{link}")
	caption := s.expandCaptionTemplate(ctx, template, post, appURL)

	// 4. Create and publish containers.
	var creationID string
	if len(images) == 1 {
		creationID, err = s.instagramService.CreateImageContainer(ctx, mediaURL(images[0].OriginalPath), caption)
		if err == nil {
			err = s.instagramService.WaitForContainerReady(ctx, creationID)
		}
	} else {
		if len(images) > 20 {
			images = images[:20]
		}
		var childIDs []string
		for _, img := range images {
			childID, err := s.instagramService.CreateCarouselChild(ctx, mediaURL(img.OriginalPath))
			if err != nil {
				_ = s.updateInstagramStatus(ctx, post.ID, "error", "", err.Error())
				return err
			}
			if err := s.instagramService.WaitForContainerReady(ctx, childID); err != nil {
				_ = s.updateInstagramStatus(ctx, post.ID, "error", "", err.Error())
				return err
			}
			childIDs = append(childIDs, childID)
		}
		creationID, err = s.instagramService.CreateCarousel(ctx, childIDs, caption)
		if err == nil {
			err = s.instagramService.WaitForContainerReady(ctx, creationID)
		}
	}

	if err != nil {
		_ = s.updateInstagramStatus(ctx, post.ID, "error", "", err.Error())
		return err
	}

	mediaID, err := s.instagramService.PublishContainer(ctx, creationID)
	if err != nil {
		_ = s.updateInstagramStatus(ctx, post.ID, "error", "", err.Error())
		return err
	}

	return s.updateInstagramStatus(ctx, post.ID, "published", mediaID, "")
}

// carouselBlockRe matches the first :::{.carousel-block} fence in post content.
// (?s) lets . span newlines; the match is non-greedy to the first closing :::,
// which a bare slide path can never contain.
var carouselBlockRe = regexp.MustCompile(`(?s):::\{\.carousel-block\}\n(.*?)\n:::`)

// carouselBlockPaths returns the media paths inside a post's :::{.carousel-block}
// fence — in fence order, in the DB "originals/YYYY/MM/file" form — or nil when
// the post has no carousel block. Callers use its non-emptiness to mean "this
// post's Instagram carousel is exactly these slides".
func carouselBlockPaths(content string) []string {
	m := carouselBlockRe.FindStringSubmatch(content)
	if m == nil {
		return nil
	}
	return ExtractMediaPaths(m[1], "")
}

// orderImagesByPaths filters media down to images and returns them in the
// order their original_path appears in paths. GetMediaByPaths makes no
// ordering promise, but paths comes from ExtractMediaPaths in content order,
// which is the order the slides must appear in on Instagram.
func orderImagesByPaths(media []models.Medium, paths []string) []models.Medium {
	byPath := make(map[string]models.Medium, len(media))
	for _, m := range media {
		if imageExtRe.MatchString(m.OriginalPath) {
			byPath[m.OriginalPath] = m
		}
	}
	images := make([]models.Medium, 0, len(byPath))
	for _, p := range paths {
		if m, ok := byPath[p]; ok {
			images = append(images, m)
		}
	}
	return images
}

func (s *PostService) expandCaptionTemplate(ctx context.Context, template string, post models.Post, appURL string) string {
	res := template
	res = strings.ReplaceAll(res, "{title}", post.Title)

	excerpt := post.Excerpt.String
	res = strings.ReplaceAll(res, "{excerpt}", excerpt)

	link := fmt.Sprintf("%s/posts/%s", appURL, post.Slug)
	res = strings.ReplaceAll(res, "{link}", link)

	tags, _ := s.repo.GetTagsForPost(ctx, post.ID)
	var tagStrings []string
	for _, t := range tags {
		tagStrings = append(tagStrings, "#"+t.Name)
	}
	res = strings.ReplaceAll(res, "{tags}", strings.Join(tagStrings, " "))

	return res
}

func (s *PostService) updateInstagramStatus(ctx context.Context, postID int64, status, mediaID, errMsg string) error {
	var publishedAt sql.NullTime
	if status == "published" {
		publishedAt = sql.NullTime{Time: time.Now().UTC(), Valid: true}
	}

	return s.repo.UpdatePostInstagramStatus(ctx, models.UpdatePostInstagramStatusParams{
		ID:                   postID,
		InstagramStatus:      status,
		InstagramMediaID:     sql.NullString{String: mediaID, Valid: mediaID != ""},
		InstagramPublishedAt: publishedAt,
		InstagramError:       sql.NullString{String: errMsg, Valid: errMsg != ""},
	})
}
