package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"

	"github.com/disintegration/imaging"
	"golang.org/x/sync/singleflight"
	"google.golang.org/api/googleapi"
	"google.golang.org/genai"
	"gopkg.in/yaml.v3"
)

type MediaService struct {
	repo            repository.Repository
	cfg             *config.Config
	settingsService *SettingsService
	tagService      *TagService
	genaiClient     *genai.Client
	genaiConfig     GenAIConfig

	// variantFlight collapses concurrent ladder generation per media ID. See
	// Variant for why the global decode semaphore is not enough on its own.
	variantFlight singleflight.Group
}

type GenAIConfig struct {
	Prompt string   `yaml:"prompt"`
	Models []string `yaml:"models"`
}

func NewMediaService(repo repository.Repository, cfg *config.Config, settingsService *SettingsService, tagService *TagService) *MediaService {
	s := &MediaService{
		repo:            repo,
		cfg:             cfg,
		settingsService: settingsService,
		tagService:      tagService,
	}

	if cfg == nil {
		return s
	}

	// Initialize GenAI if key is present
	apiKey := cfg.GeminiAPIKey
	if apiKey != "" {
		ctx := context.Background()
		client, err := genai.NewClient(ctx, &genai.ClientConfig{
			APIKey:  apiKey,
			Backend: genai.BackendGeminiAPI,
		})
		if err == nil {
			s.genaiClient = client

			// Try to load data.yml
			configPath := filepath.Join(cfg.StoragePath, "data.yml")
			// Try current dir if storage path failed
			if _, err := os.Stat(configPath); os.IsNotExist(err) {
				configPath = "data.yml"
			}

			if configBytes, err := os.ReadFile(configPath); err == nil {
				_ = yaml.Unmarshal(configBytes, &s.genaiConfig)
			}

			// Apply defaults for values not set by data.yml
			if len(s.genaiConfig.Models) == 0 {
				s.genaiConfig.Models = []string{"gemini-2.0-flash", "gemini-1.5-flash"}
			}
			if s.genaiConfig.Prompt == "" {
				s.genaiConfig.Prompt = `Analyze this image and return a JSON object with exactly these keys:
"title": a concise, descriptive title for the image (string),
"tags": an array of relevant keyword tags (array of strings),
"excerpt": a 1-2 sentence description of the image (string).
Return only valid JSON, no markdown or extra text.`
			}
		}
	}

	return s
}

func CalculateChecksum(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// thumbnailWidth returns the effective thumbnail width, preferring env config
// then DB setting then the hard-coded default.
func (s *MediaService) thumbnailWidth(ctx context.Context) int {
	return s.settingsService.GetConfigSetting(ctx, "thumbnail_width", s.cfg.ThumbnailWidth, 400)
}

// thumbnailHeight returns the effective thumbnail height.
func (s *MediaService) thumbnailHeight(ctx context.Context) int {
	return s.settingsService.GetConfigSetting(ctx, "thumbnail_height", s.cfg.ThumbnailHeight, 300)
}

// jpegQuality returns the effective JPEG quality (1-100).
func (s *MediaService) jpegQuality(ctx context.Context) int {
	return s.settingsService.GetConfigSetting(ctx, "jpeg_quality", s.cfg.JpegQuality, 85)
}

func (s *MediaService) GetStorageUsage(ctx context.Context) (int64, error) {
	usage, err := s.repo.GetStorageUsage(ctx)
	if err != nil {
		return 0, err
	}
	if !usage.Valid {
		return 0, nil
	}
	return int64(usage.Float64), nil
}

type UploadFileParams struct {
	Content  []byte
	Filename string
	MimeType string
	AltText  string
	Caption  string
	PostID   *int64
}

func (s *MediaService) UploadFile(ctx context.Context, p UploadFileParams) (models.Medium, error) {
	checksum := CalculateChecksum(p.Content)

	// Check duplicate
	existing, err := s.repo.GetMediaByChecksum(ctx, checksum)
	if err == nil {
		return existing, nil
	}

	now := time.Now().UTC().Round(0)
	datePath := fmt.Sprintf("%d/%02d", now.Year(), now.Month())

	// Create directories
	originalsDir := filepath.Join(s.cfg.StoragePath, "media", "originals", datePath)
	if err := os.MkdirAll(originalsDir, 0755); err != nil {
		return models.Medium{}, err
	}

	// Strip any directory components from the user-provided filename to
	// prevent path traversal (e.g. "../../etc/passwd").
	safeFilename := filepath.Base(filepath.Clean("/" + p.Filename))
	uniqueFilename := fmt.Sprintf("%d_%s", now.Unix(), safeFilename)
	originalRelPath := filepath.Join("originals", datePath, uniqueFilename)
	mediaBase := filepath.Clean(filepath.Join(s.cfg.StoragePath, "media"))
	originalFullPath := filepath.Clean(filepath.Join(mediaBase, originalRelPath))
	if !strings.HasPrefix(originalFullPath, mediaBase+string(filepath.Separator)) {
		return models.Medium{}, fmt.Errorf("invalid media path")
	}

	// Process media
	var width, height sql.NullInt64
	var metadata map[string]interface{}
	// decoded is kept alive past this block so the thumbnail ladder can be
	// written from it once the original is safely on disk — the decode already
	// happened for the dimension read, so the rungs are nearly free.
	var decoded image.Image
	fileType := "file"

	if strings.HasPrefix(p.MimeType, "image/") {
		fileType = "image"
		// Load image for dimensions and the thumbnail ladder
		src, err := s.decodeImage(ctx, p.Content)
		if errors.Is(err, ErrTooLarge) {
			// Other decode failures are tolerated below — the file is stored
			// without dimensions or a thumbnail. "Too many pixels" is not a
			// degraded success but a refusal: storing it would mean every later
			// thumbnail attempt re-hits the same ceiling, and the uploader would
			// never learn why.
			return models.Medium{}, err
		}
		if err == nil {
			decoded = src
			bounds := src.Bounds()
			width = sql.NullInt64{Int64: int64(bounds.Dx()), Valid: true}
			height = sql.NullInt64{Int64: int64(bounds.Dy()), Valid: true}
		}
		// Extract EXIF
		metadata = s.extractEXIF(bytes.NewReader(p.Content))
	} else if strings.HasPrefix(p.MimeType, "video/") {
		fileType = "video"
	} else if strings.HasPrefix(p.MimeType, "audio/") {
		fileType = "audio"
	}

	var metadataJSON sql.NullString
	if len(metadata) > 0 {
		if mj, err := json.Marshal(metadata); err == nil {
			metadataJSON = sql.NullString{String: string(mj), Valid: true}
		}
	}

	// Save original
	if err := os.WriteFile(originalFullPath, p.Content, 0644); err != nil {
		return models.Medium{}, err
	}

	// Generate the ladder eagerly, so the first visitor to the post is not the
	// one who pays for it. A failure is not fatal: the media route regenerates
	// any missing rung on request.
	if decoded != nil {
		if err := s.writeLadder(ctx, originalRelPath, decoded, ""); err != nil {
			slog.Warn("thumbnail ladder generation failed", "path", originalRelPath, "error", err)
		}
	}

	var postID sql.NullInt64
	if p.PostID != nil {
		postID = sql.NullInt64{Int64: *p.PostID, Valid: true}
	}

	// Save to DB
	media, err := s.repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:     p.Filename,
		OriginalPath: originalRelPath,
		// thumbnail_path is the video poster column now: an image's derived
		// sizes live in the variants tree, keyed on the original's path, and
		// need no row of their own.
		ThumbnailPath:    sql.NullString{},
		FileType:         fileType,
		MimeType:         p.MimeType,
		FileSize:         int64(len(p.Content)),
		Width:            width,
		Height:           height,
		PostID:           postID,
		Checksum:         checksum,
		AltText:          sql.NullString{String: p.AltText, Valid: p.AltText != ""},
		Caption:          sql.NullString{String: p.Caption, Valid: p.Caption != ""},
		Metadata:         metadataJSON,
		OriginalMetadata: metadataJSON,
		UploadedAt:       now,
	})
	if err != nil {
		return models.Medium{}, err
	}

	// When an image is added to a post and carries GPS coordinates, derive a
	// location tag from those coordinates and attach it to the post. Best-effort:
	// failures (e.g. no network, no place name) must not fail the upload.
	s.tagPostFromGPS(ctx, p.PostID, metadata)

	return media, nil
}

