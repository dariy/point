package services

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"point-api/internal/repository"
)

// A restore check unpacks a backup into a temporary directory, opens its
// database read-only, and compares the result with the manifest that
// createTarGz wrote into the archive. It never touches the live database or
// the media tree: the temporary directory is under <data>/backups, which the
// backup itself skips.

// backupManifestName is the archive entry that holds the manifest. A restore
// into the data directory does not write it (see extractArchive).
const backupManifestName = ".point-backup-manifest.json"

// backupManifestVersion is the manifest format this build writes and reads.
// A check refuses a manifest with a higher version.
const backupManifestVersion = 1

// restoreCheckFile, in the backups directory, stores the last check result.
const restoreCheckFile = "restore_check.json"

// restoreCheckDirPrefix names the temporary directories a check unpacks into.
const restoreCheckDirPrefix = ".restore-check-"

// maxRestoreCheckMismatches limits the mismatches a result lists. The count
// is always complete.
const maxRestoreCheckMismatches = 20

// RestoreCheckIntervalDays is how often the scheduler checks a new backup.
const RestoreCheckIntervalDays = 7

// healthTaskRestoreCheck is the HealthRegistry key for the restore check.
const healthTaskRestoreCheck = "backup restore check"

// ErrRestoreCheckInProgress is returned when a check is requested while one
// is already running.
var ErrRestoreCheckInProgress = kindSentinel(ErrConflict, "a restore check is already in progress")

// backupManifest is the JSON the archive carries under backupManifestName.
type backupManifest struct {
	Version int `json:"version"`
	// Files maps each archived regular file (slash-separated path relative to
	// the data directory) to the SHA-256 (hex) of its bytes.
	Files map[string]string `json:"files"`
	// Tables maps each table of the database snapshot to its row count.
	Tables map[string]int64 `json:"tables"`
}

func newBackupManifest() *backupManifest {
	return &backupManifest{Version: backupManifestVersion, Files: map[string]string{}, Tables: map[string]int64{}}
}

// writeManifestToTar writes m as the last entry of the archive.
func writeManifestToTar(tw *tar.Writer, m *backupManifest) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{
		Name:     backupManifestName,
		Typeflag: tar.TypeReg,
		Mode:     0o644,
		Size:     int64(len(data)),
		ModTime:  time.Now(),
	}); err != nil {
		return err
	}
	_, err = tw.Write(data)
	return err
}

// RestoreCheckResult is the outcome of one restore check.
type RestoreCheckResult struct {
	Backup    string    `json:"backup"`
	CheckedAt time.Time `json:"checked_at"`
	Passed    bool      `json:"passed"`
	// Manifest is false for a backup made before the restore check existed.
	// The check then only unpacks the archive and opens the database.
	Manifest bool `json:"manifest"`
	// Files is the number of files restored; FilesExpected is the number the
	// manifest lists.
	Files         int `json:"files"`
	FilesExpected int `json:"files_expected"`
	// Tables holds the row counts of the restored database.
	Tables map[string]int64 `json:"tables,omitempty"`
	// Mismatches lists the first differences; MismatchCount counts all.
	Mismatches    []string `json:"mismatches,omitempty"`
	MismatchCount int      `json:"mismatch_count"`
	// Error is set when the check could not finish (the archive does not
	// unpack, or the database does not open).
	Error      string `json:"error,omitempty"`
	DurationMS int64  `json:"duration_ms"`
}

func (r *RestoreCheckResult) mismatch(format string, args ...any) {
	r.MismatchCount++
	if len(r.Mismatches) < maxRestoreCheckMismatches {
		r.Mismatches = append(r.Mismatches, fmt.Sprintf(format, args...))
	}
}

// RestoreCheckRunning reports whether a restore check is running now.
func (s *SystemService) RestoreCheckRunning() bool {
	s.checkMu.Lock()
	defer s.checkMu.Unlock()
	return s.checkRunning
}

