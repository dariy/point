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
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"

	"github.com/disintegration/imaging"
	"github.com/rwcarlsen/goexif/exif"
	"google.golang.org/api/googleapi"
	"google.golang.org/genai"
	"gopkg.in/yaml.v3"
)

type MediaService struct {
	repo            *repository.Repository
	cfg             *config.Config
	settingsService *SettingsService
	tagService      *TagService
	genaiClient     *genai.Client
	genaiConfig     GenAIConfig
}

type GenAIConfig struct {
	Prompt string   `yaml:"prompt"`
	Models []string `yaml:"models"`
}

func NewMediaService(repo *repository.Repository, cfg *config.Config, settingsService *SettingsService, tagService *TagService) *MediaService {
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

func (s *MediaService) extractEXIF(r io.Reader) map[string]interface{} {
	metadata := make(map[string]interface{})
	x, err := exif.Decode(r)
	if err != nil {
		return metadata
	}

	// Helper to extract string tags
	getString := func(tag exif.FieldName) {
		val, err := x.Get(tag)
		if err == nil {
			// val.String() often includes quotes for strings, or is a rational/int.
			// For a generic metadata map, we just take the string representation.
			metadata[string(tag)] = sanitizeEXIFValue(strings.Trim(val.String(), "\""))
		}
	}

	getString(exif.Make)
	getString(exif.Model)
	getString(exif.Software)
	getString(exif.DateTimeOriginal)
	getString(exif.Orientation)
	getString(exif.ExposureTime)
	getString(exif.FNumber)
	getString(exif.ISOSpeedRatings)
	getString(exif.FocalLength)

	// Lat/Long
	lat, long, err := x.LatLong()
	if err == nil {
		metadata["GPSLatitude"] = lat
		metadata["GPSLongitude"] = long
	}

	return metadata
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
	thumbnailsDir := filepath.Join(s.cfg.StoragePath, "media", "thumbnails", datePath)

	if err := os.MkdirAll(originalsDir, 0755); err != nil {
		return models.Medium{}, err
	}
	if err := os.MkdirAll(thumbnailsDir, 0755); err != nil {
		return models.Medium{}, err
	}

	uniqueFilename := fmt.Sprintf("%d_%s", now.Unix(), p.Filename)
	originalRelPath := filepath.Join("originals", datePath, uniqueFilename)
	originalFullPath := filepath.Join(s.cfg.StoragePath, "media", originalRelPath)

	// Process media
	var width, height sql.NullInt64
	var thumbnailRelPath sql.NullString
	var metadata map[string]interface{}
	fileType := "file"

	if strings.HasPrefix(p.MimeType, "image/") {
		fileType = "image"
		// Load image for dimensions and thumbnail
		src, err := safeImagingDecode(bytes.NewReader(p.Content))
		if err == nil {
			bounds := src.Bounds()
			width = sql.NullInt64{Int64: int64(bounds.Dx()), Valid: true}
			height = sql.NullInt64{Int64: int64(bounds.Dy()), Valid: true}

			// Generate thumbnail (skip if either dimension is 0 — use original instead)
			thumbW, thumbH := s.thumbnailWidth(ctx), s.thumbnailHeight(ctx)
			if thumbW > 0 && thumbH > 0 {
				thumb := imaging.Fill(src, thumbW, thumbH, imaging.Center, imaging.Lanczos)
				thumbFilename := strings.TrimSuffix(uniqueFilename, filepath.Ext(uniqueFilename)) + ".jpg"
				thumbRel := filepath.Join("thumbnails", datePath, thumbFilename)
				thumbFull := filepath.Join(s.cfg.StoragePath, "media", thumbRel)
				if err := imaging.Save(thumb, thumbFull, imaging.JPEGQuality(s.jpegQuality(ctx))); err == nil {
					thumbnailRelPath = sql.NullString{String: thumbRel, Valid: true}
				}
			}
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

	var postID sql.NullInt64
	if p.PostID != nil {
		postID = sql.NullInt64{Int64: *p.PostID, Valid: true}
	}

	// Save to DB
	return s.repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:         p.Filename,
		OriginalPath:     originalRelPath,
		ThumbnailPath:    thumbnailRelPath,
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
	thumbnailsDir := filepath.Join(s.cfg.StoragePath, "media", "thumbnails", datePath)

	if err := os.MkdirAll(originalsDir, 0755); err != nil {
		return models.Medium{}, err
	}
	if err := os.MkdirAll(thumbnailsDir, 0755); err != nil {
		return models.Medium{}, err
	}

	uniqueFilename := fmt.Sprintf("%d_%s", now.Unix(), filename)
	originalRelPath := filepath.Join("originals", datePath, uniqueFilename)
	originalFullPath := filepath.Join(s.cfg.StoragePath, "media", originalRelPath)

	var width, height sql.NullInt64
	var thumbnailRelPath sql.NullString
	var metadata map[string]interface{}
	fileType := "file"

	if strings.HasPrefix(mimeType, "image/") {
		fileType = "image"
		src, err := safeImagingDecode(bytes.NewReader(content))
		if err == nil {
			bounds := src.Bounds()
			width = sql.NullInt64{Int64: int64(bounds.Dx()), Valid: true}
			height = sql.NullInt64{Int64: int64(bounds.Dy()), Valid: true}

			thumb := imaging.Fill(src, s.cfg.ThumbnailWidth, s.cfg.ThumbnailHeight, imaging.Center, imaging.Lanczos)
			thumbFilename := strings.TrimSuffix(uniqueFilename, filepath.Ext(uniqueFilename)) + ".jpg"
			thumbRel := filepath.Join("thumbnails", datePath, thumbFilename)
			thumbFull := filepath.Join(s.cfg.StoragePath, "media", thumbRel)

			if err := imaging.Save(thumb, thumbFull); err == nil {
				thumbnailRelPath = sql.NullString{String: thumbRel, Valid: true}
			}
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

	if err := os.WriteFile(originalFullPath, content, 0644); err != nil {
		return models.Medium{}, err
	}

	return s.repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:         filename,
		OriginalPath:     originalRelPath,
		ThumbnailPath:    thumbnailRelPath,
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
	return s.repo.GetMedia(ctx, id)
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
	media, err := s.repo.GetMedia(ctx, id)
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
	media, err := s.repo.GetMedia(ctx, p.ID)
	if err != nil {
		return models.Medium{}, fmt.Errorf("get media: %w", err)
	}

	// Validate: all values must already be clean alphanumeric+space
	sanitized := make(map[string]interface{}, len(p.Fields))
	for k, v := range p.Fields {
		if sanitizeEXIFValue(v) != v {
			return models.Medium{}, fmt.Errorf("field %q contains disallowed characters: only alphanumeric and space allowed", k)
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
	media, err := s.repo.GetMedia(ctx, id)
	if err != nil {
		return models.Medium{}, fmt.Errorf("get media: %w", err)
	}

	if !media.OriginalMetadata.Valid || media.OriginalMetadata.String == "" {
		return models.Medium{}, fmt.Errorf("no original metadata to revert to")
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
	media, err := s.repo.GetMedia(ctx, id)
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
	m, err := s.repo.GetMedia(ctx, id)
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

	// Rename thumbnail if present
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

		src, err := safeImagingDecode(bytes.NewReader(data))
		if err != nil {
			stats["errors"]++
			continue
		}

		thumb := imaging.Fill(src, s.thumbnailWidth(ctx), s.thumbnailHeight(ctx), imaging.Center, imaging.Lanczos)

		// Derive thumbnail path from original
		origRel := m.OriginalPath
		relUnder := strings.TrimPrefix(origRel, "originals/")
		relDir := filepath.Dir(relUnder)
		baseName := strings.TrimSuffix(filepath.Base(origRel), filepath.Ext(origRel)) + ".jpg"
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
	ErrMediaNotFound    = errors.New("media not found")
	ErrNotAnImage       = errors.New("media item is not an image")
	ErrResponseUnusable = errors.New("the response cannot be used")
)

const maxAnalyzeBytes = 20 << 20 // 20 MB

func (s *MediaService) AnalyzeMediaByID(ctx context.Context, id int64) (*AnalysisResponse, error) {
	media, err := s.repo.GetMedia(ctx, id)
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
		return nil, fmt.Errorf("image too large for analysis (%d bytes, max %d)", info.Size(), maxAnalyzeBytes)
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
		return nil, fmt.Errorf("media file not found")
	}
	if info.Size() > maxAnalyzeBytes {
		return nil, fmt.Errorf("image too large for analysis (%d bytes, max %d)", info.Size(), maxAnalyzeBytes)
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
		log.Printf("warning: AI features disabled (gemini_api_key is absent)")
		return &AnalysisResponse{Tags: []string{}}, nil
	}

	if err != nil {
		if errors.Is(err, ErrResponseUnusable) {
			return nil, err
		}
		// Check if it's an authorization/authentication error
		var apiErr *googleapi.Error
		if errors.As(err, &apiErr) && (apiErr.Code == 400 || apiErr.Code == 401 || apiErr.Code == 403) {
			log.Printf("warning: AI features disabled (GEMINI_API_KEY is wrong or lacks permissions): %v", err)
		} else {
			log.Printf("warning: AI features soft-failed: %v", err)
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
		if apiErr, ok := genErr.(*googleapi.Error); ok && apiErr.Code == 429 {
			continue
		}

		// For non-429 errors, stop trying and return the error
		break
	}

	if genErr != nil {
		return nil, fmt.Errorf("all models failed: last error: %w", genErr)
	}

	if len(genResp.Candidates) == 0 || len(genResp.Candidates[0].Content.Parts) == 0 {
		return nil, fmt.Errorf("no content generated")
	}

	// Extract text from response
	var respText strings.Builder
	for _, part := range genResp.Candidates[0].Content.Parts {
		respText.WriteString(part.Text)
	}

	var result map[string]interface{}
	if err := json.Unmarshal([]byte(respText.String()), &result); err != nil {
		return nil, fmt.Errorf("failed to parse API response: %v", err)
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
var mediaPathRe = regexp.MustCompile(`(/\d{4}/\d{2}/[^\s)"'>]+)`)

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
	hiddenTagIDs, err := s.tagService.EffectivelyHiddenPostsTagIDs(ctx)
	if err != nil {
		return err
	}
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
	for _, path := range paths {
		m, err := s.repo.GetMediaByPath(ctx, path)
		if err != nil {
			continue // no DB record for this path, skip
		}
		postID, shouldBePublic := visiblePaths[path]
		if (m.IsPublic != 0) != shouldBePublic {
			var pid *int64
			if shouldBePublic {
				pid = &postID
			}
			if err := s.repo.SetMediaPublic(ctx, m.ID, shouldBePublic, pid); err != nil {
				log.Printf("warning: failed to update media %d visibility: %v", m.ID, err)
			}
		}
	}
	return nil
}

// RecalculateAllMediaVisibility rebuilds is_public for every media record from
// scratch by scanning all published visible posts. Returns count of changed records.
func (s *MediaService) RecalculateAllMediaVisibility(ctx context.Context) (int, error) {
	hiddenTagIDs, err := s.tagService.EffectivelyHiddenPostsTagIDs(ctx)
	if err != nil {
		return 0, err
	}
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
func safeImagingDecode(r io.Reader) (img image.Image, err error) {
	defer func() {
		if rec := recover(); rec != nil {
			err = fmt.Errorf("image decode panic: %v", rec)
		}
	}()
	return imaging.Decode(r)
}
