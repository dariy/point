package api

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/repository"
	"point-api/internal/services"
)

type SystemHandler struct {
	repo            *repository.Repository
	mediaService    *services.MediaService
	postService     *services.PostService
	settingsService *services.SettingsService
	tagService      *services.TagService
	dataPath        string
	logPath         string
	appVersion      string
}

var startTime = time.Now()

func NewSystemHandler(repo *repository.Repository, mediaService *services.MediaService, postService *services.PostService, settingsService *services.SettingsService, tagService *services.TagService, dataPath string, appVersion string) *SystemHandler {
	return &SystemHandler{
		repo:            repo,
		mediaService:    mediaService,
		postService:     postService,
		settingsService: settingsService,
		tagService:      tagService,
		dataPath:        dataPath,
		logPath:         filepath.Join(dataPath, "logs", "app.log"),
		appVersion:      appVersion,
	}
}

// versionCheckCache is the structure stored in blog_settings under _version_check_cached.
type versionCheckCache struct {
	Latest    string    `json:"latest"`
	CheckedAt time.Time `json:"checked_at"`
}

// GetVersion returns the running version and the latest available version from GitHub.
// The GitHub response is cached in blog_settings for 24 hours to avoid hammering the API.
func (h *SystemHandler) GetVersion(c echo.Context) error {
	ctx := c.Request().Context()
	current := h.appVersion

	// Try to load cached GitHub release info.
	var cache versionCheckCache
	cacheStr, _ := h.settingsService.GetSetting(ctx, "_version_check_cached", "")
	if cacheStr != "" {
		_ = json.Unmarshal([]byte(cacheStr), &cache)
	}

	// Refresh if cache is missing or stale (>24h).
	if cache.Latest == "" || time.Since(cache.CheckedAt) > 24*time.Hour {
		latest, err := fetchLatestGitHubRelease()
		if err == nil {
			cache.Latest = latest
			cache.CheckedAt = time.Now()
			if b, marshalErr := json.Marshal(cache); marshalErr == nil {
				_ = h.settingsService.SetSetting(ctx, "_version_check_cached", string(b), "string")
			}
		}
		// On fetch failure: keep existing cache.Latest (may be empty string).
	}

	updateAvailable := cache.Latest != "" && cache.Latest != current

	return c.JSON(http.StatusOK, map[string]interface{}{
		"current":          current,
		"latest":           cache.Latest,
		"update_available": updateAvailable,
	})
}

// fetchLatestGitHubRelease calls the GitHub releases API and returns the tag_name.
func fetchLatestGitHubRelease() (string, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	req, err := http.NewRequest(http.MethodGet, "https://api.github.com/repos/dariy/point/releases/latest", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "point-version-check")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}

	var payload struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	return payload.TagName, nil
}

func (h *SystemHandler) GetStats(c echo.Context) error {
	ctx := c.Request().Context()

	stats, err := h.repo.GetSystemStats(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"published_posts": stats.PublishedCount,
		"total_posts":     stats.PostCount,
		"total_tags":      stats.TagCount,
		"total_media":     stats.MediaCount,
		"storage_used_mb": float64(stats.StorageBytes) / (1024 * 1024),
		"uptime_seconds":  int64(time.Since(startTime).Seconds()),
	})
}

func (h *SystemHandler) GetLogs(c echo.Context) error {
	lines, _ := strconv.Atoi(c.QueryParam("lines"))
	if lines < 1 || lines > 1000 {
		lines = 100
	}

	f, err := os.Open(h.logPath)
	if err != nil {
		// Log file doesn't exist yet — return empty list
		return c.JSON(http.StatusOK, []string{})
	}
	defer func() {
		_ = f.Close()
	}()

	var all []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		all = append(all, scanner.Text())
	}

	// Return last N lines
	if len(all) > lines {
		all = all[len(all)-lines:]
	}

	return c.JSON(http.StatusOK, all)
}

func (h *SystemHandler) CreateBackup(c echo.Context) error {
	backupDir := filepath.Join(h.dataPath, "backups")
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to create backup directory")
	}

	timestamp := time.Now().Format("20060102_150405")
	backupName := fmt.Sprintf("backup_%s.tar.gz", timestamp)
	backupPath := filepath.Join(backupDir, backupName)

	if err := h.createTarGz(backupPath); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("backup failed: %v", err))
	}

	info, _ := os.Stat(backupPath)
	size := int64(0)
	if info != nil {
		size = info.Size()
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"status":   "success",
		"filename": backupName,
		"size":     size,
	})
}

func (h *SystemHandler) ListBackups(c echo.Context) error {
	backupDir := filepath.Join(h.dataPath, "backups")

	entries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return c.JSON(http.StatusOK, []interface{}{})
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	type backupInfo struct {
		Filename  string    `json:"filename"`
		Size      int64     `json:"size"`
		CreatedAt time.Time `json:"created_at"`
	}

	result := make([]backupInfo, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tar.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		result = append(result, backupInfo{
			Filename:  e.Name(),
			Size:      info.Size(),
			CreatedAt: info.ModTime(),
		})
	}

	return c.JSON(http.StatusOK, result)
}

func (h *SystemHandler) RestoreBackup(c echo.Context) error {
	filename := c.Param("filename")
	if filename == "" || strings.Contains(filename, "/") || strings.Contains(filename, "..") {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid filename")
	}

	backupPath := filepath.Join(h.dataPath, "backups", filename)
	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		return echo.NewHTTPError(http.StatusNotFound, "backup not found")
	}

	if err := h.extractTarGz(backupPath, h.dataPath); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, fmt.Sprintf("restore failed: %v", err))
	}

	return c.JSON(http.StatusOK, map[string]string{
		"status":  "success",
		"message": "Backup restored successfully. Please restart the server.",
	})
}