// ResolveBackupName returns the name of a finished backup: filename itself
// when it names one, or the newest backup when filename is empty.
func (s *SystemService) ResolveBackupName(filename string) (string, error) {
	if filename == "" {
		filename, _ = s.newestBackup()
		if filename == "" {
			return "", wrapKind(ErrNotFound, errors.New("no backup to check"))
		}
	}
	if !isSafeBackupName(filename) || !strings.HasSuffix(filename, ".tar.gz") {
		return "", wrapKind(ErrInvalidInput, errors.New("invalid filename"))
	}
	if _, err := os.Stat(filepath.Join(s.dataPath, "backups", filename)); err != nil {
		return "", wrapKind(ErrNotFound, errors.New("backup not found"))
	}
	return filename, nil
}

// VerifyBackup runs a restore check on the named backup, or on the newest
// backup when filename is empty. It stores the result for LastRestoreCheck
// and records it in the health registry. A failed check is a result with
// Passed=false, not an error; the error is for a bad name, a missing backup,
// or a check that is already running.
func (s *SystemService) VerifyBackup(ctx context.Context, filename string) (RestoreCheckResult, error) {
	filename, err := s.ResolveBackupName(filename)
	if err != nil {
		return RestoreCheckResult{}, err
	}
	backupDir := filepath.Join(s.dataPath, "backups")
	archivePath := filepath.Join(backupDir, filename)

	s.checkMu.Lock()
	if s.checkRunning {
		s.checkMu.Unlock()
		return RestoreCheckResult{}, ErrRestoreCheckInProgress
	}
	s.checkRunning = true
	s.checkMu.Unlock()
	defer func() {
		s.checkMu.Lock()
		s.checkRunning = false
		s.checkMu.Unlock()
	}()

	start := time.Now()
	res := s.runRestoreCheck(ctx, backupDir, archivePath)
	res.Backup = filename
	res.CheckedAt = start.UTC().Round(time.Second)
	res.DurationMS = time.Since(start).Milliseconds()
	res.Passed = res.Error == "" && res.MismatchCount == 0

	if err := s.saveRestoreCheck(backupDir, res); err != nil {
		slog.Error("restore check: cannot store the result", "err", err)
	}
	if res.Passed {
		s.health.Record(healthTaskRestoreCheck, nil)
		slog.Info("restore check passed", "backup", filename, "files", res.Files, "ms", res.DurationMS)
	} else {
		msg := res.Error
		if msg == "" {
			msg = fmt.Sprintf("%d mismatch(es), first: %s", res.MismatchCount, res.Mismatches[0])
		}
		s.health.Record(healthTaskRestoreCheck, fmt.Errorf("%s: %s", filename, msg))
		slog.Warn("restore check failed", "backup", filename, "reason", msg)
	}
	return res, nil
}

// runRestoreCheck does the work of VerifyBackup. It fills everything except
// the identity, time, and verdict fields.
func (s *SystemService) runRestoreCheck(ctx context.Context, backupDir, archivePath string) RestoreCheckResult {
	var res RestoreCheckResult
	removeStaleCheckDirs(backupDir)

	tmp, err := os.MkdirTemp(backupDir, restoreCheckDirPrefix+"*")
	if err != nil {
		res.Error = fmt.Sprintf("cannot create a temporary directory: %v", err)
		return res
	}
	defer func() { _ = os.RemoveAll(tmp) }()

	if err := s.extractArchive(archivePath, tmp, true); err != nil {
		res.Error = fmt.Sprintf("the archive does not unpack: %v", err)
		return res
	}

	manifest, err := readManifest(filepath.Join(tmp, backupManifestName))
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.Manifest = manifest != nil

	got, err := hashTree(ctx, tmp)
	if err != nil {
		res.Error = fmt.Sprintf("cannot read the restored files: %v", err)
		return res
	}
	res.Files = len(got)
	if manifest != nil {
		res.FilesExpected = len(manifest.Files)
		compareFiles(&res, manifest.Files, got)
	}

	dbName := "point.db"
	if s.dbPath != "" {
		dbName = filepath.Base(s.dbPath)
	}
	dbPath := filepath.Join(tmp, dbName)
	if _, err := os.Stat(dbPath); err != nil {
		res.Error = fmt.Sprintf("the archive does not contain the database (%s)", dbName)
		return res
	}
	check, err := repository.SnapshotQuickCheck(ctx, dbPath)
	if err != nil {
		res.Error = fmt.Sprintf("the restored database does not open: %v", err)
		return res
	}
	if check != "ok" {
		res.Error = fmt.Sprintf("the restored database is damaged: %s", check)
		return res
	}
	tables, err := repository.SnapshotTableCounts(ctx, dbPath)
	if err != nil {
		res.Error = fmt.Sprintf("cannot count the restored rows: %v", err)
		return res
	}
	res.Tables = tables
	if manifest != nil {
		compareTables(&res, manifest.Tables, tables)
	}
	return res
}

