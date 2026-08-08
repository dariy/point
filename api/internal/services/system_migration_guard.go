package services

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Pre-migration snapshots: the safety net under the schema migrations that run
// at boot (see internal/migrations and cmd/api/migrations_guard.go).
//
// Migrations are fail-forward and run outside any transaction — several of them
// rebuild a table by copying it and dropping the original — so a failure part
// way through leaves a database that is neither the old schema nor the new one.
// SQLite gives us no rollback for that, but it does give us a cheap consistent
// copy: VACUUM INTO. So the boot takes one before it migrates and puts it back
// if the migration phase fails.
//
// Everything here lives under <dataPath>/backups/migrations/, which is
// deliberately invisible to the user-facing backup machinery: CreateBackup and
// the disk-space estimate skip any directory named "backups", and the backups
// list, rotation and due-check all skip directories and match only *.tar.gz.
// These snapshots are not backups the operator manages — they are boot-time
// scaffolding with their own retention.
const (
	migrationSnapshotDirName = "migrations"
	migrationSnapshotPrefix  = "premigration_"
	migrationFailedPrefix    = "failed_"

	// migrationRestoreMarker records a restore that has started but not
	// finished, so a crash mid-swap is completed on the next boot instead of
	// leaving the operator with a half-restored database and no clue.
	migrationRestoreMarker = "restore_pending"

	// restoringSuffix names the staging copy written next to the database. The
	// live file is only ever replaced by renaming this over it.
	restoringSuffix = ".restoring"
)

// migrationSnapshotDir is where pre-migration snapshots and the artifacts of a
// failed migration live.
func (s *SystemService) migrationSnapshotDir() string {
	return filepath.Join(s.dataPath, "backups", migrationSnapshotDirName)
}

// SnapshotForMigrations writes a consistent copy of the database to
// <dataPath>/backups/migrations/premigration_<ts>.db and returns its path. It
// returns ("", nil) when there is no database file yet — a fresh install has
// nothing to protect.
//
// keep is how many snapshots to retain, including this one.
//
// This is boot-only: it is called before the scheduler and the HTTP server
// start, so nothing else can be touching the database. That is also why it does
// not take backupMu — a pre-migration snapshot is not a user backup, and
// holding that lock would make a later CreateBackup report a backup "already in
// progress", which would be a lie.
func (s *SystemService) SnapshotForMigrations(ctx context.Context, keep int) (string, error) {
	if s.dbPath == "" {
		return "", nil
	}
	if _, err := os.Stat(s.dbPath); err != nil {
		if os.IsNotExist(err) {
			return "", nil // fresh install: no database to snapshot
		}
		return "", fmt.Errorf("stat database: %w", err)
	}

	dir := s.migrationSnapshotDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create snapshot directory: %w", err)
	}

	// Prune before writing, not after: on a nearly full disk the space freed by
	// dropping the oldest snapshot is exactly what the new one needs.
	if keep > 0 {
		if _, err := s.pruneMigrationSnapshots(keep - 1); err != nil {
			slog.Warn("could not prune old pre-migration snapshots", "error", err)
		}
	}

	if err := s.checkSnapshotSpace(); err != nil {
		return "", err
	}

	dest := uniquePath(dir, migrationSnapshotPrefix, ".db")
	if err := s.repo.BackupDB(ctx, dest); err != nil {
		_ = os.Remove(dest)
		return "", fmt.Errorf("snapshot database: %w", err)
	}

	// A zero-length snapshot is not a safety net, it is a trap: fail loudly now
	// rather than "restore" an empty database later.
	info, err := os.Stat(dest)
	if err != nil {
		return "", fmt.Errorf("stat snapshot: %w", err)
	}
	if info.Size() == 0 {
		_ = os.Remove(dest)
		return "", errors.New("snapshot is empty")
	}
	return dest, nil
}