// tagPostFromGPS reverse-geocodes the GPS coordinates found in EXIF metadata and
// attaches the resulting location tag to the post. It is a no-op when there is no
// post, no GPS data, or no tag service configured.
func (s *MediaService) tagPostFromGPS(ctx context.Context, postID *int64, metadata map[string]interface{}) {
	if postID == nil || s.tagService == nil {
		return
	}
	lat, latOK := metadata["GPSLatitude"].(float64)
	lon, lonOK := metadata["GPSLongitude"].(float64)
	if !latOK || !lonOK {
		return
	}
	if _, err := s.tagService.TagPostWithLocation(ctx, *postID, lat, lon); err != nil {
		slog.Warn("location tagging from EXIF GPS failed", "post_id", *postID, "error", err)
	}
}

// ImportFromPath copies a file from srcPath into the managed media store and
// inserts a DB record with is_public=0. The caller is responsible for
// deduplication (checksum check) before calling this.
func (s *MediaService) ImportFromPath(ctx context.Context, srcPath string) (models.Medium, error) {
	content, err := os.ReadFile(srcPath)
	if err != nil {
		return models.Medium{}, fmt.Errorf("read file: %w", err)
	}

	filename := filepath.Base(srcPath)
	ext := strings.ToLower(filepath.Ext(filename))

	// Determine MIME type: try extension first, fall back to content sniff.
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		mimeType = http.DetectContentType(content)
	}

	checksum := CalculateChecksum(content)

	now := time.Now().UTC().Round(0)
	datePath := fmt.Sprintf("%d/%02d", now.Year(), now.Month())

	originalsDir := filepath.Join(s.cfg.StoragePath, "media", "originals", datePath)
	if err := os.MkdirAll(originalsDir, 0755); err != nil {
		return models.Medium{}, err
	}

	uniqueFilename := fmt.Sprintf("%d_%s", now.Unix(), filename)
	originalRelPath := filepath.Join("originals", datePath, uniqueFilename)
	originalFullPath := filepath.Join(s.cfg.StoragePath, "media", originalRelPath)

	var width, height sql.NullInt64
	var metadata map[string]interface{}
	var decoded image.Image
	fileType := "file"

	if strings.HasPrefix(mimeType, "image/") {
		fileType = "image"
		src, err := s.decodeImage(ctx, content)
		if errors.Is(err, ErrTooLarge) {
			// Other decode failures are tolerated below — the file is stored
			// without dimensions or a thumbnail. "Too many pixels" is not a
			// degraded success but a refusal: storing it would mean every later
			// thumbnail attempt re-hits the same ceiling, and the uploader would
			// never learn why.
			return models.Medium{}, err
		}
		if err == nil {
			decoded = src
			bounds := src.Bounds()
			width = sql.NullInt64{Int64: int64(bounds.Dx()), Valid: true}
			height = sql.NullInt64{Int64: int64(bounds.Dy()), Valid: true}
		}
		// Extract EXIF
		metadata = s.extractEXIF(bytes.NewReader(content))
	} else if strings.HasPrefix(mimeType, "video/") {
		fileType = "video"
	} else if strings.HasPrefix(mimeType, "audio/") {
		fileType = "audio"
	}

	var metadataJSON sql.NullString
	if len(metadata) > 0 {
		if mj, err := json.Marshal(metadata); err == nil {
			metadataJSON = sql.NullString{String: string(mj), Valid: true}
		}
	}

	// originalFullPath is built from the storage root plus a sanitized filename
	// this function generated; the uploaded name never reaches the path.
	//nolint:gosec // G703: path is composed from the storage root, not from input
	if err := os.WriteFile(originalFullPath, content, 0644); err != nil {
		return models.Medium{}, err
	}

	// Same eager ladder as UploadFile, off the decode already done above.
	if decoded != nil {
		if err := s.writeLadder(ctx, originalRelPath, decoded, ""); err != nil {
			slog.Warn("thumbnail ladder generation failed", "path", originalRelPath, "error", err)
		}
	}

	return s.repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:         filename,
		OriginalPath:     originalRelPath,
		ThumbnailPath:    sql.NullString{},
		FileType:         fileType,
		MimeType:         mimeType,
		FileSize:         int64(len(content)),
		Width:            width,
		Height:           height,
		PostID:           sql.NullInt64{},
		Checksum:         checksum,
		AltText:          sql.NullString{},
		Caption:          sql.NullString{},
		Metadata:         metadataJSON,
		OriginalMetadata: metadataJSON,
		UploadedAt:       now,
	})
}

func (s *MediaService) GetMediaByID(ctx context.Context, id int64) (models.Medium, error) {
	return s.getMedia(ctx, id)
}

// getMedia fetches one media row, translating a missing row into
// ErrMediaNotFound. The driver's own message is dropped: it now reaches clients
// through the central mapper, and "sql: no rows in result set" is not an answer
// to give a request.
func (s *MediaService) getMedia(ctx context.Context, id int64) (models.Medium, error) {
	media, err := s.repo.GetMedia(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return models.Medium{}, ErrMediaNotFound
	}
	return media, err
}

type ListMediaParams struct {
	Page     int32
	PerPage  int32
	FileType string
	Folder   string // "YYYY/MM" format; empty means no folder filter
}

func (s *MediaService) ListMedia(ctx context.Context, p ListMediaParams) ([]models.Medium, int64, error) {
	offset := (p.Page - 1) * p.PerPage
	media, err := s.repo.ListMediaFiltered(ctx, p.FileType, p.Folder, int64(p.PerPage), int64(offset))
	if err != nil {
		return nil, 0, err
	}

	total, err := s.repo.CountMediaFiltered(ctx, p.FileType, p.Folder)
	if err != nil {
		return nil, 0, err
	}

	return media, total, nil
}

func (s *MediaService) GetMediaFolders(ctx context.Context, fileType string) ([]repository.MediaFolder, error) {
	return s.repo.ListMediaFolders(ctx, fileType)
}

type UpdateMediaParams struct {
	ID       int64
	AltText  string
	Caption  string
	PostID   *int64
	Metadata *map[string]interface{} // nil = keep existing; non-nil (incl. empty map) = replace
}

func (s *MediaService) UpdateMedia(ctx context.Context, p UpdateMediaParams) (models.Medium, error) {
	var postID sql.NullInt64
	if p.PostID != nil {
		postID = sql.NullInt64{Int64: *p.PostID, Valid: true}
	}

	var metadataParam sql.NullString
	if p.Metadata != nil {
		b, err := json.Marshal(*p.Metadata)
		if err != nil {
			return models.Medium{}, fmt.Errorf("marshal metadata: %w", err)
		}
		metadataParam = sql.NullString{String: string(b), Valid: true}
	}

	return s.repo.UpdateMedia(ctx, models.UpdateMediaParams{
		ID:       p.ID,
		AltText:  sql.NullString{String: p.AltText, Valid: p.AltText != ""},
		Caption:  sql.NullString{String: p.Caption, Valid: p.Caption != ""},
		PostID:   postID,
		Metadata: metadataParam,
	})
}

