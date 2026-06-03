package services

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"point-api/internal/repository"
)

type SystemService struct {
	repo     repository.Repository
	dataPath string
}

func NewSystemService(repo repository.Repository, dataPath string) *SystemService {
	return &SystemService{
		repo:     repo,
		dataPath: dataPath,
	}
}

type DiskInfo struct {
	Total int64 `json:"total"`
	Free  int64 `json:"free"`
	Used  int64 `json:"used"`
}

func (s *SystemService) GetDiskInfo() (DiskInfo, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(s.dataPath, &stat); err != nil {
		return DiskInfo{}, fmt.Errorf("statfs: %w", err)
	}
	total := int64(stat.Blocks) * stat.Bsize
	free := int64(stat.Bavail) * stat.Bsize
	return DiskInfo{
		Total: total,
		Free:  free,
		Used:  total - free,
	}, nil
}

func (s *SystemService) CreateBackup(ctx context.Context) (string, int64, error) {
	backupDir := filepath.Join(s.dataPath, "backups")
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return "", 0, fmt.Errorf("failed to create backup directory: %w", err)
	}

	// Pre-flight: check disk space against the largest existing backup.
	if prevSize := s.largestBackupSize(backupDir); prevSize > 0 {
		disk, err := s.GetDiskInfo()
		if err == nil && disk.Free < int64(float64(prevSize)*1.5) {
			return "", 0, fmt.Errorf("insufficient disk space: need %d bytes (1.5× last backup), have %d free", int64(float64(prevSize)*1.5), disk.Free)
		}
	}

	timestamp := time.Now().Format("20060102_150405")
	backupName := fmt.Sprintf("backup_%s.tar.gz", timestamp)
	backupPath := filepath.Join(backupDir, backupName)

	if err := s.createTarGz(backupPath); err != nil {
		return "", 0, fmt.Errorf("backup failed: %w", err)
	}

	info, err := os.Stat(backupPath)
	if err != nil {
		return backupName, 0, nil
	}

	return backupName, info.Size(), nil
}

// largestBackupSize returns the size in bytes of the largest .tar.gz in backupDir, or 0 if there are none.
func (s *SystemService) largestBackupSize(backupDir string) int64 {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return 0
	}
	var largest int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tar.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.Size() > largest {
			largest = info.Size()
		}
	}
	return largest
}

func (s *SystemService) createTarGz(destPath string) error {
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
	return filepath.Walk(s.dataPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable files
		}

		// Skip the backups directory to avoid recursive backup-of-backup
		if info.IsDir() && filepath.Base(path) == "backups" {
			return filepath.SkipDir
		}

		relPath, err := filepath.Rel(s.dataPath, path)
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

func (s *SystemService) RestoreBackup(ctx context.Context, filename string) error {
	if filename == "" || strings.Contains(filename, "/") || strings.Contains(filename, "..") {
		return fmt.Errorf("invalid filename")
	}

	backupPath := filepath.Join(s.dataPath, "backups", filename)
	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		return fmt.Errorf("backup not found")
	}

	return s.extractTarGz(backupPath, s.dataPath)
}

func (s *SystemService) extractTarGz(srcPath, destDir string) error {
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
			if mkErr := os.MkdirAll(target, 0755); mkErr != nil {
				_ = os.Chmod(target, 0755)
			}
		case tar.TypeReg:
			parentDir := filepath.Dir(target)
			if mkErr := os.MkdirAll(parentDir, 0755); mkErr != nil {
				_ = os.Chmod(parentDir, 0755)
			}
			out, err := os.Create(target)
			if err != nil {
				return fmt.Errorf("restore: cannot write %s: %w", header.Name, err)
			}
			if _, copyErr := io.Copy(out, tr); copyErr != nil {
				_ = out.Close()
				return fmt.Errorf("restore: cannot write %s: %w", header.Name, copyErr)
			}
			_ = out.Close()
		}
	}
	return nil
}
