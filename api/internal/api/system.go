package api

import (
	"bufio"
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

	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type SystemHandler struct {
	repo            *repository.Repository
	mediaService    *services.MediaService
	postService     *services.PostService
	settingsService *services.SettingsService
	tagService      *services.TagService
	systemService   *services.SystemService
	cacheService    *services.CacheService
	dataPath        string
	logPath         string
	appVersion      string
}

var startTime = time.Now()

func NewSystemHandler(repo *repository.Repository, mediaService *services.MediaService, postService *services.PostService, settingsService *services.SettingsService, tagService *services.TagService, systemService *services.SystemService, cacheService *services.CacheService, dataPath string, appVersion string) *SystemHandler {
	return &SystemHandler{
		repo:            repo,
		mediaService:    mediaService,
		postService:     postService,
		settingsService: settingsService,
		tagService:      tagService,
		systemService:   systemService,
		cacheService:    cacheService,
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

	updateAvailable := cache.Latest != "" && semverGreaterThan(cache.Latest, current)

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

// semverGreaterThan returns true if version a is strictly greater than b.
// Both strings may have an optional leading "v". Non-semver strings are treated as equal.
func semverGreaterThan(a, b string) bool {
	parse := func(v string) (int, int, int, bool) {
		v = strings.TrimPrefix(v, "v")
		parts := strings.SplitN(v, ".", 3)
		if len(parts) != 3 {
			return 0, 0, 0, false
		}
		major, e1 := strconv.Atoi(parts[0])
		minor, e2 := strconv.Atoi(parts[1])
		patch, e3 := strconv.Atoi(strings.SplitN(parts[2], "-", 2)[0])
		if e1 != nil || e2 != nil || e3 != nil {
			return 0, 0, 0, false
		}
		return major, minor, patch, true
	}
	aMaj, aMin, aPat, aOK := parse(a)
	bMaj, bMin, bPat, bOK := parse(b)
	if !aOK || !bOK {
		return false
	}
	if aMaj != bMaj {
		return aMaj > bMaj
	}
	if aMin != bMin {
		return aMin > bMin
	}
	return aPat > bPat
}

func (h *SystemHandler) GetStats(c echo.Context) error {
	ctx := c.Request().Context()

	stats, err := h.repo.GetSystemStats(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"published_posts":   stats.PublishedCount,
		"total_posts":       stats.PostCount,
		"total_tags":        stats.TagCount,
		"total_media":       stats.MediaCount,
		"storage_used_mb":   float64(stats.StorageBytes) / (1024 * 1024),
		"uptime_seconds":    int64(time.Since(startTime).Seconds()),
		"import_configured": h.settingsService.SecretIsSet(ctx, "photo_library_path"),
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
	if err := scanner.Err(); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to read logs")
	}

	// Return last N lines
	if len(all) > lines {
		all = all[len(all)-lines:]
	}

	return c.JSON(http.StatusOK, all)
}

func (h *SystemHandler) CreateBackup(c echo.Context) error {
	backupName, size, err := h.systemService.CreateBackup(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
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
	if err := h.systemService.RestoreBackup(c.Request().Context(), filename); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
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
	_ = h.cacheService.Clear(c.Request().Context())
	// The Go API now has a file-based cache for feeds and some pages.
	// We also treat this as an opportunity to synchronize state. We recalculate media visibility
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

	importPath, _ := h.settingsService.GetSecret(ctx, "photo_library_path")
	if importPath == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{
			"detail": "photo_library_path not configured",
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

func (h *SystemHandler) GetDiskInfo(c echo.Context) error {
	info, err := h.systemService.GetDiskInfo()
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, info)
}

type photoLibraryFileEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func (h *SystemHandler) getLibraryRoot(c echo.Context) (string, error) {
	libraryRoot, _ := h.settingsService.GetSecret(c.Request().Context(), "photo_library_path")
	if libraryRoot == "" {
		return "", echo.NewHTTPError(http.StatusBadRequest, "photo_library_path not configured")
	}
	// Ensure root is cleaned (no trailing slash issues)
	libraryRoot = filepath.Clean(libraryRoot)
	return libraryRoot, nil
}

func safeJoin(libraryRoot, relPath string) (string, error) {
	// Clean the relative path and join; reject traversal outside root
	abs := filepath.Join(libraryRoot, filepath.Clean("/"+relPath))
	if abs != libraryRoot && !strings.HasPrefix(abs, libraryRoot+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid path")
	}
	return abs, nil
}

func (h *SystemHandler) GetPhotoLibraryContents(c echo.Context) error {
	libraryRoot, err := h.getLibraryRoot(c)
	if err != nil {
		return err
	}

	relPath := c.QueryParam("path")
	targetPath, err := safeJoin(libraryRoot, relPath)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	if _, statErr := os.Stat(targetPath); os.IsNotExist(statErr) {
		return echo.NewHTTPError(http.StatusNotFound, "path not found")
	}

	entries, err := os.ReadDir(targetPath)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	folders := []string{}
	files := []photoLibraryFileEntry{}

	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		entryRelPath := filepath.Join(relPath, entry.Name())
		if entry.IsDir() {
			folders = append(folders, entry.Name())
		} else {
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if importableExtensions[ext] {
				files = append(files, photoLibraryFileEntry{
					Name: entry.Name(),
					Path: entryRelPath,
				})
			}
		}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"path":    relPath,
		"folders": folders,
		"files":   files,
	})
}

func (h *SystemHandler) ImportSelectedPhotos(c echo.Context) error {
	ctx := c.Request().Context()

	libraryRoot, err := h.getLibraryRoot(c)
	if err != nil {
		return err
	}

	var req struct {
		Paths []string `json:"paths"`
	}
	if bindErr := c.Bind(&req); bindErr != nil {
		return echo.NewHTTPError(http.StatusBadRequest, bindErr.Error())
	}

	var imported, skipped int
	errors := []string{}
	importedItems := []map[string]interface{}{}

	for _, relPath := range req.Paths {
		absPath, joinErr := safeJoin(libraryRoot, relPath)
		if joinErr != nil {
			errors = append(errors, fmt.Sprintf("%s: invalid path", relPath))
			continue
		}

		f, openErr := os.Open(absPath)
		if openErr != nil {
			errors = append(errors, fmt.Sprintf("%s: %v", filepath.Base(relPath), openErr))
			continue
		}
		h256 := sha256.New()
		_, _ = io.Copy(h256, f)
		_ = f.Close()
		checksum := hex.EncodeToString(h256.Sum(nil))

		if _, lookupErr := h.repo.GetMediaByChecksum(ctx, checksum); lookupErr == nil {
			skipped++
			continue
		}

		m, importErr := h.mediaService.ImportFromPath(ctx, absPath)
		if importErr != nil {
			errors = append(errors, fmt.Sprintf("%s: %v", filepath.Base(relPath), importErr))
			continue
		}
		importedItems = append(importedItems, mediaToResponse(m))
		imported++
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"imported": imported,
		"skipped":  skipped,
		"errors":   errors,
		"items":    importedItems,
	})
}

func (h *SystemHandler) GetPhotoLibraryFile(c echo.Context) error {
	libraryRoot, err := h.getLibraryRoot(c)
	if err != nil {
		return err
	}

	relPath := c.QueryParam("path")
	if relPath == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "path required")
	}

	ext := strings.ToLower(filepath.Ext(relPath))
	if !importableExtensions[ext] {
		return echo.NewHTTPError(http.StatusBadRequest, "unsupported file type")
	}

	absPath, joinErr := safeJoin(libraryRoot, relPath)
	if joinErr != nil {
		return echo.NewHTTPError(http.StatusBadRequest, joinErr.Error())
	}

	return c.File(absPath)
}