func (s *MediaService) GetMediaByPostID(ctx context.Context, postID int64) ([]models.Medium, error) {
	return s.repo.GetMediaByPostID(ctx, sql.NullInt64{Int64: postID, Valid: true})
}

// GetMediaByContent fetches media records referenced in post content (and
// optional thumbnailPath) by looking up their original_path in the DB.
// This works regardless of whether media.post_id has been explicitly set.
func (s *MediaService) GetMediaByContent(ctx context.Context, content, thumbnailPath string) ([]models.Medium, error) {
	paths := ExtractMediaPaths(content, thumbnailPath)
	return s.repo.GetMediaByPaths(ctx, paths)
}

// ReextractEXIF re-reads the original file from disk, runs extractEXIF, and
// overwrites media.metadata. Returns the updated media record.
func (s *MediaService) ReextractEXIF(ctx context.Context, id int64) (models.Medium, error) {
	media, err := s.getMedia(ctx, id)
	if err != nil {
		return models.Medium{}, err
	}

	base := filepath.Clean(filepath.Join(s.cfg.StoragePath, "media"))
	full := filepath.Clean(filepath.Join(base, media.OriginalPath))
	if !strings.HasPrefix(full, base+string(filepath.Separator)) {
		return models.Medium{}, fmt.Errorf("invalid media path")
	}

	f, err := os.Open(full)
	if err != nil {
		return models.Medium{}, fmt.Errorf("open file: %w", err)
	}

	extracted := s.extractEXIF(f)
	_ = f.Close()
	metadata := map[string]interface{}(extracted)
	return s.UpdateMedia(ctx, UpdateMediaParams{
		ID:       id,
		AltText:  media.AltText.String,
		Caption:  media.Caption.String,
		Metadata: &metadata,
	})
}

// UpdateEXIFParams holds the fields to write into a media item's EXIF.
// All string values must contain only alphanumeric characters and spaces.
type UpdateEXIFParams struct {
	ID     int64
	Fields map[string]string
}

// UpdateEXIF validates field values, writes EXIF back to the JPEG file on
// disk (no-op for non-JPEG), and replaces media.metadata in the DB.
// original_metadata is never modified.
func (s *MediaService) UpdateEXIF(ctx context.Context, p UpdateEXIFParams) (models.Medium, error) {
	media, err := s.getMedia(ctx, p.ID)
	if err != nil {
		return models.Medium{}, err
	}

	// Validate: reject rather than silently rewrite, so an admin sees that
	// their input was not stored verbatim. The accepted set is what
	// sanitizeEXIFValue keeps — alphanumerics, space and the punctuation EXIF
	// values legitimately carry.
	sanitized := make(map[string]interface{}, len(p.Fields))
	for k, v := range p.Fields {
		if sanitizeEXIFValue(v) != v {
			return models.Medium{}, wrapKind(ErrInvalidInput, fmt.Errorf("field %q contains disallowed characters", k))
		}
		sanitized[k] = v
	}

	// Write EXIF to file (JPEG only; non-JPEG is no-op)
	base := filepath.Clean(filepath.Join(s.cfg.StoragePath, "media"))
	full := filepath.Clean(filepath.Join(base, media.OriginalPath))
	if !strings.HasPrefix(full, base+string(filepath.Separator)) {
		return models.Medium{}, fmt.Errorf("invalid media path")
	}
	if err := writeEXIFToFile(full, media.MimeType, sanitized); err != nil {
		return models.Medium{}, fmt.Errorf("write exif to file: %w", err)
	}

	// Update metadata in DB
	metaJSON, err := json.Marshal(sanitized)
	if err != nil {
		return models.Medium{}, fmt.Errorf("marshal metadata: %w", err)
	}
	return s.repo.UpdateMediaMetadata(ctx, models.UpdateMediaMetadataParams{
		ID:       p.ID,
		Metadata: sql.NullString{String: string(metaJSON), Valid: true},
	})
}

// RevertEXIF restores media.metadata to the original EXIF captured at upload
// and writes those values back to the JPEG file on disk. Returns an error if
// original_metadata is absent (null or empty).
func (s *MediaService) RevertEXIF(ctx context.Context, id int64) (models.Medium, error) {
	media, err := s.getMedia(ctx, id)
	if err != nil {
		return models.Medium{}, err
	}

	if !media.OriginalMetadata.Valid || media.OriginalMetadata.String == "" {
		return models.Medium{}, wrapKind(ErrConflict, errors.New("no original metadata to revert to"))
	}

	var origFields map[string]interface{}
	if err := json.Unmarshal([]byte(media.OriginalMetadata.String), &origFields); err != nil {
		return models.Medium{}, fmt.Errorf("parse original metadata: %w", err)
	}

	// Write original EXIF back to file
	base := filepath.Clean(filepath.Join(s.cfg.StoragePath, "media"))
	full := filepath.Clean(filepath.Join(base, media.OriginalPath))
	if !strings.HasPrefix(full, base+string(filepath.Separator)) {
		return models.Medium{}, fmt.Errorf("invalid media path")
	}
	if err := writeEXIFToFile(full, media.MimeType, origFields); err != nil {
		return models.Medium{}, fmt.Errorf("write exif to file: %w", err)
	}

	// Reset metadata = original_metadata in DB
	return s.repo.UpdateMediaMetadata(ctx, models.UpdateMediaMetadataParams{
		ID:       id,
		Metadata: media.OriginalMetadata,
	})
}

func (s *MediaService) DeleteMedia(ctx context.Context, id int64) error {
	media, err := s.getMedia(ctx, id)
	if err != nil {
		return err
	}

	// Delete files
	originalFull := filepath.Join(s.cfg.StoragePath, "media", media.OriginalPath)
	_ = os.Remove(originalFull)

	if media.ThumbnailPath.Valid {
		thumbnailFull := filepath.Join(s.cfg.StoragePath, "media", media.ThumbnailPath.String)
		_ = os.Remove(thumbnailFull)
	}
	s.removeAllVariants(media.OriginalPath)

	return s.repo.DeleteMedia(ctx, id)
}

func (s *MediaService) BulkDeleteMedia(ctx context.Context, ids []int64) (int, error) {
	// Fetch records first so we can remove the files
	records, err := s.repo.GetMediaByIDs(ctx, ids)
	if err != nil {
		return 0, err
	}

	// Remove files from disk
	for _, m := range records {
		originalFull := filepath.Join(s.cfg.StoragePath, "media", m.OriginalPath)
		_ = os.Remove(originalFull)
		if m.ThumbnailPath.Valid {
			thumbnailFull := filepath.Join(s.cfg.StoragePath, "media", m.ThumbnailPath.String)
			_ = os.Remove(thumbnailFull)
		}
		s.removeAllVariants(m.OriginalPath)
	}

	if err := s.repo.DeleteMediaByIDs(ctx, ids); err != nil {
		return 0, err
	}

	return len(records), nil
}

func (s *MediaService) ListOrphanedMedia(ctx context.Context, page, perPage int32) ([]models.Medium, int64, error) {
	offset := int64((page - 1) * perPage)
	media, count, err := s.repo.ListOrphanedMediaByPage(ctx, int64(perPage), offset)
	if err != nil {
		return nil, 0, err
	}
	return media, count, nil
}

// CleanupOrphaned deletes all media with no linked post. Returns count and freed bytes.
func (s *MediaService) CleanupOrphaned(ctx context.Context) (int, int64, error) {
	all, err := s.repo.ListOrphanedMedia(ctx, 10000, 0)
	if err != nil {
		return 0, 0, err
	}

	var freed int64
	var ids []int64
	for _, m := range all {
		ids = append(ids, m.ID)
		freed += m.FileSize
		_ = os.Remove(filepath.Join(s.cfg.StoragePath, "media", m.OriginalPath))
		if m.ThumbnailPath.Valid {
			_ = os.Remove(filepath.Join(s.cfg.StoragePath, "media", m.ThumbnailPath.String))
		}
		s.removeAllVariants(m.OriginalPath)
	}

	if len(ids) > 0 {
		if err := s.repo.DeleteMediaByIDs(ctx, ids); err != nil {
			return 0, 0, err
		}
	}
	return len(ids), freed, nil
}

