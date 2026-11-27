package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"point-api/internal/models"
)

// Revision kinds, as stored in post_revisions.kind.
const (
	RevisionManual   = "manual"
	RevisionPublish  = "publish"
	RevisionAutosave = "autosave"
	RevisionRestore  = "restore"
)

// Save kinds a client sends with a post save (UpdatePostRequest.save_kind).
// An empty save kind is a manual save: an API client that does not know about
// revisions saves on purpose, not by a timer.
const (
	SaveKindManual = "manual"
	// SaveKindAutosave is an autosave inside an editor session. It makes no
	// revision.
	SaveKindAutosave = "autosave"
	// SaveKindAutosaveLast is the last autosave of an editor session, sent
	// when the editor closes. It makes an "autosave" revision.
	SaveKindAutosaveLast = "autosave_last"
	// SaveKindRestore is the save that RestorePostRevision makes.
	SaveKindRestore = "restore"
)

// PostRevisionLimit is how many revisions a post keeps. Publish revisions are
// kept in addition to this limit.
const PostRevisionLimit = 50

// ErrRevisionNotFound is returned when a revision does not exist for the post.
var ErrRevisionNotFound = kindSentinel(ErrNotFound, "revision not found")

// PostRevision is one saved version of a post.
type PostRevision struct {
	ID        int64     `json:"id"`
	PostID    int64     `json:"post_id"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	Tags      []string  `json:"tags"`
	CSS       string    `json:"css"`
}

// PostRevisionSummary is one row of the history list, without the body.
type PostRevisionSummary struct {
	ID        int64     `json:"id"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`
	Title     string    `json:"title"`
}

// revisionKindForSave returns the revision kind a save makes, or "" for a
// save that makes no revision. A save that moves the post to "published"
// from another status is a publish, whatever the client sent.
func revisionKindForSave(saveKind string, publishes bool) string {
	switch {
	case saveKind == SaveKindRestore:
		return RevisionRestore
	case publishes:
		return RevisionPublish
	case saveKind == SaveKindAutosave:
		return ""
	case saveKind == SaveKindAutosaveLast:
		return RevisionAutosave
	default:
		return RevisionManual
	}
}

// recordRevision stores a revision of post and prunes the post's history to
// PostRevisionLimit. A failure is logged and not returned: the save itself
// succeeded, and a missing revision must not make the editor report a failed
// save.
func (s *PostService) recordRevision(ctx context.Context, post models.Post, kind string, tags []string) {
	if kind == "" {
		return
	}
	if tags == nil {
		tags = []string{}
	}
	tagsJSON, err := json.Marshal(tags)
	if err != nil {
		tagsJSON = []byte("[]")
	}
	if _, err := s.repo.CreatePostRevision(ctx, models.CreatePostRevisionParams{
		PostID:  post.ID,
		Kind:    kind,
		Title:   post.Title,
		Content: post.Content,
		Tags:    string(tagsJSON),
		Css:     post.Css,
	}); err != nil {
		slog.Warn("could not record post revision", "post_id", post.ID, "kind", kind, "error", err)
		return
	}
	if _, err := s.repo.PrunePostRevisions(ctx, models.PrunePostRevisionsParams{
		PostID: post.ID,
		Keep:   PostRevisionLimit,
	}); err != nil {
		slog.Warn("could not prune post revisions", "post_id", post.ID, "error", err)
	}
}

// recordPublishRevision stores a publish revision with the post's current tags.
func (s *PostService) recordPublishRevision(ctx context.Context, post models.Post) {
	var names []string
	if tags, err := s.repo.GetTagsForPost(ctx, post.ID); err == nil {
		for _, t := range tags {
			names = append(names, t.Name)
		}
	}
	s.recordRevision(ctx, post, RevisionPublish, names)
}

// ListPostRevisions returns the revisions of a post, newest first.
func (s *PostService) ListPostRevisions(ctx context.Context, postID int64) ([]PostRevisionSummary, error) {
	if _, err := s.getPost(ctx, postID); err != nil {
		return nil, err
	}
	rows, err := s.repo.ListPostRevisions(ctx, postID)
	if err != nil {
		return nil, err
	}
	out := make([]PostRevisionSummary, 0, len(rows))
	for _, r := range rows {
		out = append(out, PostRevisionSummary{ID: r.ID, Kind: r.Kind, CreatedAt: r.CreatedAt, Title: r.Title})
	}
	return out, nil
}

// GetPostRevision returns one revision of a post in full.
func (s *PostService) GetPostRevision(ctx context.Context, postID, revisionID int64) (PostRevision, error) {
	if _, err := s.getPost(ctx, postID); err != nil {
		return PostRevision{}, err
	}
	r, err := s.repo.GetPostRevision(ctx, models.GetPostRevisionParams{ID: revisionID, PostID: postID})
	if errors.Is(err, sql.ErrNoRows) {
		return PostRevision{}, ErrRevisionNotFound
	}
	if err != nil {
		return PostRevision{}, err
	}
	tags := []string{}
	if strings.TrimSpace(r.Tags) != "" {
		if err := json.Unmarshal([]byte(r.Tags), &tags); err != nil {
			tags = []string{}
		}
	}
	return PostRevision{
		ID:        r.ID,
		PostID:    r.PostID,
		Kind:      r.Kind,
		CreatedAt: r.CreatedAt,
		Title:     r.Title,
		Content:   r.Content,
		Tags:      tags,
		CSS:       r.Css,
	}, nil
}

// RestorePostRevision writes the title, body, tags and CSS of a revision back
// to the post through UpdatePost. The other fields of the post (status, slug,
// excerpt and so on) do not change. The restore makes a new "restore"
// revision; the newer revisions stay.
func (s *PostService) RestorePostRevision(ctx context.Context, postID, revisionID, authorID int64) (models.Post, []string, error) {
	rev, err := s.GetPostRevision(ctx, postID, revisionID)
	if err != nil {
		return models.Post{}, nil, err
	}
	current, err := s.getPost(ctx, postID)
	if err != nil {
		return models.Post{}, nil, err
	}
	var scheduledAt *time.Time
	if current.ScheduledAt.Valid {
		t := current.ScheduledAt.Time
		scheduledAt = &t
	}
	return s.UpdatePost(ctx, UpdatePostParams{
		ID:              current.ID,
		AuthorID:        authorID,
		Title:           rev.Title,
		Content:         rev.Content,
		CSS:             rev.CSS,
		ImmersiveMode:   current.ImmersiveMode,
		InstagramShare:  current.InstagramShare,
		Excerpt:         current.Excerpt.String,
		Slug:            current.Slug,
		Formatter:       current.Formatter,
		Status:          current.Status,
		Type:            current.Type,
		IsFeatured:      current.IsFeatured,
		ThumbnailPath:   current.ThumbnailPath.String,
		MetaDescription: current.MetaDescription.String,
		Tags:            rev.Tags,
		ScheduledAt:     scheduledAt,
		SaveKind:        SaveKindRestore,
	})
}
