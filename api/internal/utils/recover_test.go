package utils

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// captureLogs swaps slog.Default for a buffer-backed logger for the test.
// It returns the buffer and a mutex that must be held for every read of it,
// since a background goroutine may still be writing.
func captureLogs(t *testing.T) (*bytes.Buffer, *sync.Mutex) {
	t.Helper()
	var (
		buf bytes.Buffer
		mu  sync.Mutex
	)
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{&buf, &mu}, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf, &mu
}

type lockedWriter struct {
	buf *bytes.Buffer
	mu  *sync.Mutex
}

func (w *lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

func TestSafeGoRecoversAndLogs(t *testing.T) {
	buf, mu := captureLogs(t)
	SafeGo("unit test", func() { panic("boom") })

	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		out := buf.String()
		mu.Unlock()
		if strings.Contains(out, "background goroutine panicked") &&
			strings.Contains(out, "boom") && strings.Contains(out, "stack=") {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("panic not logged in time: %q", out)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRecoveredFuncRunsOnPanicCallback(t *testing.T) {
	_, _ = captureLogs(t)
	called := false
	func() {
		defer RecoveredFunc("unit test", func(r any) {
			called = true
			if r != "kaboom" {
				t.Errorf("recovered = %v, want kaboom", r)
			}
		})
		panic("kaboom")
	}()
	if !called {
		t.Fatal("onPanic callback not invoked")
	}
}

func TestRecoveredNoPanicIsNoop(t *testing.T) {
	buf, mu := captureLogs(t)
	func() { defer Recovered("unit test") }()
	mu.Lock()
	defer mu.Unlock()
	if buf.Len() != 0 {
		t.Fatalf("unexpected log output: %q", buf.String())
	}
}