// StorageStats holds aggregate storage info.
type StorageStats struct {
	TotalBytes int64 `json:"total_bytes"`
	TotalFiles int64 `json:"total_files"`
	ImageCount int64 `json:"image_count"`
	VideoCount int64 `json:"video_count"`
	AudioCount int64 `json:"audio_count"`
	OtherCount int64 `json:"other_count"`
}

func (s *MediaService) GetStorageStats(ctx context.Context) (StorageStats, error) {
	st, err := s.repo.GetStorageStats(ctx)
	if err != nil {
		return StorageStats{}, err
	}
	return StorageStats{
		TotalBytes: st.TotalBytes,
		TotalFiles: st.TotalFiles,
		ImageCount: st.ImageCount,
		VideoCount: st.VideoCount,
		AudioCount: st.AudioCount,
		OtherCount: st.OtherCount,
	}, nil
}

// RenameMedia renames a media file on disk and updates the database.
func (s *MediaService) RenameMedia(ctx context.Context, id int64, newFilename string) (models.Medium, error) {
	m, err := s.getMedia(ctx, id)
	if err != nil {
		return models.Medium{}, err
	}

	// Sanitize: keep only the basename, preserve extension
	newBase := filepath.Base(newFilename)
	oldExt := filepath.Ext(m.OriginalPath)
	newExt := filepath.Ext(newBase)
	if newExt == "" {
		newBase += oldExt
	}

	oldOrigFull := filepath.Join(s.cfg.StoragePath, "media", m.OriginalPath)
	newRelDir := filepath.Dir(m.OriginalPath)
	newOrigRel := filepath.Join(newRelDir, newBase)
	newOrigFull := filepath.Join(s.cfg.StoragePath, "media", newOrigRel)

	if err := os.Rename(oldOrigFull, newOrigFull); err != nil {
		return models.Medium{}, fmt.Errorf("rename file: %w", err)
	}

	// Drop the ladder rather than renaming four files: a rung is keyed on the
	// original's path, so the old names are now orphans, and regenerating one
	// costs a single decode on next request.
	s.removeAllVariants(m.OriginalPath)

	// A video poster does have to move. It is client-captured and there is no
	// server-side decoder to reproduce it, so losing it would mean asking the
	// operator to re-capture the frame by hand.
	var newThumbRel sql.NullString
	if m.ThumbnailPath.Valid {
		thumbExt := filepath.Ext(m.ThumbnailPath.String)
		newThumbBase := strings.TrimSuffix(newBase, filepath.Ext(newBase)) + thumbExt
		thumbDir := filepath.Dir(m.ThumbnailPath.String)
		newThumbRel = sql.NullString{
			String: filepath.Join(thumbDir, newThumbBase),
			Valid:  true,
		}
		oldThumbFull := filepath.Join(s.cfg.StoragePath, "media", m.ThumbnailPath.String)
		newThumbFull := filepath.Join(s.cfg.StoragePath, "media", newThumbRel.String)
		_ = os.Rename(oldThumbFull, newThumbFull)
	}

	updated, err := s.repo.UpdateMediaFilename(ctx, models.UpdateMediaFilenameParams{
		ID:            id,
		Filename:      newBase,
		OriginalPath:  newOrigRel,
		ThumbnailPath: newThumbRel,
	})
	if err != nil {
		return models.Medium{}, err
	}

	// Update any post content that references the old bare path (/YYYY/MM/old.ext).
	oldContentPath := strings.TrimPrefix(m.OriginalPath, "originals")
	newContentPath := strings.TrimPrefix(newOrigRel, "originals")
	if oldContentPath != newContentPath {
		if _, err := s.repo.ReplacePostContentPath(ctx, oldContentPath, newContentPath); err != nil {
			return updated, fmt.Errorf("update post content references: %w", err)
		}
	}

	return updated, nil
}

// SaveVideoPoster stores a client-captured frame as a video's thumbnail.
//
// The runtime image ships no ffmpeg (and the binary is CGO-free), so there is
// no server-side video decoder: the admin browser draws a frame off a <video>
// element onto a canvas and posts the resulting JPEG here. The frame lands on
// the same media/thumbnails/YYYY/MM/ path an image upload would use, so every
// existing consumer of ?thumb picks it up with no further changes.
func (s *MediaService) SaveVideoPoster(ctx context.Context, id int64, poster []byte) (models.Medium, error) {
	media, err := s.getMedia(ctx, id)
	if err != nil {
		return models.Medium{}, err
	}
	return s.storePoster(ctx, media, poster)
}

// posterMaxSide is the box a client-captured poster frame is fitted into.
//
// The poster is the only still a video has, and it is not reproducible without
// the admin browser, so it is stored generously and aspect-preserved and the
// ladder is derived from it like any image. It used to be cropped to the
// 400x300 thumbnail box, which meant every video's thumbnails were a 4:3
// centre crop of a 16:9 frame while images kept their proportions. Fit cannot
// put back pixels a Fill discarded, so the crop had to go at the source.
const posterMaxSide = 1600

// storePoster fits poster into the poster box and records it as media's
// thumbnail_path. It is the shared tail of SaveVideoPoster and the poster
// field on upload.
func (s *MediaService) storePoster(ctx context.Context, media models.Medium, poster []byte) (models.Medium, error) {
	if !strings.EqualFold(media.FileType, "video") {
		return models.Medium{}, ErrNotAVideo
	}

	src, err := s.decodeImage(ctx, poster)
	if err != nil {
		return models.Medium{}, wrapKind(ErrInvalidInput, fmt.Errorf("poster frame is not a decodable image: %w", err))
	}

	mediaBase := s.mediaBase()
	relUnder := strings.TrimPrefix(media.OriginalPath, "originals/")
	baseName := strings.TrimSuffix(filepath.Base(relUnder), filepath.Ext(relUnder)) + ".jpg"
	thumbRel := filepath.Join("thumbnails", filepath.Dir(relUnder), baseName)
	thumbFull := filepath.Clean(filepath.Join(mediaBase, thumbRel))
	if !strings.HasPrefix(thumbFull, mediaBase+string(filepath.Separator)) {
		return models.Medium{}, fmt.Errorf("invalid thumbnail path")
	}

	if err := os.MkdirAll(filepath.Dir(thumbFull), 0755); err != nil {
		return models.Medium{}, err
	}
	thumb := imaging.Fit(src, posterMaxSide, posterMaxSide, imaging.Lanczos)
	if err := imaging.Save(thumb, thumbFull, imaging.JPEGQuality(s.jpegQuality(ctx))); err != nil {
		return models.Medium{}, err
	}

	// Drop the rungs cut from the previous poster. Variant would notice the
	// newer source on its own, but a re-capture that lands within the same
	// filesystem timestamp granularity would not move mtime forward.
	s.removeAllVariants(media.OriginalPath)

	if media.ThumbnailPath.Valid && media.ThumbnailPath.String != thumbRel {
		_ = os.Remove(filepath.Join(mediaBase, media.ThumbnailPath.String))
	}

	return s.repo.UpdateMediaFilename(ctx, models.UpdateMediaFilenameParams{
		ID:            media.ID,
		Filename:      media.Filename,
		OriginalPath:  media.OriginalPath,
		ThumbnailPath: sql.NullString{String: thumbRel, Valid: true},
	})
}

