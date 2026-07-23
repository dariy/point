package api

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
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
	repo            repository.Repository
	mediaService    *services.MediaService
	postService     *services.PostService
	settingsService *services.SettingsService
	tagService      *services.TagService
	systemService   *services.SystemService
	cacheService    *services.CacheService
	authService     *services.AuthService
	downloadTokens  *services.DownloadTokenStore
	dataPath        string
	logPath         string
	appVersion      string
}

var startTime = time.Now()

func NewSystemHandler(repo repository.Repository, mediaService *services.MediaService, postService *services.PostService, settingsService *services.SettingsService, tagService *services.TagService, systemService *services.SystemService, cacheService *services.CacheService, authService *services.AuthService, dataPath string, appVersion string) *SystemHandler {
	return &SystemHandler{
		repo:            repo,
		mediaService:    mediaService,
		postService:     postService,
		settingsService: settingsService,
		tagService:      tagService,
		systemService:   systemService,
		cacheService:    cacheService,
		authService:     authService,
		downloadTokens:  services.NewDownloadTokenStore(),
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
	if h.systemService.BackupRunning() {
		return c.JSON(http.StatusConflict, map[string]string{
			"status":  "already_running",
			"message": "a backup is already in progress",
		})
	}

	// Warn synchronously if the archive wouldn't fit, so the user finds out now
	// rather than via a silent background failure.
	if err := h.systemService.CheckBackupSpace(); err != nil {
		return echo.NewHTTPError(http.StatusInsufficientStorage, err.Error())
	}

	// Read retention before detaching from the request context.
	keep := 7
	if v, _ := h.settingsService.GetSetting(c.Request().Context(), "backup_keep", ""); v != "" {
		if n, e := strconv.Atoi(v); e == nil {
			keep = n
		}
	}

	// Run in the background: a multi-GB archive can take minutes — far longer than
	// a request should stay open. Progress is observable via ListBackups (the
	// in-progress .partial entry) and survives page reloads. A detached context is
	// used so the work isn't cancelled when this request returns.
	go func() {
		bgCtx := context.Background()
		if _, _, err := h.systemService.CreateBackup(bgCtx); err != nil {
			slog.Error("backup failed", "err", err)
			return
		}
		if _, err := h.systemService.RotateBackups(keep); err != nil {
			slog.Error("backup rotation failed", "err", err)
		}
	}()

	return c.JSON(http.StatusAccepted, map[string]string{"status": "started"})
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
		Filename   string    `json:"filename"`
		Size       int64     `json:"size"`
		CreatedAt  time.Time `json:"created_at"`
		Sha256     string    `json:"sha256,omitempty"`
		InProgress bool      `json:"in_progress,omitempty"`
	}

	var inProgress []backupInfo
	result := make([]backupInfo, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		info, err := e.Info()
		if err != nil {
			continue
		}
		switch {
		case strings.HasSuffix(name, ".tar.gz"+backupPartialSuffix):
			// A backup currently being written — show it as in-progress (its size
			// grows until the rename publishes the final .tar.gz).
			inProgress = append(inProgress, backupInfo{
				Filename:   strings.TrimSuffix(name, backupPartialSuffix),
				Size:       info.Size(),
				CreatedAt:  info.ModTime(),
				InProgress: true,
			})
		case strings.HasSuffix(name, ".tar.gz"):
			result = append(result, backupInfo{
				Filename:  name,
				Size:      info.Size(),
				CreatedAt: info.ModTime(),
				Sha256:    readChecksumSidecar(filepath.Join(backupDir, name)),
			})
		}
	}
	// Surface any running backup at the top of the list.
	result = append(inProgress, result...)

	return c.JSON(http.StatusOK, result)
}

func (h *SystemHandler) RestoreBackup(c echo.Context) error {
	filename := c.Param("filename")
	// Restoring overwrites the live SQLite file, which can't be done safely while
	// the server holds it open, so we schedule it and apply it at the next startup.
	if err := h.systemService.ScheduleRestore(filename); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]string{
		"status":  "success",
		"message": "Restore scheduled. Restart the server to apply it; you will be logged out.",
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

// AuditPostLinks reports internal /posts/<slug> links on publicly reachable
// posts whose target an anonymous visitor cannot open (missing, unpublished,
// or hidden by a hides-posts tag).
func (h *SystemHandler) AuditPostLinks(c echo.Context) error {
	issues, scanned, err := h.postService.AuditPublicPostLinks(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"issues":  issues,
		"scanned": scanned,
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
	_ = os.Remove(backupPath + ".sha256") // drop the orphaned checksum sidecar

	return c.JSON(http.StatusOK, map[string]string{"status": "success", "message": "Backup deleted"})
}

// backupPartialSuffix marks an archive still being written (see SystemService).
const backupPartialSuffix = ".partial"

// validBackupName rejects empty names and any path-traversal attempt, matching
// the guard used by DeleteBackup/RestoreBackup.
func validBackupName(filename string) bool {
	return filename != "" && !strings.Contains(filename, "/") && !strings.Contains(filename, "..")
}

// readChecksumSidecar returns the recorded SHA-256 hex for a backup by reading
// its `.sha256` sidecar (sha256sum format), or "" when there is none.
func readChecksumSidecar(backupPath string) string {
	data, err := os.ReadFile(backupPath + ".sha256")
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(data))
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// AuthorizeDownloadRequest carries the re-entered password. The field is named
// `current_name` to match the existing credential-change DTOs (see auth.go).
type AuthorizeDownloadRequest struct {
	CurrentPassword string `json:"current_name"`
}

// AuthorizeBackupDownload re-verifies the account password and, on success,
// issues a short-lived single-use token the client exchanges for the actual
// download (which is a plain GET that can't carry a password body).
func (h *SystemHandler) AuthorizeBackupDownload(c echo.Context) error {
	ctx := c.Request().Context()
	userID := extractUserID(c.Get("user"))

	filename := c.Param("filename")
	if !validBackupName(filename) {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid filename")
	}

	var req AuthorizeDownloadRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}
	if err := h.authService.VerifyUserPassword(ctx, userID, req.CurrentPassword); err != nil {
		return echo.NewHTTPError(http.StatusForbidden, "current password incorrect")
	}

	backupPath := filepath.Join(h.dataPath, "backups", filename)
	if _, err := os.Stat(backupPath); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "backup not found")
	}

	token, err := h.downloadTokens.Issue(userID, filename)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "could not authorize download")
	}
	return c.JSON(http.StatusOK, map[string]string{"token": token})
}

