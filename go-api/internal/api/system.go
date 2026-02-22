package api

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
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
	settingsService *services.SettingsService
	tagService      *services.TagService
	dataPath        string
	logPath         string
}

var startTime = time.Now()

func NewSystemHandler(repo *repository.Repository, mediaService *services.MediaService, settingsService *services.SettingsService, tagService *services.TagService, dataPath string) *SystemHandler {
	return &SystemHandler{
		repo:            repo,
		mediaService:    mediaService,
		settingsService: settingsService,
		tagService:      tagService,
		dataPath:        dataPath,
		logPath:         filepath.Join(dataPath, "logs", "app.log"),
	}
}

func (h *SystemHandler) GetStats(c echo.Context) error {
	ctx := c.Request().Context()

	stats, err := h.repo.GetSystemStats(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)

	return c.JSON(http.StatusOK, map[string]interface{}{
		"posts": map[string]interface{}{
			"total":     stats.PostCount,
			"published": stats.PublishedCount,
			"draft":     stats.DraftCount,
		},
		"tags":          stats.TagCount,
		"media":         stats.MediaCount,
		"storage_bytes": stats.StorageBytes,
		"users":         stats.UserCount,
		"sessions":      stats.SessionCount,
		"uptime_seconds": int64(time.Since(startTime).Seconds()),
		"memory": map[string]interface{}{
			"alloc_mb":       memStats.Alloc / 1024 / 1024,
			"total_alloc_mb": memStats.TotalAlloc / 1024 / 1024,
			"sys_mb":         memStats.Sys / 1024 / 1024,
		},
		"go_version":    runtime.Version(),
		"num_goroutine": runtime.NumGoroutine(),
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
	defer f.Close()

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
		"path":     backupPath,
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
	// The Go API has no application-level cache. Return success for API parity.
	return c.JSON(http.StatusOK, map[string]interface{}{
		"status":        "success",
		"cleared_count": 0,
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

func (h *SystemHandler) createTarGz(destPath string) error {
	f, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz := gzip.NewWriter(f)
	defer gz.Close()

	tw := tar.NewWriter(gz)
	defer tw.Close()

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
			defer src.Close()
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
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

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
			os.MkdirAll(target, 0755)
		case tar.TypeReg:
			os.MkdirAll(filepath.Dir(target), 0755)
			out, err := os.Create(target)
			if err != nil {
				continue
			}
			_, _ = io.Copy(out, tr)
			out.Close()
		}
	}
	return nil
}