// VariantSizes is the thumbnail ladder: the cap applied to the LONGEST side of
// a derived JPEG, ascending. Aspect ratio is preserved (imaging.Fit), so a
// portrait source at rung 512 is 512 tall and narrower than that.
//
// Four rungs cover the whole product: 128 for atlas chips, 256 for dense grids,
// 512 for cards and the legacy bare `?thumb`, 1024 for article bodies and
// retina cards. JPEG only — the binary is CGO-free and disintegration/imaging
// cannot encode WebP or AVIF without a cgo dependency.
var VariantSizes = []int{128, 256, 512, 1024}

// DefaultVariantSize is the rung a bare `?thumb` resolves to. Existing
// posts.thumbnail_path rows and published post content carry `?thumb` with no
// size and there is no data migration behind them, so they land here.
const DefaultVariantSize = 512

// AtlasVariantSize is the rung the atlas cloud requests for its post chips.
const AtlasVariantSize = 128

// AllowedVariantSize reports whether size is a rung of the ladder. Restricting
// generation to a fixed set keeps the on-disk cache bounded and stops an
// arbitrary `?s=<n>` flood from filling the disk.
func AllowedVariantSize(size int) bool {
	for _, s := range VariantSizes {
		if s == size {
			return true
		}
	}
	return false
}

// VariantsRoot is the root of the derived-image tree, under media/.
//
// It is deliberately a different root from media/thumbnails/, which holds
// client-captured video poster frames. Those are not derivable: the runtime
// ships no ffmpeg and the binary is CGO-free, so a poster exists only because
// an admin browser drew a frame off a <video> onto a canvas and posted it
// (see SaveVideoPoster). Purging the derived tree is a routine operation and
// must not be able to reach them; separate roots make that structural, where
// "no year directory is ever named 128" would only be a coincidence.
const VariantsRoot = "variants"

// ThumbnailGenerationSetting is the settings key holding the generation token.
const ThumbnailGenerationSetting = "thumbnail_generation"

// DefaultThumbnailGeneration is the token a site serves on before any rebuild
// has written one.
const DefaultThumbnailGeneration = "1"

// ThumbnailGeneration returns the current thumbnail generation token — the `v`
// in a variant URL.
//
// It is one global token rather than a per-media value because the frontend
// call sites that build a media URL hold a bare path string and nothing else;
// a per-media token would have to be plumbed through every one of them. A
// rebuild writes a fresh token, which moves every variant URL on the site at
// once and is the whole of the engine's cache invalidation.
func (s *MediaService) ThumbnailGeneration(ctx context.Context) string {
	if s.settingsService == nil {
		return DefaultThumbnailGeneration
	}
	v, err := s.settingsService.GetSetting(ctx, ThumbnailGenerationSetting, DefaultThumbnailGeneration)
	if err != nil || v == "" {
		return DefaultThumbnailGeneration
	}
	return v
}

// VariantRelPath returns the media-relative path of one ladder rung derived
// from the media item whose original lives at originalPath. The size is a
// directory rather than a filename suffix, and the generation token is not on
// disk at all: a rebuild purges the tree, it does not accumulate generations.
func VariantRelPath(originalPath string, size int) string {
	relUnder := strings.TrimPrefix(originalPath, "originals/")
	baseName := strings.TrimSuffix(filepath.Base(relUnder), filepath.Ext(relUnder)) + ".jpg"
	return filepath.Join(VariantsRoot, strconv.Itoa(size), filepath.Dir(relUnder), baseName)
}

// mediaBase is the cleaned root every media path must stay inside.
func (s *MediaService) mediaBase() string {
	return filepath.Clean(filepath.Join(s.cfg.StoragePath, "media"))
}

// variantFullPath is the absolute path of a rung, generated or not.
func (s *MediaService) variantFullPath(originalPath string, size int) string {
	return filepath.Clean(filepath.Join(s.mediaBase(), VariantRelPath(originalPath, size)))
}

// variantSourceRel returns the media-relative path of the file a media item's
// variants are cut from: the original for an image, the stored poster frame
// for a video. Anything else has no still to derive from.
func variantSourceRel(media models.Medium) (string, error) {
	if strings.EqualFold(media.FileType, "image") {
		return media.OriginalPath, nil
	}
	if !strings.EqualFold(media.FileType, "video") {
		return "", ErrNotAnImage
	}
	if !media.ThumbnailPath.Valid || media.ThumbnailPath.String == "" {
		return "", ErrNoPoster
	}
	return media.ThumbnailPath.String, nil
}

// variantIsFresh reports whether a cached rung exists and is no older than the
// source it was cut from. A source can be replaced in place — a re-captured
// poster, an EXIF write — without its path changing, so mtime is the only
// signal that the cache is stale.
func variantIsFresh(variantFull, srcFull string) bool {
	vi, err := os.Stat(variantFull)
	if err != nil {
		return false
	}
	si, err := os.Stat(srcFull)
	if err != nil {
		return false
	}
	return !si.ModTime().After(vi.ModTime())
}

// Variant returns the absolute path of the cached JPEG rung of the given size,
// generating it lazily on first request.
//
// One decode produces the WHOLE ladder. A responsive <img srcset> asks for
// several sizes of the same image within milliseconds of each other, so a
// decode per size would mean four decodes of one source to paint one card.
// Instead the first request through decodes once and writes every rung, and
// the rest find warm files. Concurrent requests are collapsed per media ID, so
// the four candidates cannot race into four decodes either — for this access
// pattern that matters more than the process-wide decode semaphore, which
// bounds the machine but not the duplication.
//
// Rungs at or above the source's longest side are never written: imaging.Fit
// does not upscale, so they would be byte-identical copies of one another. The
// caller gets ErrVariantNotNeeded and serves the original instead. A video
// falls back to its poster frame rather than the original, which is a media
// stream and not a still.
func (s *MediaService) Variant(ctx context.Context, media models.Medium, size int) (string, error) {
	if !AllowedVariantSize(size) {
		return "", wrapKind(ErrInvalidInput, fmt.Errorf("unsupported thumbnail size %d", size))
	}

	srcRel, err := variantSourceRel(media)
	if err != nil {
		return "", err
	}

	mediaBase := s.mediaBase()
	srcFull := filepath.Clean(filepath.Join(mediaBase, srcRel))
	if !strings.HasPrefix(srcFull, mediaBase+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid media path")
	}
	variantFull := s.variantFullPath(media.OriginalPath, size)
	if !strings.HasPrefix(variantFull, mediaBase+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid thumbnail path")
	}

	if variantIsFresh(variantFull, srcFull) {
		return variantFull, nil
	}

	key := strconv.FormatInt(media.ID, 10)
	if _, err, _ := s.variantFlight.Do(key, func() (any, error) {
		return nil, s.buildLadder(ctx, media.OriginalPath, srcFull)
	}); err != nil {
		return "", err
	}

	if variantIsFresh(variantFull, srcFull) {
		return variantFull, nil
	}

	// The ladder was built and this rung was not part of it: the source is
	// already at or below this size.
	if !strings.EqualFold(media.FileType, "image") {
		return srcFull, nil
	}
	return "", ErrVariantNotNeeded
}

// buildLadder decodes a source once and writes every rung derived from it.
func (s *MediaService) buildLadder(ctx context.Context, originalPath, srcFull string) error {
	data, err := os.ReadFile(srcFull)
	if err != nil {
		return err
	}
	src, err := s.decodeImage(ctx, data)
	if err != nil {
		return err
	}
	return s.writeLadder(ctx, originalPath, src, srcFull)
}