// checkSnapshotSpace verifies the filesystem can hold a copy of the database
// before VACUUM INTO starts writing one. VACUUM INTO writes straight to its
// destination (unlike a bare VACUUM, which needs a temp file), so the database
// size plus a margin is the right estimate.
func (s *SystemService) checkSnapshotSpace() error {
	info, err := os.Stat(s.dbPath)
	if err != nil {
		return nil // caller already established the file exists; don't block on a race
	}
	need := info.Size() + info.Size()/10 + 16<<20
	disk, err := s.GetDiskInfo()
	if err != nil {
		return nil // can't determine free space — don't block the snapshot
	}
	if disk.Free < need {
		return wrapKind(ErrStorageFull, fmt.Errorf(
			"not enough disk space for a pre-migration snapshot: need about %s, only %s free",
			humanizeBytes(need), humanizeBytes(disk.Free)))
	}
	return nil
}

// RestoreDBSnapshot puts snapshotPath back at the database path, replacing
// whatever a failed migration left there. cause, when non-nil, is written to a
// note beside the preserved database — the process is normally about to exit,
// so that note is the durable record of why.
//
// The caller MUST have closed every connection to the database first.
//
// The ordering below is the whole point of this function, so it is spelled out:
//
//   - The live path is only ever replaced by renaming a complete file over it.
//     There is no moment where nothing exists at dbPath, because an absent
//     point.db makes the next boot initialize a fresh empty database from
//     schema.sql — silent, total data loss.
//   - The broken database is preserved with a hard link, never a rename, for the
//     same reason.
//   - The WAL/SHM sidecars go before the rename, not after. They belong to the
//     broken database; left next to the restored snapshot they get replayed into
//     it and SQLite reports "database disk image is malformed".
//   - A marker is written first and cleared last, so a crash anywhere in the
//     middle is finished by ApplyPendingMigrationRestore on the next boot.
func (s *SystemService) RestoreDBSnapshot(snapshotPath string, cause error) error {
	if s.dbPath == "" {
		return errors.New("no database path configured")
	}
	//nolint:gosec // G703: the boot passes a path it just wrote; the resume path
	// composes it from the snapshot directory after isSafeBackupName.
	info, err := os.Stat(snapshotPath)
	if err != nil {
		return fmt.Errorf("snapshot unusable, leaving the database untouched: %w", err)
	}
	if info.Size() == 0 {
		return fmt.Errorf("snapshot %s is empty, leaving the database untouched", filepath.Base(snapshotPath))
	}

	dir := s.migrationSnapshotDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create snapshot directory: %w", err)
	}

	s.preserveBrokenDB(dir, cause)

	marker := filepath.Join(dir, migrationRestoreMarker)
	if err := os.WriteFile(marker, []byte(filepath.Base(snapshotPath)), 0o644); err != nil {
		return fmt.Errorf("write restore marker: %w", err)
	}
	_ = fsyncDir(dir)

	staging := s.dbPath + restoringSuffix
	if err := copyFileSync(snapshotPath, staging); err != nil {
		_ = os.Remove(staging)
		return fmt.Errorf("stage snapshot: %w", err)
	}

	s.removeDBSidecars()

	if err := os.Rename(staging, s.dbPath); err != nil {
		_ = os.Remove(staging)
		return fmt.Errorf("swap in snapshot: %w", err)
	}
	_ = fsyncDir(filepath.Dir(s.dbPath))

	// Belt and braces: nothing can have recreated a sidecar with the database
	// closed, but a leftover one is unrecoverable and this costs nothing.
	s.removeDBSidecars()

	_ = os.Remove(marker)
	return nil
}

// preserveBrokenDB hard-links the database aside before it is replaced, so the
// state a failed migration left behind can still be examined. A hard link costs
// no space and no copy time; the bytes survive because the rename that follows
// only replaces the directory entry. Best-effort throughout: a missing forensic
// copy must never stop a restore.
func (s *SystemService) preserveBrokenDB(dir string, cause error) {
	failed := uniquePath(dir, migrationFailedPrefix, ".db")
	if err := os.Link(s.dbPath, failed); err != nil {
		// Usually EXDEV: the database lives on a different filesystem from the
		// data directory. Not worth a copy — the snapshot is what matters.
		slog.Warn("could not preserve the failed database for diagnosis", "error", err)
		return
	}
	// Link the WAL too when there is one, so the pair opens together.
	if _, err := os.Stat(s.dbPath + "-wal"); err == nil {
		_ = os.Link(s.dbPath+"-wal", failed+"-wal")
	}
	if cause != nil {
		note := fmt.Sprintf("pre-migration restore at %s\ndatabase preserved as %s\n\n%s\n",
			time.Now().Format(time.RFC3339), filepath.Base(failed), cause.Error())
		_ = os.WriteFile(strings.TrimSuffix(failed, ".db")+".txt", []byte(note), 0o644)
	}
	slog.Warn("preserved the failed database for diagnosis", "path", failed)
}

