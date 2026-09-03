package services

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// findTask returns the recorded health entry for name, or false when the
// registry has never seen it.
func findTask(h *HealthRegistry, name string) (TaskHealth, bool) {
	for _, t := range h.Snapshot() {
		if t.Name == name {
			return t, true
		}
	}
	return TaskHealth{}, false
}

// backupServiceForHook builds a SystemService over a throwaway data dir with no
// database (dbPath ""), so CreateBackup just tars the data tree — enough to
// exercise the post-backup hook without a repository.
func backupServiceForHook(t *testing.T) (*SystemService, string, *HealthRegistry) {
	t.Helper()
	dataPath := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataPath, "marker.txt"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := NewHealthRegistry()
	return NewSystemService(nil, dataPath, "").WithHealth(h), dataPath, h
}

// TestBackupHook_RunsWithArchiveContext: a configured hook runs after a
// successful backup and is handed the archive path (as $1 and $POINT_BACKUP_FILE)
// plus the name, checksum and dir. Its success is recorded in the health registry.
func TestBackupHook_RunsWithArchiveContext(t *testing.T) {
	s, dataPath, h := backupServiceForHook(t)
	out := filepath.Join(t.TempDir(), "hook-saw.txt")
	s.WithBackupHook(
		`{ echo "arg1=$1"; echo "file=$POINT_BACKUP_FILE"; echo "name=$POINT_BACKUP_NAME"; `+
			`echo "sha=$POINT_BACKUP_SHA256"; echo "dir=$POINT_BACKUP_DIR"; } > "`+out+`"`,
		10*time.Second,
	)

	name, _, err := s.CreateBackup(context.Background())
	if err != nil {
		t.Fatalf("CreateBackup: %v", err)
	}
	archive := filepath.Join(dataPath, "backups", name)

	body, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("hook did not run: %v", err)
	}
	got := string(body)
	for _, want := range []string{
		"arg1=" + archive,
		"file=" + archive,
		"name=" + name,
		"dir=" + filepath.Join(dataPath, "backups"),
	} {
		if !strings.Contains(got, want) {
			t.Errorf("hook env missing %q; got:\n%s", want, got)
		}
	}
	// The checksum passed to the hook matches the sidecar on disk.
	sidecar, err := os.ReadFile(archive + ".sha256")
	if err != nil {
		t.Fatal(err)
	}
	sum := strings.Fields(string(sidecar))[0]
	if !strings.Contains(got, "sha="+sum) {
		t.Errorf("hook sha %q not found; got:\n%s", sum, got)
	}

	task, ok := findTask(h, healthTaskBackupHook)
	if !ok {
		t.Fatal("hook success not recorded in health registry")
	}
	if !task.Healthy() || task.Failures != 0 {
		t.Errorf("hook task unhealthy: %+v", task)
	}
}

// TestBackupHook_FailureIsSurfacedNotFatal: a hook that exits non-zero leaves the
// backup itself successful (the archive is on disk) but records a failure — with
// the hook's output — against the health registry.
func TestBackupHook_FailureIsSurfacedNotFatal(t *testing.T) {
	s, dataPath, h := backupServiceForHook(t)
	s.WithBackupHook(`echo "s3 upload denied" >&2; exit 7`, 10*time.Second)

	name, _, err := s.CreateBackup(context.Background())
	if err != nil {
		t.Fatalf("CreateBackup should not fail when only the hook fails: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dataPath, "backups", name)); err != nil {
		t.Fatalf("archive missing after hook failure: %v", err)
	}

	task, ok := findTask(h, healthTaskBackupHook)
	if !ok {
		t.Fatal("hook failure not recorded")
	}
	if task.Healthy() || task.Failures != 1 {
		t.Errorf("expected one recorded failure, got %+v", task)
	}
	if !strings.Contains(task.LastError, "s3 upload denied") {
		t.Errorf("hook output not captured in health error: %q", task.LastError)
	}
}

// TestBackupHook_Timeout: a hook that overruns its timeout is killed and
// recorded as a timeout failure; the backup still succeeds.
func TestBackupHook_Timeout(t *testing.T) {
	s, dataPath, h := backupServiceForHook(t)
	s.WithBackupHook(`sleep 30`, 150*time.Millisecond)

	start := time.Now()
	name, _, err := s.CreateBackup(context.Background())
	if err != nil {
		t.Fatalf("CreateBackup: %v", err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("hook was not killed at its timeout (took %s)", elapsed)
	}
	if _, err := os.Stat(filepath.Join(dataPath, "backups", name)); err != nil {
		t.Fatalf("archive missing: %v", err)
	}

	task, ok := findTask(h, healthTaskBackupHook)
	if !ok {
		t.Fatal("hook timeout not recorded")
	}
	if !strings.Contains(task.LastError, "timed out") {
		t.Errorf("expected a timeout error, got %q", task.LastError)
	}
}

// TestBackupHook_DisabledLeavesNoHealthEntry: with no hook configured, backups
// work as before and no "backup off-host copy" job appears — an operator who
// wants no off-host copy should not see a job about it at all.
func TestBackupHook_DisabledLeavesNoHealthEntry(t *testing.T) {
	s, _, h := backupServiceForHook(t)

	if _, _, err := s.CreateBackup(context.Background()); err != nil {
		t.Fatalf("CreateBackup: %v", err)
	}
	if _, ok := findTask(h, healthTaskBackupHook); ok {
		t.Error("healthTaskBackupHook recorded despite no hook configured")
	}
}