func (h *SystemHandler) GetMigrations(c echo.Context) error {
	migrations, err := h.repo.GetMigrations(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, migrations)
}

func (h *SystemHandler) ClearCache(c echo.Context) error {
	// The Go API has no application-level cache, but we treat it as an
	// opportunity to synchronize state. We recalculate media visibility
	// to ensure all media referenced in public posts is accessible to guests.
	updated, err := h.mediaService.RecalculateAllMediaVisibility(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"status":        "success",
		"cleared_count": 0,
		"updated_media": updated,
	})
}

func (h *SystemHandler) RecalculateMediaVisibility(c echo.Context) error {
	changed, err := h.mediaService.RecalculateAllMediaVisibility(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"status":  "success",
		"updated": changed,
	})
}

func (h *SystemHandler) UpdateMapCoords(c echo.Context) error {
	result, err := h.tagService.UpdateMissingCoords(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, result)
}

func (h *SystemHandler) DeleteBackup(c echo.Context) error {
	filename := c.Param("filename")
	if filename == "" || strings.Contains(filename, "/") || strings.Contains(filename, "..") {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid filename")
	}

	backupPath := filepath.Join(h.dataPath, "backups", filename)
	if err := os.Remove(backupPath); err != nil {
		if os.IsNotExist(err) {
			return echo.NewHTTPError(http.StatusNotFound, "backup not found")
		}
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]string{"status": "success", "message": "Backup deleted"})
}

var importableExtensions = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".gif":  true,
	".webp": true,
	".mp4":  true,
	".mov":  true,
	".avi":  true,
	".mkv":  true,
	".m4v":  true,
	".heic": true,
	".heif": true,
}

func (h *SystemHandler) ScanMediaImport(c echo.Context) error {
	ctx := c.Request().Context()

	importPath, err := h.settingsService.GetSetting(ctx, "media_import_path", "")
	if err != nil || importPath == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"detail": "media_import_path not configured in settings",
		})
	}

	if _, err := os.Stat(importPath); os.IsNotExist(err) {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"detail": fmt.Sprintf("import path does not exist: %s", importPath),
		})
	}

	var imported, skipped int
	errors := []string{}

	_ = filepath.WalkDir(importPath, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}

		ext := strings.ToLower(filepath.Ext(path))
		if !importableExtensions[ext] {
			return nil
		}

		// Compute checksum without loading full file into memory twice
		f, ferr := os.Open(path)
		if ferr != nil {
			errors = append(errors, fmt.Sprintf("%s: %v", filepath.Base(path), ferr))
			return nil
		}
		h256 := sha256.New()
		if _, copyErr := io.Copy(h256, f); copyErr != nil {
			_ = f.Close()
			errors = append(errors, fmt.Sprintf("%s: %v", filepath.Base(path), copyErr))
			return nil
		}
		_ = f.Close()
		checksum := hex.EncodeToString(h256.Sum(nil))

		// Skip duplicates
		if _, lookupErr := h.repo.GetMediaByChecksum(ctx, checksum); lookupErr == nil {
			skipped++
			return nil
		}

		if _, importErr := h.mediaService.ImportFromPath(ctx, path); importErr != nil {
			errors = append(errors, fmt.Sprintf("%s: %v", filepath.Base(path), importErr))
			return nil
		}
		imported++
		return nil
	})

	return c.JSON(http.StatusOK, map[string]interface{}{
		"imported": imported,
		"skipped":  skipped,
		"errors":   errors,
	})
}

func (h *SystemHandler) createTarGz(destPath string) error {
	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer func() {
		_ = f.Close()
	}()

	gz := gzip.NewWriter(f)
	defer func() {
		_ = gz.Close()
	}()

	tw := tar.NewWriter(gz)
	defer func() {
		_ = tw.Close()
	}()

	// Walk the data directory, excluding the backups dir itself
	return filepath.Walk(h.dataPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable files
		}

		// Skip the backups directory to avoid recursive backup-of-backup
		if info.IsDir() && filepath.Base(path) == "backups" {
			return filepath.SkipDir
		}

		relPath, err := filepath.Rel(h.dataPath, path)
		if err != nil {
			return nil
		}

		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return nil
		}
		header.Name = relPath

		if err := tw.WriteHeader(header); err != nil {
			return err
		}

		if !info.IsDir() {
			src, err := os.Open(path)
			if err != nil {
				return nil
			}
			defer func() {
				_ = src.Close()
			}()
			_, _ = io.Copy(tw, src)
		}

		return nil
	})
}

func (h *SystemHandler) extractTarGz(srcPath, destDir string) error {
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer func() {
		_ = f.Close()
	}()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer func() {
		_ = gz.Close()
	}()

	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		target := filepath.Join(destDir, header.Name)

		// Security: prevent path traversal
		if !strings.HasPrefix(filepath.Clean(target), filepath.Clean(destDir)) {
			continue
		}

		switch header.Typeflag {
		case tar.TypeDir:
			_ = os.MkdirAll(target, 0755)
		case tar.TypeReg:
			_ = os.MkdirAll(filepath.Dir(target), 0755)
			out, err := os.Create(target)
			if err != nil {
				continue
			}
			_, _ = io.Copy(out, tr)
			_ = out.Close()
		}
	}
	return nil
}
