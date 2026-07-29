package utils

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestRotatingFileCreatesDirAndWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "app.log")
	r := NewRotatingFile(path, 1024, 3)
	defer func() { _ = r.Close() }()

	if _, err := r.Write([]byte("hello\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "hello\n" {
		t.Errorf("got %q, want %q", got, "hello\n")
	}
}

func TestRotatingFileRotatesAtMaxBytes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	// "line00000\n" is exactly 10 bytes, so each record fills the file to the
	// limit and every write after the first rotates.
	r := NewRotatingFile(path, 10, 2)
	defer func() { _ = r.Close() }()

	for i := 0; i < 4; i++ {
		if _, err := fmt.Fprintf(r, "line%05d\n", i); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}

	// Active file holds the newest record.
	active, _ := os.ReadFile(path)
	if strings.TrimSpace(string(active)) != "line00003" {
		t.Errorf("active = %q, want line00003", strings.TrimSpace(string(active)))
	}
	// .1 is the one before it, .2 the one before that.
	first, _ := os.ReadFile(path + ".1")
	if strings.TrimSpace(string(first)) != "line00002" {
		t.Errorf(".1 = %q, want line00002", strings.TrimSpace(string(first)))
	}
	second, _ := os.ReadFile(path + ".2")
	if strings.TrimSpace(string(second)) != "line00001" {
		t.Errorf(".2 = %q, want line00001", strings.TrimSpace(string(second)))
	}
	// MaxBackups=2, so .3 must never appear.
	if _, err := os.Stat(path + ".3"); !os.IsNotExist(err) {
		t.Errorf("app.log.3 exists but MaxBackups is 2")
	}
}

func TestRotatingFileResumesSizeAcrossRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	if err := os.WriteFile(path, []byte("0123456789"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A fresh writer over an existing 10-byte file at a 10-byte limit must
	// rotate on its first write rather than resetting its size counter.
	r := NewRotatingFile(path, 10, 1)
	defer func() { _ = r.Close() }()
	if _, err := r.Write([]byte("new\n")); err != nil {
		t.Fatal(err)
	}

	rotated, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatalf("expected rotation to app.log.1: %v", err)
	}
	if string(rotated) != "0123456789" {
		t.Errorf("rotated content = %q", rotated)
	}
	active, _ := os.ReadFile(path)
	if string(active) != "new\n" {
		t.Errorf("active = %q, want %q", active, "new\n")
	}
}

func TestRotatingFileOversizedRecordIsNotSplit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	r := NewRotatingFile(path, 8, 1)
	defer func() { _ = r.Close() }()

	big := strings.Repeat("x", 50) + "\n"
	n, err := r.Write([]byte(big))
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if n != len(big) {
		t.Errorf("wrote %d bytes, want %d", n, len(big))
	}
	got, _ := os.ReadFile(path)
	if string(got) != big {
		t.Errorf("oversized record was split or truncated")
	}
}

func TestRotatingFileZeroBackupsDiscards(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	r := NewRotatingFile(path, 10, 0)
	defer func() { _ = r.Close() }()

	for i := 0; i < 3; i++ {
		if _, err := r.Write([]byte("0123456789")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(path + ".1"); !os.IsNotExist(err) {
		t.Errorf("app.log.1 created despite MaxBackups=0")
	}
}

func TestRotatingFileConcurrentWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	r := NewRotatingFile(path, 64, 2)
	defer func() { _ = r.Close() }()

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = r.Write([]byte("concurrent line\n"))
		}()
	}
	wg.Wait()

	// The point is that -race sees no data race and every file stays
	// line-aligned; exact distribution across rotations is timing-dependent.
	for _, p := range RotatedLogFiles(path, 2) {
		b, _ := os.ReadFile(p)
		if len(b) > 0 && b[len(b)-1] != '\n' {
			t.Errorf("%s ends mid-record: %q", p, b)
		}
	}
}

func TestCloseIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	r := NewRotatingFile(path, 100, 1)
	if _, err := r.Write([]byte("x\n")); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
}

func TestRotatedLogFilesOrderAndGaps(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")

	// Nothing on disk yet.
	if got := RotatedLogFiles(path, 3); len(got) != 0 {
		t.Errorf("expected no files, got %v", got)
	}

	for _, name := range []string{"app.log", "app.log.1", "app.log.3"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got := RotatedLogFiles(path, 3)
	want := []string{path, path + ".1", path + ".3"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("index %d: got %s, want %s", i, got[i], want[i])
		}
	}
}
