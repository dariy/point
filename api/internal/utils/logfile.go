package utils

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// RotatingFile is a size-rotating io.Writer for the application log.
//
// It exists because the admin Logs page reads data/logs/app.log while the
// process logs to stdout: without a file on disk the page is permanently
// empty, and in Docker the stdout stream is not reachable from inside the
// container. Teeing slog into this writer gives the page something to read on
// every deployment shape, container or bare binary.
//
// Rotation is hand-rolled rather than pulled in as a dependency: the whole
// requirement is "keep the last few MB", which does not justify a module in a
// project whose point is a single self-hosted binary.
//
// On reaching MaxBytes the current file is renamed to app.log.1, the previous
// app.log.1 to app.log.2 and so on, and anything past MaxBackups is deleted.
// A write larger than MaxBytes is never split — it goes to the current file
// whole, which then rotates on the next write.
type RotatingFile struct {
	// Path is the active log file. Its directory is created on first write.
	Path string
	// MaxBytes is the size at which the active file is rotated.
	MaxBytes int64
	// MaxBackups is how many rotated files to keep (app.log.1 … app.log.N).
	MaxBackups int

	mu   sync.Mutex
	f    *os.File
	size int64
}

// Log rotation sizing, shared by the writer in main and the admin Logs
// handler that reads the files back. 5MB x 3 backups keeps roughly the last
// 20MB of history — enough to cover an incident, small enough to sit inside a
// data volume without being noticed.
const (
	LogMaxBytes   int64 = 5 << 20
	LogMaxBackups       = 3
)

// NewRotatingFile returns a writer for path keeping maxBackups rotations of at
// most maxBytes each. The file is opened lazily on the first write so that
// constructing the logger cannot fail at startup.
func NewRotatingFile(path string, maxBytes int64, maxBackups int) *RotatingFile {
	return &RotatingFile{Path: path, MaxBytes: maxBytes, MaxBackups: maxBackups}
}

// Write implements io.Writer. Errors are returned to the caller, but slog
// discards them — a failing log file must never take down the process, and
// stdout remains the authoritative stream.
func (r *RotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.f == nil {
		if err := r.open(); err != nil {
			return 0, err
		}
	}

	// Rotate before writing when the file is already at the limit, so the
	// active file never grows past MaxBytes by more than one record.
	if r.size >= r.MaxBytes {
		if err := r.rotate(); err != nil {
			return 0, err
		}
	}

	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

// Close releases the underlying file. Safe to call more than once.
func (r *RotatingFile) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f == nil {
		return nil
	}
	err := r.f.Close()
	r.f = nil
	return err
}

// open creates the log directory and opens the active file in append mode,
// seeding size from the existing file so a restart does not reset rotation.
func (r *RotatingFile) open() error {
	if err := os.MkdirAll(filepath.Dir(r.Path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(r.Path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	r.f = f
	r.size = 0
	if info, err := f.Stat(); err == nil {
		r.size = info.Size()
	}
	return nil
}

// rotate closes the active file, shifts app.log.N → app.log.N+1 dropping the
// oldest, moves the active file to app.log.1 and opens a fresh one.
func (r *RotatingFile) rotate() error {
	if err := r.f.Close(); err != nil {
		return err
	}
	r.f = nil

	// Shift from the oldest down so no rename overwrites a file still needed.
	for i := r.MaxBackups; i >= 1; i-- {
		src := fmt.Sprintf("%s.%d", r.Path, i)
		if i == r.MaxBackups {
			_ = os.Remove(src)
			continue
		}
		dst := fmt.Sprintf("%s.%d", r.Path, i+1)
		if _, err := os.Stat(src); err == nil {
			_ = os.Rename(src, dst)
		}
	}
	if r.MaxBackups > 0 {
		_ = os.Rename(r.Path, r.Path+".1")
	} else {
		_ = os.Remove(r.Path)
	}

	return r.open()
}

// RotatedLogFiles returns the active log file followed by its rotations in
// age order (app.log, app.log.1, app.log.2 …), skipping any that are missing.
// The Logs handler uses it to read back further than the active file alone.
func RotatedLogFiles(path string, maxBackups int) []string {
	out := []string{}
	if _, err := os.Stat(path); err == nil {
		out = append(out, path)
	}
	rotations := []string{}
	for i := 1; i <= maxBackups; i++ {
		p := fmt.Sprintf("%s.%d", path, i)
		if _, err := os.Stat(p); err == nil {
			rotations = append(rotations, p)
		}
	}
	// Stat order is already ascending, but sort defensively so the caller can
	// rely on "index 1 is the newest rotation".
	sort.Slice(rotations, func(a, b int) bool {
		return len(rotations[a]) < len(rotations[b]) ||
			(len(rotations[a]) == len(rotations[b]) && strings.Compare(rotations[a], rotations[b]) < 0)
	})
	return append(out, rotations...)
}
