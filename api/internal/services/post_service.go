package services

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"path"
	"regexp"
	"time"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/utils"

	"github.com/yuin/goldmark"
	highlighting "github.com/yuin/goldmark-highlighting/v2"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer/html"
)

type PostService struct {
	repo *repository.Repository
	md   goldmark.Markdown
}

func NewPostService(repo *repository.Repository) *PostService {
	md := goldmark.New(
		goldmark.WithExtensions(
			extension.GFM,
			extension.Typographer,
			highlighting.NewHighlighting(
				highlighting.WithStyle("monokai"),
			),
		),
		goldmark.WithParserOptions(
			parser.WithAutoHeadingID(),
		),
		goldmark.WithRendererOptions(
			html.WithHardWraps(),
			html.WithXHTML(),
		),
	)

	return &PostService{
		repo: repo,
		md:   md,
	}
}

// bareImageRe matches a line containing only a bare image path like /2026/02/file.jpg
var bareImageRe = regexp.MustCompile(`(?m)^(/\d{4}/\d{2}/\S+)$`)
var imageExtRe = regexp.MustCompile(`(?i)\.(jpg|jpeg|png|gif|webp|avif|svg|heic|heif|bmp)$`)

// markdownImageRe matches a markdown image whose src starts with /media/originals
// (legacy format written before the URL refactor). Capture group 1 is the path
// after that prefix, i.e. "/YYYY/MM/file" — the bare-path storage format.
var markdownImageRe = regexp.MustCompile(`!\[[^\]]*\]\(/media/originals(/[^)]+)\)`)

// preprocessContent expands bare image paths into markdown image syntax so
// goldmark renders them as <img> tags.
// e.g. /2026/02/photo.jpg → ![photo.jpg](/2026/02/photo.jpg)
func preprocessContent(content string) string {
	return bareImageRe.ReplaceAllStringFunc(content, func(p string) string {
		if !imageExtRe.MatchString(p) {
			return p
		}
		return fmt.Sprintf("![%s](%s)", path.Base(p), p)
	})
}

// normalizeContent converts verbose markdown image syntax back to bare paths
// before storing in the database. Handles the legacy /media/originals/… prefix
// for backward compatibility with any content saved before the URL refactor.
// e.g. ![alt](/media/originals/2026/02/photo.jpg) → /2026/02/photo.jpg
func normalizeContent(content string) string {
	return markdownImageRe.ReplaceAllString(content, "$1")
}

func (s *PostService) RenderContent(content string) (string, error) {
	var buf bytes.Buffer
	if err := s.md.Convert([]byte(preprocessContent(content)), &buf); err != nil {
		return "", err
	}
	return buf.String(), nil
}

type ListPostsParams struct {
	Page          int32
	PerPage       int32
	Status        string
	FeaturedOnly  bool
	IncludeDrafts bool
	IncludeHidden bool
	Search        string
}

func (s *PostService) ListPosts(ctx context.Context, p ListPostsParams) ([]models.ListPostsRow, int64, error) {
	offset := (p.Page - 1) * p.PerPage

	var posts []models.ListPostsRow
	var total int64
	var err error

	if p.Search != "" {
		posts, err = s.repo.ListPostsWithSearch(ctx, p.Status != "", p.Status, p.FeaturedOnly, p.IncludeDrafts, p.IncludeHidden, p.Search, int64(p.PerPage), int64(offset))
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPostsWithSearch(ctx, p.Status != "", p.Status, p.FeaturedOnly, p.IncludeDrafts, p.IncludeHidden, p.Search)
	} else {
		posts, err = s.repo.ListPosts(ctx, models.ListPostsParams{
			StatusFilter:   p.Status != "",
			Status:         p.Status,
			FeaturedFilter: p.FeaturedOnly,
			IncludeDrafts:  p.IncludeDrafts,
			Limit:          int64(p.PerPage),
			Offset:         int64(offset),
			IncludeHidden:  p.IncludeHidden,
		})
		if err != nil {
			return nil, 0, err
		}
		total, err = s.repo.CountPosts(ctx, models.CountPostsParams{
			StatusFilter:   p.Status != "",
			Status:         p.Status,
			FeaturedFilter: p.FeaturedOnly,
			IncludeDrafts:  p.IncludeDrafts,
			IncludeHidden:  p.IncludeHidden,
		})
	}
	if err != nil {
		return nil, 0, err
	}

	if posts == nil {
		posts = []models.ListPostsRow{}
	}

	return posts, total, nil
}