// readManifest returns nil, nil when the archive has no manifest.
func readManifest(path string) (*backupManifest, error) {
	data, err := os.ReadFile(path) //nolint:gosec // G304: fixed name inside the check's own temporary directory
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cannot read the manifest: %w", err)
	}
	var m backupManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("the manifest is not valid JSON: %w", err)
	}
	if m.Version < 1 || m.Version > backupManifestVersion {
		return nil, fmt.Errorf("unknown manifest version %d", m.Version)
	}
	return &m, nil
}

// hashTree returns the SHA-256 of each regular file under root, keyed by its
// slash-separated relative path. The manifest itself is left out.
func hashTree(ctx context.Context, root string) (map[string]string, error) {
	out := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !d.Type().IsRegular() {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == backupManifestName {
			return nil
		}
		sum, err := fileSHA256(path)
		if err != nil {
			return err
		}
		out[rel] = sum
		return nil
	})
	return out, err
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path) //nolint:gosec // G304: path from a walk of the check's own temporary directory
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func compareFiles(res *RestoreCheckResult, want, got map[string]string) {
	for _, name := range sortedKeys(want) {
		sum, ok := got[name]
		switch {
		case !ok:
			res.mismatch("missing file: %s", name)
		case sum != want[name]:
			res.mismatch("changed file: %s", name)
		}
	}
	for _, name := range sortedKeys(got) {
		if _, ok := want[name]; !ok {
			res.mismatch("file not in the manifest: %s", name)
		}
	}
}

func compareTables(res *RestoreCheckResult, want, got map[string]int64) {
	for _, name := range sortedKeys(want) {
		n, ok := got[name]
		switch {
		case !ok:
			res.mismatch("missing table: %s", name)
		case n != want[name]:
			res.mismatch("table %s: %d rows, manifest says %d", name, n, want[name])
		}
	}
	for _, name := range sortedKeys(got) {
		if _, ok := want[name]; !ok {
			res.mismatch("table not in the manifest: %s", name)
		}
	}
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// removeStaleCheckDirs removes temporary directories that a crashed check
// left behind. Only one check runs at a time, so none of them is in use.
func removeStaleCheckDirs(backupDir string) {
	entries, err := os.ReadDir(backupDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && strings.HasPrefix(e.Name(), restoreCheckDirPrefix) {
			_ = os.RemoveAll(filepath.Join(backupDir, e.Name()))
		}
	}
}

// saveRestoreCheck writes the result through a temporary file and a rename,
// so a reader never sees half a file.
func (s *SystemService) saveRestoreCheck(backupDir string, res RestoreCheckResult) error {
	data, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		return err
	}
	dst := filepath.Join(backupDir, restoreCheckFile)
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil { //nolint:gosec // G306: same mode as the backups beside it
		return err
	}
	return os.Rename(tmp, dst)
}

// LastRestoreCheck returns the stored result of the last restore check, or
// nil when no check has run.
func (s *SystemService) LastRestoreCheck() *RestoreCheckResult {
	data, err := os.ReadFile(filepath.Join(s.dataPath, "backups", restoreCheckFile))
	if err != nil {
		return nil
	}
	var res RestoreCheckResult
	if err := json.Unmarshal(data, &res); err != nil {
		return nil
	}
	return &res
}

// RestoreCheckDue reports whether the last restore check is older than
// intervalDays (with 12 hours of slack for a daily tick), or missing.
func (s *SystemService) RestoreCheckDue(intervalDays int) bool {
	last := s.LastRestoreCheck()
	if last == nil {
		return true
	}
	return time.Since(last.CheckedAt) >= time.Duration(intervalDays)*24*time.Hour-12*time.Hour
}