// DownloadBackup streams a backup archive as an attachment after validating the
// one-time token from AuthorizeBackupDownload. c.Attachment serves via
// http.ServeContent, so Range/resume works for multi-GB files without buffering.
func (h *SystemHandler) DownloadBackup(c echo.Context) error {
	userID := extractUserID(c.Get("user"))
	filename := c.Param("filename")

	tokUserID, tokFile, ok := h.downloadTokens.Consume(c.QueryParam("token"))
	if !ok || tokUserID != userID || tokFile != filename {
		return echo.NewHTTPError(http.StatusUnauthorized, "invalid or expired download token")
	}
	if !validBackupName(filename) {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid filename")
	}

	backupPath := filepath.Join(h.dataPath, "backups", filename)
	if _, err := os.Stat(backupPath); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "backup not found")
	}
	// Advertise the archive checksum so CLI/API clients can verify the download.
	if sum := readChecksumSidecar(backupPath); sum != "" {
		c.Response().Header().Set("X-Archive-SHA256", sum)
	}
	return c.Attachment(backupPath, filename)
}

// UploadBackupArchive is the "move in" step: it streams an uploaded .tar.gz into
// the backups folder (like a locally created backup) after validating it. It does
// NOT apply the archive — the operator decides whether to Restore it afterward.
// The archive is staged to a .partial and only published under its final name
// once validated, so a half-uploaded file never appears as a usable backup. This
// route is excluded from the global body-size limit so multi-GB archives fit.
func (h *SystemHandler) UploadBackupArchive(c echo.Context) error {
	backupDir := filepath.Join(h.dataPath, "backups")
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "cannot prepare backups directory")
	}

	filename := fmt.Sprintf("imported_%s.tar.gz", time.Now().Format("20060102_150405"))
	finalPath := filepath.Join(backupDir, filename)
	partialPath := finalPath + backupPartialSuffix

	tmp, err := os.Create(partialPath)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "cannot stage upload")
	}
	// Hash the upload in the same pass that stages it to disk (no extra read).
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hasher), c.Request().Body); err != nil {
		_ = tmp.Close()
		_ = os.Remove(partialPath)
		return echo.NewHTTPError(http.StatusInternalServerError, "upload failed")
	}
	_ = tmp.Close()
	sum := hex.EncodeToString(hasher.Sum(nil))

	// Verify before publishing. If the client sent the expected checksum, a
	// mismatch means the bytes were corrupted or it's the wrong file. Otherwise,
	// read the archive end-to-end to catch truncation and confirm it's actually a
	// Point backup, so an unusable file never lands in the list.
	if expected := strings.TrimSpace(c.Request().Header.Get("X-Archive-SHA256")); expected != "" {
		if !strings.EqualFold(expected, sum) {
			_ = os.Remove(partialPath)
			return echo.NewHTTPError(http.StatusBadRequest, "checksum mismatch: the upload is corrupted or not the expected archive")
		}
	} else if err := h.systemService.ValidateArchive(partialPath); err != nil {
		_ = os.Remove(partialPath)
		return echo.NewHTTPError(http.StatusBadRequest, "invalid archive: "+err.Error())
	}

	// Publish: write the checksum sidecar, then rename into place so the archive
	// only ever appears in the list once complete and validated.
	_ = os.WriteFile(finalPath+".sha256", []byte(sum+"  "+filename+"\n"), 0o644)
	if err := os.Rename(partialPath, finalPath); err != nil {
		_ = os.Remove(partialPath)
		_ = os.Remove(finalPath + ".sha256")
		return echo.NewHTTPError(http.StatusInternalServerError, "could not save uploaded archive")
	}

	return c.JSON(http.StatusOK, map[string]string{
		"status":   "success",
		"filename": filename,
		"sha256":   sum,
		"message":  "Archive uploaded to backups. Use Restore to apply it.",
	})
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