// writeLadder writes every missing or stale rung from an already-decoded
// source. Callers that already hold one — upload, import, the lazy path above
// — reuse it here, so eager generation costs no extra decode.
//
// srcFull is the source's path for the freshness check; pass "" when the
// source has no settled file yet (an upload writes its original after this
// runs) to write every rung unconditionally.
func (s *MediaService) writeLadder(ctx context.Context, originalPath string, src image.Image, srcFull string) error {
	bounds := src.Bounds()
	longest := maxInt(bounds.Dx(), bounds.Dy())
	quality := imaging.JPEGQuality(s.jpegQuality(ctx))

	var firstErr error
	fail := func(err error) {
		if firstErr == nil {
			firstErr = err
		}
	}

	for _, size := range VariantSizes {
		if size >= longest {
			continue
		}
		full := s.variantFullPath(originalPath, size)
		if srcFull != "" && variantIsFresh(full, srcFull) {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			fail(err)
			continue
		}
		if err := imaging.Save(imaging.Fit(src, size, size, imaging.Lanczos), full, quality); err != nil {
			fail(err)
		}
	}
	return firstErr
}

// removeAllVariants deletes every cached rung derived from a media item.
//
// Every path that destroys, renames or replaces a source must call it: a rung
// is keyed on the original's path and has no DB row, so one left behind is
// invisible and permanent. Best-effort — a missing file is the common case.
func (s *MediaService) removeAllVariants(originalPath string) {
	for _, size := range VariantSizes {
		_ = os.Remove(s.variantFullPath(originalPath, size))
	}
}

// RebuildThumbnails regenerates thumbnails for all image media.
// If onlyMissing is true, skips images that already have a thumbnail.
func (s *MediaService) RebuildThumbnails(ctx context.Context, onlyMissing bool) (map[string]int, error) {
	all, err := s.repo.ListMedia(ctx, models.ListMediaParams{
		TypeFilter: true,
		FileType:   "image",
		Limit:      100000,
		Offset:     0,
	})
	if err != nil {
		return nil, err
	}

	stats := map[string]int{"processed": 0, "skipped": 0, "errors": 0}

	for _, m := range all {
		if onlyMissing && m.ThumbnailPath.Valid {
			stats["skipped"]++
			continue
		}

		origFull := filepath.Join(s.cfg.StoragePath, "media", m.OriginalPath)
		data, err := os.ReadFile(origFull)
		if err != nil {
			stats["errors"]++
			continue
		}

		src, err := s.decodeImage(ctx, data)
		if err != nil {
			stats["errors"]++
			continue
		}

		thumbW, thumbH := s.thumbnailWidth(ctx), s.thumbnailHeight(ctx)
		thumb := imaging.Fill(src, thumbW, thumbH, imaging.Center, imaging.Lanczos)

		// Derive thumbnail path from original
		origRel := m.OriginalPath
		relUnder := strings.TrimPrefix(origRel, "originals/")
		relDir := filepath.Dir(relUnder)
		baseName := fmt.Sprintf("%s_w%dh%d.jpg", strings.TrimSuffix(filepath.Base(origRel), filepath.Ext(origRel)), thumbW, thumbH)
		thumbRel := filepath.Join("thumbnails", relDir, baseName)
		thumbFull := filepath.Join(s.cfg.StoragePath, "media", thumbRel)

		if err := os.MkdirAll(filepath.Dir(thumbFull), 0755); err != nil {
			stats["errors"]++
			continue
		}
		if err := imaging.Save(thumb, thumbFull, imaging.JPEGQuality(s.jpegQuality(ctx))); err != nil {
			stats["errors"]++
			continue
		}

		if m.ThumbnailPath.Valid && m.ThumbnailPath.String != thumbRel {
			_ = os.Remove(filepath.Join(s.cfg.StoragePath, "media", m.ThumbnailPath.String))
		}

		_, _ = s.repo.UpdateMediaFilename(ctx, models.UpdateMediaFilenameParams{
			ID:            m.ID,
			Filename:      m.Filename,
			OriginalPath:  m.OriginalPath,
			ThumbnailPath: sql.NullString{String: thumbRel, Valid: true},
		})

		// Sync with posts: if a post used the original path as its thumbnail,
		// update it to use the new thumbnail variant (with ?thumb suffix).
		barePath := "/" + strings.TrimPrefix(m.OriginalPath, "originals/")
		_, _ = s.repo.UpdatePostThumbnailPath(ctx, barePath, barePath+"?thumb")

		stats["processed"]++
	}

	return stats, nil
}

// AnalysisResponse matches the Python AnalysisResponse schema
type AnalysisResponse struct {
	Title   *string  `json:"title"`
	Tags    []string `json:"tags"`
	Excerpt *string  `json:"excerpt"`
}

var (
	ErrMediaNotFound = kindSentinel(ErrNotFound, "media not found")
	ErrNotAnImage    = kindSentinel(ErrInvalidInput, "media item is not an image")
	ErrNotAVideo     = kindSentinel(ErrInvalidInput, "media item is not a video")
	// A video whose poster frame was never captured — there is no still to
	// serve or derive a variant from.
	ErrNoPoster = kindSentinel(ErrNotFound, "video has no poster frame")
	// The requested rung is at or above the source's longest side, so it was
	// never written: imaging.Fit does not upscale. Callers serve the source.
	ErrVariantNotNeeded = kindSentinel(ErrNotFound, "source is smaller than the requested size")
	// The analysis upstream answered, but not with something we can use.
	ErrResponseUnusable = kindSentinel(ErrUpstream, "the response cannot be used")
)

const maxAnalyzeBytes = 20 << 20 // 20 MB

func (s *MediaService) AnalyzeMediaByID(ctx context.Context, id int64) (*AnalysisResponse, error) {
	media, err := s.getMedia(ctx, id)
	if err != nil {
		return nil, ErrMediaNotFound
	}
	if !strings.EqualFold(media.FileType, "image") {
		return nil, ErrNotAnImage
	}
	fullPath := filepath.Join(s.cfg.StoragePath, "media", media.OriginalPath)
	info, err := os.Stat(fullPath)
	if err != nil {
		return nil, fmt.Errorf("could not stat media file: %w", err)
	}
	if info.Size() > maxAnalyzeBytes {
		return nil, wrapKind(ErrInvalidInput, fmt.Errorf("image too large for analysis (%d bytes, max %d)", info.Size(), maxAnalyzeBytes))
	}
	content, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, fmt.Errorf("could not read media file: %w", err)
	}
	return s.AnalyzeImage(ctx, content, media.Filename, media.MimeType)
}

// AnalyzeMediaByPath reads a stored media file by its URL path (e.g. "/2024/08/photo.jpg")
// and analyzes it. The path must be within the originals directory.
func (s *MediaService) AnalyzeMediaByPath(ctx context.Context, mediaPath string) (*AnalysisResponse, error) {
	base := filepath.Clean(filepath.Join(s.cfg.StoragePath, "media", "originals"))
	fullPath := filepath.Clean(filepath.Join(base, strings.TrimPrefix(filepath.FromSlash(mediaPath), "/")))
	if !strings.HasPrefix(fullPath, base+string(filepath.Separator)) {
		return nil, fmt.Errorf("invalid media path")
	}

	info, err := os.Stat(fullPath)
	if err != nil {
		return nil, wrapKind(ErrNotFound, errors.New("media file not found"))
	}
	if info.Size() > maxAnalyzeBytes {
		return nil, wrapKind(ErrInvalidInput, fmt.Errorf("image too large for analysis (%d bytes, max %d)", info.Size(), maxAnalyzeBytes))
	}

	content, err := os.ReadFile(fullPath)
	if err != nil {
		return nil, fmt.Errorf("could not read media file: %w", err)
	}

	mimeType := http.DetectContentType(content)
	if !strings.HasPrefix(mimeType, "image/") {
		return nil, ErrNotAnImage
	}

	return s.AnalyzeImage(ctx, content, filepath.Base(fullPath), mimeType)
}

