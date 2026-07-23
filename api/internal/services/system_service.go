package services

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"point-api/internal/repository"
)

// partialSuffix marks an archive still being written. A backup is built under
// "<name>.tar.gz.partial" and renamed to "<name>.tar.gz" only once complete, so a
// half-written archive never appears in the backups list (which matches .tar.gz).
const partialSuffix = ".partial"

// ErrBackupInProgress is returned when a backup is requested while one is already
// running; only one may run at a time.
var ErrBackupInProgress = errors.New("a backup is already in progress")

type SystemService struct {
	repo     repository.Repository
	dataPath string
	dbPath   string

	backupMu      sync.Mutex
	backupRunning bool
}

func NewSystemService(repo repository.Repository, dataPath, dbPath string) *SystemService {
	return &SystemService{
		repo:     repo,
		dataPath: dataPath,
		dbPath:   dbPath,
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
	// Only one backup may run at a time (manual or scheduled) so two runs can't
	// race on disk space or leave two partials behind.
	s.backupMu.Lock()
	if s.backupRunning {
		s.backupMu.Unlock()
		return "", 0, ErrBackupInProgress
	}
	s.backupRunning = true
	s.backupMu.Unlock()
	defer func() {
		s.backupMu.Lock()
		s.backupRunning = false
		s.backupMu.Unlock()
	}()

	backupDir := filepath.Join(s.dataPath, "backups")
	if err := os.MkdirAll(backupDir, 0755); err != nil {
		return "", 0, fmt.Errorf("failed to create backup directory: %w", err)
	}

	// Clear any partial left by a previously interrupted backup. With the run
	// guard held, no live partial can exist, so anything here is stale.
	s.removePartials(backupDir)

	// Pre-flight: make sure the archive can actually fit before we start writing.
	if err := s.CheckBackupSpace(); err != nil {
		return "", 0, err
	}

	timestamp := time.Now().Format("20060102_150405")
	backupName := fmt.Sprintf("backup_%s.tar.gz", timestamp)
	finalPath := filepath.Join(backupDir, backupName)
	partialPath := finalPath + partialSuffix

	// Build into the partial file, then atomically publish the final name so the
	// archive is only ever listed/downloaded once it is complete and consistent.
	sum, err := s.createTarGz(ctx, partialPath)
	if err != nil {
		_ = os.Remove(partialPath)
		return "", 0, fmt.Errorf("backup failed: %w", err)
	}

	// Write the checksum sidecar (`sha256sum` format) before the rename so the
	// final archive never appears in the list without its checksum. Best-effort:
	// a missing sidecar just means verification is unavailable for this backup.
	_ = os.WriteFile(finalPath+".sha256", []byte(sum+"  "+backupName+"\n"), 0o644)

	if err := os.Rename(partialPath, finalPath); err != nil {
		_ = os.Remove(partialPath)
		_ = os.Remove(finalPath + ".sha256")
		return "", 0, fmt.Errorf("backup finalize failed: %w", err)
	}

	info, err := os.Stat(finalPath)
	if err != nil {
		return backupName, 0, nil
	}

	return backupName, info.Size(), nil
}

// BackupRunning reports whether a backup is currently being created.
func (s *SystemService) BackupRunning() bool {
	s.backupMu.Lock()
	defer s.backupMu.Unlock()
	return s.backupRunning
}

// removePartials deletes leftover "*.tar.gz.partial" files from an interrupted
// backup. The caller must hold the run guard (or know none is running).
func (s *SystemService) removePartials(backupDir string) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".tar.gz"+partialSuffix) {
			_ = os.Remove(filepath.Join(backupDir, e.Name()))
		}
	}
}

// CleanupPartialBackups removes any interrupted-backup temp files. Safe to call
// at startup: a freshly started process has no backup running.
func (s *SystemService) CleanupPartialBackups() {
	s.removePartials(filepath.Join(s.dataPath, "backups"))
}

// RotateBackups keeps only the `keep` most recent .tar.gz backups, deleting the
// older ones so the backups directory can't grow without bound. keep <= 0
// disables rotation (keep everything). Returns how many files were deleted.
func (s *SystemService) RotateBackups(keep int) (int, error) {
	if keep <= 0 {
		return 0, nil
	}
	backupDir := filepath.Join(s.dataPath, "backups")
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	type backupFile struct {
		name string
		mod  time.Time
	}
	var files []backupFile
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tar.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, backupFile{e.Name(), info.ModTime()})
	}
	if len(files) <= keep {
		return 0, nil
	}
	// Newest first; everything past `keep` is stale.
	sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })
	deleted := 0
	for _, f := range files[keep:] {
		if err := os.Remove(filepath.Join(backupDir, f.name)); err == nil {
			deleted++
			_ = os.Remove(filepath.Join(backupDir, f.name+".sha256")) // drop the orphaned sidecar
		}
	}
	return deleted, nil
}

// lastBackupTime returns the modtime of the most recent .tar.gz backup, or the
// zero time when there are none.
func (s *SystemService) lastBackupTime() time.Time {
	backupDir := filepath.Join(s.dataPath, "backups")
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return time.Time{}
	}
	var newest time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tar.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	return newest
}