func (s *PostService) GetPostByID(ctx context.Context, id int64) (models.GetPostRow, error) {
	return s.repo.GetPost(ctx, id)
}

func (s *PostService) GetPostBySlug(ctx context.Context, slug string) (models.GetPostBySlugRow, error) {
	return s.repo.GetPostBySlug(ctx, slug)
}

type CreatePostParams struct {
	Title           string
	Content         string
	Excerpt         string
	Slug            string
	Formatter       string
	Status          string
	IsFeatured      bool
	AuthorID        int64
	ThumbnailPath   string
	MetaDescription string
	Tags            []string
}

func (s *PostService) CreatePost(ctx context.Context, p CreatePostParams) (models.Post, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Title)
	}

	post, err := s.repo.CreatePost(ctx, models.CreatePostParams{
		Title:           p.Title,
		Slug:            p.Slug,
		Content:         normalizeContent(p.Content),
		Excerpt:         sql.NullString{String: p.Excerpt, Valid: p.Excerpt != ""},
		Formatter:       p.Formatter,
		Status:          p.Status,
		IsFeatured:      p.IsFeatured,
		AuthorID:        p.AuthorID,
		ThumbnailPath:   sql.NullString{String: p.ThumbnailPath, Valid: p.ThumbnailPath != ""},
		MetaDescription: sql.NullString{String: p.MetaDescription, Valid: p.MetaDescription != ""},
	})
	if err != nil {
		return models.Post{}, err
	}

	// Handle tags
	for _, tagName := range p.Tags {
		// This is a bit inefficient, but standard logic: find or create tag
		tag, err := s.repo.GetTagBySlug(ctx, utils.Slugify(tagName))
		if err != nil {
			// Create tag
			tag, err = s.repo.CreateTag(ctx, models.CreateTagParams{
				Name: tagName,
				Slug: utils.Slugify(tagName),
			})
			if err != nil {
				continue
			}
		}

		_ = s.repo.AddTagToPost(ctx, models.AddTagToPostParams{
			PostID: post.ID,
			TagID:  tag.ID,
		})
	}

	// Update tag counts
	_ = s.repo.UpdateAllTagPostCounts(ctx)

	return post, nil
}

func (s *PostService) IncrementViewCount(ctx context.Context, id int64) error {
	return s.repo.IncrementPostViewCount(ctx, id)
}

func (s *PostService) GetTagsForPost(ctx context.Context, postID int64) ([]models.Tag, error) {
	return s.repo.GetTagsForPost(ctx, postID)
}

func (s *PostService) GetTagsByPostIDs(ctx context.Context, postIDs []int64) (map[int64][]repository.PostTagInfo, error) {
	return s.repo.GetTagsByPostIDs(ctx, postIDs)
}

type UpdatePostParams struct {
	ID              int64
	AuthorID        int64
	Title           string
	Content         string
	Excerpt         string
	Slug            string
	Formatter       string
	Status          string
	IsFeatured      bool
	ThumbnailPath   string
	MetaDescription string
	Tags            []string
}