func (s *MediaService) AnalyzeImage(ctx context.Context, content []byte, filename, mimeType string) (*AnalysisResponse, error) {
	apiKey, _ := s.settingsService.GetSecret(ctx, "gemini_api_key")

	var analysis *AnalysisResponse
	var err error

	if apiKey != "" && len(s.genaiConfig.Models) > 0 {
		client, initErr := genai.NewClient(ctx, &genai.ClientConfig{
			APIKey:  apiKey,
			Backend: genai.BackendGeminiAPI,
		})
		if initErr == nil {
			analysis, err = s.analyzeImageDirectlyWithClient(ctx, client, content, filename, mimeType)
		} else {
			err = initErr
		}
	} else if s.genaiClient != nil && len(s.genaiConfig.Models) > 0 {
		// Fallback to pre-initialized client if any
		analysis, err = s.analyzeImageDirectlyWithClient(ctx, s.genaiClient, content, filename, mimeType)
	} else {
		slog.Warn("AI features disabled (gemini_api_key is absent)")
		return &AnalysisResponse{Tags: []string{}}, nil
	}

	if err != nil {
		if errors.Is(err, ErrResponseUnusable) {
			return nil, err
		}
		// Check if it's an authorization/authentication error
		var apiErr *googleapi.Error
		if errors.As(err, &apiErr) && (apiErr.Code == 400 || apiErr.Code == 401 || apiErr.Code == 403) {
			slog.Warn("AI features disabled (GEMINI_API_KEY is wrong or lacks permissions)", "error", err)
		} else {
			slog.Warn("AI features soft-failed", "error", err)
		}
		return &AnalysisResponse{Tags: []string{}}, nil
	}

	return analysis, nil
}

// allowedContentRune returns r if it is permitted in AI-related text fields,
// normalizes whitespace to a plain space, and drops everything else.
// Allowed: letters, digits, whitespace, and . , - – — ' ? !
func allowedContentRune(r rune) rune {
	if unicode.IsLetter(r) || unicode.IsDigit(r) {
		return r
	}
	if unicode.IsSpace(r) {
		return ' '
	}
	switch r {
	case '.', ',', '-', '–', '—', '\'', '?', '!', ':', ';':
		return r
	}
	return -1
}

// sanitizeContentString applies the allowedContentRune filter and collapses
// runs of whitespace into single spaces.
func sanitizeContentString(s string) string {
	s = strings.Map(allowedContentRune, s)
	return strings.Join(strings.Fields(s), " ")
}

// sanitizePromptField sanitizes a user-supplied prompt snippet before it is
// embedded in the Gemini prompt, and limits its length.
func sanitizePromptField(s string) string {
	s = sanitizeContentString(s)
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}

func (s *MediaService) analyzeImageDirectlyWithClient(ctx context.Context, client *genai.Client, content []byte, filename, mimeType string) (*AnalysisResponse, error) {
	prompt := s.genaiConfig.Prompt
	if s.settingsService != nil {
		titlePart, _ := s.settingsService.GetSetting(ctx, "gemini_prompt_title", "")
		tagsPart, _ := s.settingsService.GetSetting(ctx, "gemini_prompt_tags", "")
		excerptPart, _ := s.settingsService.GetSetting(ctx, "gemini_prompt_excerpt", "")
		titlePart = sanitizePromptField(titlePart)
		tagsPart = sanitizePromptField(tagsPart)
		excerptPart = sanitizePromptField(excerptPart)
		if titlePart != "" || tagsPart != "" || excerptPart != "" {
			if titlePart == "" {
				titlePart = "a concise, descriptive title"
			}
			if tagsPart == "" {
				tagsPart = "relevant keyword tags"
			}
			if excerptPart == "" {
				excerptPart = "a 1-2 sentence description"
			}
			prompt = "Analyze this image and return a JSON object.\n" +
				`"title" (string): ` + titlePart + "\n" +
				`"tags" (array of strings): ` + tagsPart + "\n" +
				`"excerpt" (string): ` + excerptPart + "\n" +
				"Return only valid JSON, no markdown or extra text."
		}
	}
	parts := []*genai.Part{
		{Text: prompt},
		{InlineData: &genai.Blob{
			Data:     content,
			MIMEType: mimeType,
		}},
	}
	contents := []*genai.Content{{Parts: parts}}

	var genResp *genai.GenerateContentResponse
	var genErr error

	for _, model := range s.genaiConfig.Models {
		genResp, genErr = client.Models.GenerateContent(ctx,
			model,
			contents,
			&genai.GenerateContentConfig{
				ResponseMIMEType: "application/json",
			},
		)

		if genErr == nil {
			break
		}

		// Check if this is a 429 error (quota exceeded)
		var apiErr *googleapi.Error
		if errors.As(genErr, &apiErr) && apiErr.Code == 429 {
			continue
		}

		// For non-429 errors, stop trying and return the error
		break
	}

	if genErr != nil {
		return nil, fmt.Errorf("all models failed: last error: %w", genErr)
	}

	if len(genResp.Candidates) == 0 || len(genResp.Candidates[0].Content.Parts) == 0 {
		return nil, wrapKind(ErrUpstream, errors.New("no content generated"))
	}

	// Extract text from response
	var respText strings.Builder
	for _, part := range genResp.Candidates[0].Content.Parts {
		respText.WriteString(part.Text)
	}

	var result map[string]interface{}
	if err := json.Unmarshal([]byte(respText.String()), &result); err != nil {
		return nil, fmt.Errorf("failed to parse API response: %w", err)
	}

	return s.parseAnalysisResult(result, filename)
}

func (s *MediaService) parseAnalysisResult(result map[string]interface{}, filename string) (*AnalysisResponse, error) {
	// Require exactly title, tags, excerpt — no extra keys.
	if len(result) != 3 {
		return nil, ErrResponseUnusable
	}
	titleRaw, hasTitle := result["title"].(string)
	tagsRaw, hasTags := result["tags"].([]interface{})
	excerptRaw, hasExcerpt := result["excerpt"].(string)
	if !hasTitle || !hasTags || !hasExcerpt {
		return nil, ErrResponseUnusable
	}

	analysis := &AnalysisResponse{Tags: []string{}}

	t := sanitizeContentString(titleRaw)
	analysis.Title = &t

	for _, tag := range tagsRaw {
		if str, ok := tag.(string); ok {
			if clean := sanitizeContentString(str); clean != "" {
				analysis.Tags = append(analysis.Tags, clean)
			}
		}
	}

	e := sanitizeContentString(excerptRaw)
	analysis.Excerpt = &e

	// Detect year tag from filename (starts with 20##)
	re := regexp.MustCompile(`^(20\d{2})`)
	if match := re.FindStringSubmatch(filename); len(match) > 1 {
		yearTag := match[1]
		found := false
		for _, t := range analysis.Tags {
			if t == yearTag {
				found = true
				break
			}
		}
		if !found {
			analysis.Tags = append([]string{yearTag}, analysis.Tags...)
		}
	}

	return analysis, nil
}

// mediaPathRe matches media paths embedded in post content.
// Paths can appear as bare lines (/YYYY/MM/file) or inside markdown/HTML
// (![alt](/YYYY/MM/file) or src="/YYYY/MM/file"). Trailing markup chars are excluded.
var mediaPathRe = regexp.MustCompile(`(/\d{4}/\d{2}/[^\s)"'>]+(?:[ \t]+[^\s)"'>]+)*)`)

// ExtractMediaPaths returns the distinct set of original_paths (in the DB
// format "originals/YYYY/MM/file") referenced in content and thumbnailPath.
func ExtractMediaPaths(content, thumbnailPath string) []string {
	seen := make(map[string]struct{})
	var paths []string
	add := func(p string) {
		// p is "/YYYY/MM/file" — media table stores "originals/YYYY/MM/file"
		orig := "originals" + p
		if _, ok := seen[orig]; !ok {
			seen[orig] = struct{}{}
			paths = append(paths, orig)
		}
	}
	for _, m := range mediaPathRe.FindAllStringSubmatch(content, -1) {
		add(m[1])
	}
	if thumbnailPath != "" {
		add(thumbnailPath)
	}
	return paths
}