// ApplyPendingMigrationRestore finishes a snapshot restore that was interrupted
// by a crash, a kill, or a power loss. It MUST be called at startup before the
// database is opened, for the same reason ApplyPendingRestore must.
//
// Unlike ApplyPendingRestore, the marker is NOT consumed unconditionally: it is
// cleared only by a restore that completes. A restore that keeps failing keeps
// the boot failing, which is the right trade — the alternative is serving
// whatever a half-finished swap left behind. The error names the manual way out.
func (s *SystemService) ApplyPendingMigrationRestore() (bool, error) {
	marker := filepath.Join(s.migrationSnapshotDir(), migrationRestoreMarker)
	data, err := os.ReadFile(marker)
	if err != nil {
		return false, nil // nothing interrupted
	}

	name := strings.TrimSpace(string(data))
	if !isSafeBackupName(name) {
		return true, fmt.Errorf("interrupted restore names an invalid snapshot %q — "+
			"delete %s once you have checked the database", name, marker)
	}
	snapshot := filepath.Join(s.migrationSnapshotDir(), name)
	if err := s.RestoreDBSnapshot(snapshot, nil); err != nil {
		return true, fmt.Errorf("could not finish the interrupted restore of %s: %w — "+
			"recover with scripts/restore-db.sh", name, err)
	}
	return true, nil
}

// pruneMigrationSnapshots keeps the `keep` newest pre-migration snapshots and
// the `keep` newest preserved failures (with their notes), deleting the rest so
// the directory cannot grow without bound across a boot loop. keep <= 0 deletes
// every snapshot. Returns how many files were deleted.
func (s *SystemService) pruneMigrationSnapshots(keep int) (int, error) {
	dir := s.migrationSnapshotDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	type snapshot struct {
		name string
		mod  time.Time
	}
	families := map[string][]snapshot{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".db") {
			continue
		}
		var family string
		switch {
		case strings.HasPrefix(e.Name(), migrationSnapshotPrefix):
			family = migrationSnapshotPrefix
		case strings.HasPrefix(e.Name(), migrationFailedPrefix):
			family = migrationFailedPrefix
		default:
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		families[family] = append(families[family], snapshot{e.Name(), info.ModTime()})
	}

	deleted := 0
	for _, files := range families {
		if len(files) <= keep {
			continue
		}
		sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })
		for _, f := range files[max(keep, 0):] {
			if err := os.Remove(filepath.Join(dir, f.name)); err != nil {
				continue
			}
			deleted++
			// Drop the artifacts that only make sense alongside the file.
			_ = os.Remove(filepath.Join(dir, f.name+"-wal"))
			_ = os.Remove(filepath.Join(dir, strings.TrimSuffix(f.name, ".db")+".txt"))
		}
	}
	return deleted, nil
}

// uniquePath builds <dir>/<prefix><timestamp><ext>, adding a counter if that
// name is taken. The timestamp has second resolution, and a boot that fails
// fast enough to be restarted within the same second would otherwise overwrite
// the snapshot it is about to need.
func uniquePath(dir, prefix, ext string) string {
	stamp := time.Now().Format("20060102_150405")
	candidate := filepath.Join(dir, prefix+stamp+ext)
	for i := 2; i < 100; i++ {
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
		candidate = filepath.Join(dir, fmt.Sprintf("%s%s_%d%s", prefix, stamp, i, ext))
	}
	return candidate
}

// copyFileSync copies src to dst and fsyncs it, so the bytes are on disk before
// the caller renames dst into place.
func copyFileSync(src, dst string) error {
	//nolint:gosec // G703: both paths are composed by the caller from the data
	// directory and the database path, never from request input.
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// fsyncDir flushes a directory entry, so a rename survives a power loss. On
// ext4 with data=ordered the rename itself is journaled but can still be lost
// without this.
func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	return d.Sync()
}