func (s *PostService) UpdatePost(ctx context.Context, p UpdatePostParams) (models.Post, error) {
	if p.Slug == "" {
		p.Slug = utils.Slugify(p.Title)
	}

	post, err := s.repo.UpdatePost(ctx, models.UpdatePostParams{
		Title:           p.Title,
		Slug:            p.Slug,
		Content:         normalizeContent(p.Content),
		Excerpt:         sql.NullString{String: p.Excerpt, Valid: p.Excerpt != ""},
		Formatter:       p.Formatter,
		Status:          p.Status,
		IsFeatured:      p.IsFeatured,
		ThumbnailPath:   sql.NullString{String: p.ThumbnailPath, Valid: p.ThumbnailPath != ""},
		MetaDescription: sql.NullString{String: p.MetaDescription, Valid: p.MetaDescription != ""},
		ID:              p.ID,
		AuthorID:        p.AuthorID,
	})
	if err != nil {
		return models.Post{}, err
	}

	// Replace tags
	_ = s.repo.ClearPostTags(ctx, post.ID)
	for _, tagName := range p.Tags {
		tag, err := s.repo.GetTagBySlug(ctx, utils.Slugify(tagName))
		if err != nil {
			tag, err = s.repo.CreateTag(ctx, models.CreateTagParams{
				Name: tagName,
				Slug: utils.Slugify(tagName),
			})
			if err != nil {
				continue
			}
		}
		_ = s.repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: post.ID, TagID: tag.ID})
	}

	_ = s.repo.UpdateAllTagPostCounts(ctx)

	return post, nil
}

func (s *PostService) UpdatePostTags(ctx context.Context, postID int64, tagNames []string) error {
	// Verify the post exists.
	if _, err := s.repo.GetPost(ctx, postID); err != nil {
		return err
	}

	_ = s.repo.ClearPostTags(ctx, postID)
	for _, tagName := range tagNames {
		tag, err := s.repo.GetTagBySlug(ctx, utils.Slugify(tagName))
		if err != nil {
			tag, err = s.repo.CreateTag(ctx, models.CreateTagParams{
				Name: tagName,
				Slug: utils.Slugify(tagName),
			})
			if err != nil {
				continue
			}
		}
		_ = s.repo.AddTagToPost(ctx, models.AddTagToPostParams{PostID: postID, TagID: tag.ID})
	}

	_ = s.repo.UpdateAllTagPostCounts(ctx)
	return nil
}

func (s *PostService) DeletePost(ctx context.Context, id, authorID int64) error {
	return s.repo.DeletePost(ctx, models.DeletePostParams{ID: id, AuthorID: authorID})
}

func (s *PostService) PublishPost(ctx context.Context, id int64) (models.Post, error) {
	return s.repo.PublishPost(ctx, id)
}

func (s *PostService) WithdrawPost(ctx context.Context, id int64) (models.Post, error) {
	return s.repo.WithdrawPost(ctx, id)
}

// GeneratePreviewLink creates a preview token for a post valid for 7 days.
// Returns the plain token and expiry time.
func (s *PostService) GeneratePreviewLink(ctx context.Context, postID int64) (string, time.Time, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", time.Time{}, err
	}
	token := hex.EncodeToString(b)
	expiresAt := time.Now().Add(7 * 24 * time.Hour)

	err := s.repo.SetPostPreviewToken(ctx, models.SetPostPreviewTokenParams{
		PreviewToken:     sql.NullString{String: token, Valid: true},
		PreviewExpiresAt: sql.NullTime{Time: expiresAt, Valid: true},
		ID:               postID,
	})
	if err != nil {
		return "", time.Time{}, err
	}
	return token, expiresAt, nil
}

// GetPostByPreviewToken returns a post if the token is valid and not expired.
func (s *PostService) GetPostByPreviewToken(ctx context.Context, token string) (models.GetPostRow, error) {
	post, err := s.repo.GetPostByPreviewToken(ctx, token)
	if err != nil {
		return models.GetPostRow{}, err
	}
	// Check expiry
	if post.PreviewExpiresAt.Valid && time.Now().After(post.PreviewExpiresAt.Time) {
		return models.GetPostRow{}, sql.ErrNoRows
	}
	return post, nil
}

// GetPostNavigation returns the previous and next published posts adjacent to
// the given post, ordered by published_at.
func (s *PostService) GetPostNavigation(ctx context.Context, postID int64, publicOnly bool) (prev, next *repository.PostNavItem, err error) {
	return s.repo.GetPostNavigation(ctx, postID, publicOnly)
}