// UpdateMediaVisibilityForPaths updates is_public for all media records
// referenced by the given original_paths (format "originals/YYYY/MM/file").
// It checks all published posts to determine current public visibility.
func (s *MediaService) UpdateMediaVisibilityForPaths(ctx context.Context, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	snap, err := s.tagService.GetTagSnapshot(ctx)
	if err != nil {
		return err
	}
	hiddenTagIDs := snap.EffectiveHidesPosts
	posts, err := s.repo.GetAllPublishedPostContents(ctx)
	if err != nil {
		return err
	}
	// Collect which paths appear in at least one publicly visible post.
	visiblePaths := make(map[string]int64) // original_path → triggering post ID
	for _, post := range posts {
		hiddenByTag := false
		for _, tagID := range post.TagIDs {
			if hiddenTagIDs[tagID] {
				hiddenByTag = true
				break
			}
		}
		if hiddenByTag {
			continue
		}
		for _, m := range mediaPathRe.FindAllStringSubmatch(post.Content, -1) {
			orig := "originals" + m[1]
			if _, seen := visiblePaths[orig]; !seen {
				visiblePaths[orig] = post.ID
			}
		}
		if post.ThumbnailPath != "" {
			orig := "originals" + post.ThumbnailPath
			if _, seen := visiblePaths[orig]; !seen {
				visiblePaths[orig] = post.ID
			}
		}
	}
	// One IN query for the whole set. Doing this per path was a full scan each
	// (before media.original_path was indexed) and is still a round trip each —
	// a 30-image post meant 30 of them.
	records, err := s.repo.GetMediaByPaths(ctx, paths)
	if err != nil {
		return err
	}
	for _, m := range records {
		postID, shouldBePublic := visiblePaths[m.OriginalPath]
		if (m.IsPublic != 0) != shouldBePublic {
			var pid *int64
			if shouldBePublic {
				pid = &postID
			}
			if err := s.repo.SetMediaPublic(ctx, m.ID, shouldBePublic, pid); err != nil {
				slog.Warn("failed to update media visibility", "media_id", m.ID, "error", err)
			}
		}
	}
	return nil
}

// RecalculateAllMediaVisibility rebuilds is_public for every media record from
// scratch by scanning all published visible posts. Returns count of changed records.
func (s *MediaService) RecalculateAllMediaVisibility(ctx context.Context) (int, error) {
	snap, err := s.tagService.GetTagSnapshot(ctx)
	if err != nil {
		return 0, err
	}
	hiddenTagIDs := snap.EffectiveHidesPosts
	posts, err := s.repo.GetAllPublishedPostContents(ctx)
	if err != nil {
		return 0, err
	}
	visiblePaths := make(map[string]int64)
	for _, post := range posts {
		hiddenByTag := false
		for _, tagID := range post.TagIDs {
			if hiddenTagIDs[tagID] {
				hiddenByTag = true
				break
			}
		}
		if hiddenByTag {
			continue
		}
		for _, m := range mediaPathRe.FindAllStringSubmatch(post.Content, -1) {
			orig := "originals" + m[1]
			if _, seen := visiblePaths[orig]; !seen {
				visiblePaths[orig] = post.ID
			}
		}
		if post.ThumbnailPath != "" {
			orig := "originals" + post.ThumbnailPath
			if _, seen := visiblePaths[orig]; !seen {
				visiblePaths[orig] = post.ID
			}
		}
	}
	allMedia, err := s.repo.GetAllMediaPaths(ctx)
	if err != nil {
		return 0, err
	}
	changed := 0
	for _, m := range allMedia {
		postID, shouldBePublic := visiblePaths[m.OriginalPath]
		if (m.IsPublic != 0) != shouldBePublic {
			var pid *int64
			if shouldBePublic {
				pid = &postID
			}
			if err := s.repo.SetMediaPublic(ctx, m.ID, shouldBePublic, pid); err == nil {
				changed++
			}
		}
	}
	return changed, nil
}

// safeImagingDecode wraps imaging.Decode to convert panics into errors.
// The imaging library can panic on crafted TIFF files (CVE-2023-36308) and
// there is no patched upstream version as of 2026-05.
//
// It bounds nothing on its own. Production callers go through
// MediaService.decodeImage, which adds the pixel guard and the concurrency
// limit; this stays exported to the package for the decode paths that have
// already been bounded and for tests of the panic guard itself.
func safeImagingDecode(r io.Reader) (img image.Image, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("image decode panic: %v", rec)
		}
	}()
	return imaging.Decode(r)
}

// defaultMaxImageMegapixels is the pixel ceiling used when the operator has
// not set MAX_IMAGE_MEGAPIXELS. Generous for a blog — a 100 MP phone panorama
// is above it, nothing else realistically is.
const defaultMaxImageMegapixels = 80

// decodeSem bounds how many image decodes run at once, process-wide. It is a
// package-level counting semaphore rather than a MediaService field on
// purpose: the bound that matters is on the machine's memory, and a second
// service instance must not double it.
//
// Sizing: one decode holds roughly 4 bytes per pixel for the source plus the
// resize destination, so GOMAXPROCS in flight is already the point where more
// parallelism stops buying throughput and starts buying resident memory.
var decodeSem = make(chan struct{}, maxInt(1, runtime.GOMAXPROCS(0)))

// decodeObserver is called once per decode that gets past the pixel guard.
// It is nil in production; tests set it to count decodes, which is how the
// "one decode produces the whole ladder" guarantee is asserted from the
// outside. A package-level var rather than a service field because decodeSem
// is package-level for the same reason: the property under test is a property
// of the process, not of one MediaService.
var decodeObserver func()

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// maxImagePixels returns the configured pixel ceiling, or 0 when the check is
// disabled.
func (s *MediaService) maxImagePixels() int64 {
	mp := defaultMaxImageMegapixels
	if s.cfg != nil && s.cfg.MaxImageMegapixels != 0 {
		mp = s.cfg.MaxImageMegapixels
	}
	if mp < 0 {
		return 0
	}
	return int64(mp) * 1_000_000
}

// decodeImage decodes an image with the two bounds a public upload path needs:
// a pixel ceiling checked from the header before anything is allocated, and a
// cap on how many decodes run concurrently.
//
// The body limit upstream bounds bytes on the wire, not pixels in memory —
// JPEG compresses ~10-20x, so an upload well inside the limit can still carry
// enough pixels to exhaust a memory-capped container. image.DecodeConfig reads
// only the header, so an oversized image costs a few bytes to reject instead
// of a ~400 MB RGBA allocation to discover.
//
// This lives here rather than in the HTTP handler because the Instagram
// importer reaches the same decode with images the operator never chose.
func (s *MediaService) decodeImage(ctx context.Context, data []byte) (image.Image, error) {
	if limit := s.maxImagePixels(); limit > 0 {
		cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil {
			// Unreadable header. Fall through to the full decode, which
			// produces the caller's usual decode error rather than a
			// misleading "too large".
			slog.Debug("image header unreadable, skipping pixel guard", "error", err)
		} else if cfg.Width > 0 && cfg.Height > 0 {
			if px := int64(cfg.Width) * int64(cfg.Height); px > limit {
				return nil, wrapKind(ErrTooLarge, fmt.Errorf(
					"image too large: %d megapixels (%dx%d), limit %d megapixels",
					(px+999_999)/1_000_000, cfg.Width, cfg.Height, limit/1_000_000))
			}
		}
	}

	if decodeObserver != nil {
		decodeObserver()
	}

	select {
	case decodeSem <- struct{}{}:
		defer func() { <-decodeSem }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	return safeImagingDecode(bytes.NewReader(data))
}