// BackupDue reports whether a scheduled backup should run now given the
// configured cadence in days. Daily (intervalDays <= 1) is always due. A 12h
// slack absorbs the fixed daily run time so an "every N days" cadence doesn't
// drift to N+1. ponytail: "monthly" is modelled as 30 days, not calendar months.
func (s *SystemService) BackupDue(intervalDays int) bool {
	if intervalDays <= 1 {
		return true
	}
	last := s.lastBackupTime()
	if last.IsZero() {
		return true
	}
	threshold := time.Duration(intervalDays)*24*time.Hour - 12*time.Hour
	return time.Since(last) >= threshold
}

// dataDirSize sums the bytes of regular files under dataPath, excluding the
// backups dir (existing archives must not count toward a new backup's size).
func (s *SystemService) dataDirSize() int64 {
	var total int64
	_ = filepath.Walk(s.dataPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() && filepath.Base(path) == "backups" {
			return filepath.SkipDir
		}
		if !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

// CheckBackupSpace verifies the filesystem can hold a new backup before one is
// started. A .tar.gz is at most about the size of the data it archives (usually
// less after compression), so the data-directory size is a safe upper estimate.
// Returns a human-readable error when the free space falls short.
func (s *SystemService) CheckBackupSpace() error {
	estimate := s.dataDirSize()
	if estimate <= 0 {
		return nil
	}
	disk, err := s.GetDiskInfo()
	if err != nil {
		return nil // can't determine free space — don't block the backup
	}
	if disk.Free < estimate {
		return fmt.Errorf("not enough disk space for a backup: need about %s (size of the data folder), only %s free",
			humanizeBytes(estimate), humanizeBytes(disk.Free))
	}
	return nil
}

// humanizeBytes renders a byte count as a compact human-readable string.
func humanizeBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for size := n / unit; size >= unit; size /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

// createTarGz writes the data-directory archive to destPath and returns the
// SHA-256 (hex) of the resulting .tar.gz, computed in the same write pass.
func (s *SystemService) createTarGz(ctx context.Context, destPath string) (string, error) {
	f, err := os.Create(destPath)
	if err != nil {
		return "", err
	}
	defer func() {
		_ = f.Close()
	}()

	// Hash the compressed archive bytes as they are written (no extra read pass).
	hasher := sha256.New()
	gz := gzip.NewWriter(io.MultiWriter(f, hasher))
	tw := tar.NewWriter(gz)

	// Take a consistent snapshot of the live SQLite database rather than copying
	// the WAL-mode file byte-for-byte (which can capture a torn DB with pages
	// still sitting in the -wal sidecar). We VACUUM INTO a temp file, tar that in
	// place of the live DB, and skip the live DB and its -wal/-shm sidecars.
	var dbSnapshot string // temp snapshot path ("" when the DB isn't under dataPath)
	var dbTarName string  // tar entry name to store the snapshot under
	skip := map[string]bool{}
	if s.dbPath != "" {
		if absDB, err := filepath.Abs(s.dbPath); err == nil {
			if rel, err := filepath.Rel(s.dataPath, absDB); err == nil && !strings.HasPrefix(rel, "..") {
				tmp, err := os.CreateTemp("", "point-db-snapshot-*.db")
				if err != nil {
					return "", err
				}
				tmpPath := tmp.Name()
				_ = tmp.Close()
				// VACUUM INTO requires the destination file to not exist.
				_ = os.Remove(tmpPath)
				if err := s.repo.BackupDB(ctx, tmpPath); err != nil {
					_ = os.Remove(tmpPath)
					return "", fmt.Errorf("db snapshot: %w", err)
				}
				defer func() { _ = os.Remove(tmpPath) }()
				dbSnapshot = tmpPath
				dbTarName = rel
				skip[absDB] = true
				skip[absDB+"-wal"] = true
				skip[absDB+"-shm"] = true
			}
		}
	}

	// Walk the data directory, excluding the backups dir itself.
	if err := filepath.Walk(s.dataPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable files
		}

		// Skip the backups directory to avoid recursive backup-of-backup
		if info.IsDir() && filepath.Base(path) == "backups" {
			return filepath.SkipDir
		}

		// Skip the live DB and its sidecars; the snapshot is added below.
		if absPath, err := filepath.Abs(path); err == nil && skip[absPath] {
			return nil
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
	}); err != nil {
		return "", err
	}

	// Add the consistent DB snapshot under the live DB's relative name.
	if dbSnapshot != "" {
		if err := addFileToTar(tw, dbSnapshot, dbTarName); err != nil {
			return "", err
		}
	}

	// Finalize the streams before reading the digest so every compressed byte has
	// been flushed through the hasher.
	if err := tw.Close(); err != nil {
		return "", err
	}
	if err := gz.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// addFileToTar writes a single on-disk file into tw under the given tar name.
func addFileToTar(tw *tar.Writer, srcPath, tarName string) error {
	info, err := os.Stat(srcPath)
	if err != nil {
		return err
	}
	header, err := tar.FileInfoHeader(info, "")
	if err != nil {
		return err
	}
	header.Name = tarName
	if err := tw.WriteHeader(header); err != nil {
		return err
	}
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	_, err = io.Copy(tw, src)
	return err
}

// pendingRestoreMarker is the file (inside the backups dir, so it's never itself
// archived) that records a backup to restore on the next startup.
const pendingRestoreMarker = "pending_restore"

func isSafeBackupName(filename string) bool {
	return filename != "" && !strings.Contains(filename, "/") && !strings.Contains(filename, "..")
}

// ScheduleRestore validates a backup and records it to be applied at the next
// startup, BEFORE the database is opened. A restore can't be done safely while
// the server holds the SQLite file open — overwriting point.db under a live
// connection (and a stale WAL the connection may still checkpoint) corrupts the
// database ("disk image is malformed") — so the extraction is deferred to boot.
func (s *SystemService) ScheduleRestore(filename string) error {
	if !isSafeBackupName(filename) {
		return fmt.Errorf("invalid filename")
	}
	backupPath := filepath.Join(s.dataPath, "backups", filename)
	if _, err := os.Stat(backupPath); os.IsNotExist(err) {
		return fmt.Errorf("backup not found")
	}
	// Refuse to schedule a restore we already know would fail at boot.
	if err := s.ValidateArchive(backupPath); err != nil {
		return fmt.Errorf("cannot restore this archive: %w", err)
	}
	marker := filepath.Join(s.dataPath, "backups", pendingRestoreMarker)
	return os.WriteFile(marker, []byte(filename), 0o644)
}

// ApplyPendingRestore extracts a restore scheduled by ScheduleRestore. It MUST be
// called at startup before the database is opened. It reports whether a restore
// was applied. The marker is consumed unconditionally, so a failing restore can
// never loop the boot.
func (s *SystemService) ApplyPendingRestore() (bool, error) {
	marker := filepath.Join(s.dataPath, "backups", pendingRestoreMarker)
	data, err := os.ReadFile(marker)
	if err != nil {
		return false, nil // nothing scheduled
	}
	_ = os.Remove(marker)

	filename := strings.TrimSpace(string(data))
	if !isSafeBackupName(filename) {
		return true, fmt.Errorf("pending restore has invalid filename %q", filename)
	}
	backupPath := filepath.Join(s.dataPath, "backups", filename)
	if err := s.extractTarGz(backupPath, s.dataPath); err != nil {
		return true, fmt.Errorf("apply pending restore %q: %w", filename, err)
	}

	// The archive holds a self-contained VACUUM INTO snapshot as point.db and no
	// -wal/-shm. Any -wal/-shm still on disk belong to the pre-restore database;
	// left in place, SQLite would replay that stale WAL against the restored
	// snapshot and report "database disk image is malformed". Drop them so the DB
	// opens clean.
	s.removeDBSidecars()
	return true, nil
}

// removeDBSidecars deletes the SQLite WAL/SHM sidecars next to the database file.
func (s *SystemService) removeDBSidecars() {
	if s.dbPath == "" {
		return
	}
	_ = os.Remove(s.dbPath + "-wal")
	_ = os.Remove(s.dbPath + "-shm")
}

// ValidateArchive reads a .tar.gz end-to-end without writing anything, so a
// corrupt, truncated, or non-backup upload is rejected before it can overwrite
// live data. Reading each entry to EOF exercises gzip's CRC (catching
// truncation) and the tar structure; it also confirms the archive actually
// carries the database, so a stray tarball can't be restored by mistake.
func (s *SystemService) ValidateArchive(archivePath string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("not a gzip archive: %w", err)
	}
	defer func() { _ = gz.Close() }()

	wantDB := "point.db"
	if s.dbPath != "" {
		wantDB = filepath.Base(s.dbPath)
	}

	tr := tar.NewReader(gz)
	foundDB := false
	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("corrupt or truncated archive: %w", err)
		}
		if _, err := io.Copy(io.Discard, tr); err != nil {
			return fmt.Errorf("corrupt archive entry %q: %w", header.Name, err)
		}
		if filepath.Base(header.Name) == wantDB {
			foundDB = true
		}
	}
	if !foundDB {
		return fmt.Errorf("archive does not contain the database (%s); not a Point backup", wantDB)
	}
	return nil
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

		// Security: reject path traversal. Uploaded ("move in") archives are
		// attacker-controlled, so an entry must resolve to destDir itself or a
		// path strictly beneath it. The trailing separator is essential — without
		// it, a sibling like "<dest>EVIL" would pass a bare prefix check, and
		// filepath.Join collapses "../" so "../destEVIL/x" would escape.
		cleanDest := filepath.Clean(destDir)
		target := filepath.Join(cleanDest, header.Name)
		if filepath.IsAbs(header.Name) ||
			(target != cleanDest && !strings.HasPrefix(target, cleanDest+string(os.PathSeparator))) {
			return fmt.Errorf("restore: unsafe path in archive: %q", header.Name)
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
