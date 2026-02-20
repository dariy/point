package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
)

type MediaService struct {
	repo            *repository.Repository
	cfg             *config.Config
	settingsService *SettingsService
}

func NewMediaService(repo *repository.Repository, cfg *config.Config, settingsService *SettingsService) *MediaService {
	return &MediaService{
		repo:            repo,
		cfg:             cfg,
		settingsService: settingsService,
	}
}

func CalculateChecksum(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
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

	now := time.Now()
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

	// Process image
	var width, height sql.NullInt64
	var thumbnailRelPath sql.NullString
	fileType := "file"

	if strings.HasPrefix(p.MimeType, "image/") {
		fileType = "image"
		// Load image
		src, err := imaging.Decode(bytes.NewReader(p.Content))
		if err == nil {
			bounds := src.Bounds()
			width = sql.NullInt64{Int64: int64(bounds.Dx()), Valid: true}
			height = sql.NullInt64{Int64: int64(bounds.Dy()), Valid: true}

			// Generate thumbnail
			thumb := imaging.Fill(src, s.cfg.ThumbnailWidth, s.cfg.ThumbnailHeight, imaging.Center, imaging.Lanczos)
			thumbFilename := strings.TrimSuffix(uniqueFilename, filepath.Ext(uniqueFilename)) + ".jpg"
			thumbRel := filepath.Join("thumbnails", datePath, thumbFilename)
			thumbFull := filepath.Join(s.cfg.StoragePath, "media", thumbRel)

			if err := imaging.Save(thumb, thumbFull); err == nil {
				thumbnailRelPath = sql.NullString{String: thumbRel, Valid: true}
			}
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
		Filename:      p.Filename,
		OriginalPath:  originalRelPath,
		ThumbnailPath: thumbnailRelPath,
		FileType:      fileType,
		MimeType:      p.MimeType,
		FileSize:      int64(len(p.Content)),
		Width:         width,
		Height:        height,
		PostID:        postID,
		Checksum:      checksum,
		AltText:       sql.NullString{String: p.AltText, Valid: p.AltText != ""},
		Caption:       sql.NullString{String: p.Caption, Valid: p.Caption != ""},
		UploadedAt:    now,
	})
}

func (s *MediaService) GetMediaByID(ctx context.Context, id int64) (models.Medium, error) {
	return s.repo.GetMedia(ctx, id)
}

type ListMediaParams struct {
	Page     int32
	PerPage  int32
	FileType string
}

func (s *MediaService) ListMedia(ctx context.Context, p ListMediaParams) ([]models.Medium, int64, error) {
	offset := (p.Page - 1) * p.PerPage
	media, err := s.repo.ListMedia(ctx, models.ListMediaParams{
		TypeFilter: p.FileType != "",
		FileType:   p.FileType,
		Limit:      int64(p.PerPage),
		Offset:     int64(offset),
	})
	if err != nil {
		return nil, 0, err
	}

	total, err := s.repo.CountMedia(ctx, models.CountMediaParams{
		TypeFilter: p.FileType != "",
		FileType:   p.FileType,
	})
	if err != nil {
		return nil, 0, err
	}

	return media, total, nil
}

type UpdateMediaParams struct {
	ID      int64
	AltText string
	Caption string
	PostID  *int64
}

func (s *MediaService) UpdateMedia(ctx context.Context, p UpdateMediaParams) (models.Medium, error) {
	var postID sql.NullInt64
	if p.PostID != nil {
		postID = sql.NullInt64{Int64: *p.PostID, Valid: true}
	}
	return s.repo.UpdateMedia(ctx, models.UpdateMediaParams{
		ID:      p.ID,
		AltText: sql.NullString{String: p.AltText, Valid: p.AltText != ""},
		Caption: sql.NullString{String: p.Caption, Valid: p.Caption != ""},
		PostID:  postID,
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
	TotalBytes  int64 `json:"total_bytes"`
	TotalFiles  int64 `json:"total_files"`
	ImageCount  int64 `json:"image_count"`
	VideoCount  int64 `json:"video_count"`
	AudioCount  int64 `json:"audio_count"`
	OtherCount  int64 `json:"other_count"`
}

func (s *MediaService) GetStorageStats(ctx context.Context) (StorageStats, error) {
	const q = `
SELECT
  COALESCE(SUM(file_size), 0) as total_bytes,
  COUNT(*) as total_files,
  COALESCE(SUM(CASE WHEN file_type = 'image' THEN 1 ELSE 0 END), 0) as image_count,
  COALESCE(SUM(CASE WHEN file_type = 'video' THEN 1 ELSE 0 END), 0) as video_count,
  COALESCE(SUM(CASE WHEN file_type = 'audio' THEN 1 ELSE 0 END), 0) as audio_count,
  COALESCE(SUM(CASE WHEN file_type NOT IN ('image','video','audio') THEN 1 ELSE 0 END), 0) as other_count
FROM media`

	var st StorageStats
	err := s.repo.DB().QueryRowContext(ctx, q).Scan(
		&st.TotalBytes, &st.TotalFiles,
		&st.ImageCount, &st.VideoCount, &st.AudioCount, &st.OtherCount,
	)
	return st, err
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

	return s.repo.UpdateMediaFilename(ctx, models.UpdateMediaFilenameParams{
		ID:            id,
		Filename:      newBase,
		OriginalPath:  newOrigRel,
		ThumbnailPath: newThumbRel,
	})
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

		src, err := imaging.Decode(bytes.NewReader(data))
		if err != nil {
			stats["errors"]++
			continue
		}

		thumb := imaging.Fill(src, s.cfg.ThumbnailWidth, s.cfg.ThumbnailHeight, imaging.Center, imaging.Lanczos)

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
		if err := imaging.Save(thumb, thumbFull); err != nil {
			stats["errors"]++
			continue
		}

		_, _ = s.repo.UpdateMediaFilename(ctx, models.UpdateMediaFilenameParams{
			ID:            m.ID,
			Filename:      m.Filename,
			OriginalPath:  m.OriginalPath,
			ThumbnailPath: sql.NullString{String: thumbRel, Valid: true},
		})
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

func (s *MediaService) AnalyzeImage(ctx context.Context, content []byte, filename, mimeType string) (*AnalysisResponse, error) {
	endpoint, err := s.settingsService.GetSetting(ctx, "genai_api_endpoint", "")
	if err != nil || endpoint == "" {
		return nil, fmt.Errorf("GenAI API endpoint not configured")
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, err := writer.CreateFormFile("image", filename)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(part, bytes.NewReader(content)); err != nil {
		return nil, err
	}
	writer.Close()

	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", writer.FormDataContentType())

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GenAI service error: status %d", resp.StatusCode)
	}

	var raw map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, err
	}

	// Handle common wrappers
	result := raw
	for _, wrapper := range []string{"data", "result", "output", "response"} {
		if inner, ok := result[wrapper].(map[string]interface{}); ok {
			result = inner
			break
		}
	}

	analysis := &AnalysisResponse{Tags: []string{}}

	if t, ok := result["title"].(string); ok {
		analysis.Title = &t
	}

	if tags, ok := result["tags"].([]interface{}); ok {
		for _, t := range tags {
			if s, ok := t.(string); ok {
				analysis.Tags = append(analysis.Tags, s)
			}
		}
	}

	if e, ok := result["excerpt"].(string); ok {
		analysis.Excerpt = &e
	} else {
		// Map alternative keys to excerpt if missing
		for _, key := range []string{"summary", "description", "caption", "text", "content"} {
			if e, ok := result[key].(string); ok {
				analysis.Excerpt = &e
				break
			}
		}
	}

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
