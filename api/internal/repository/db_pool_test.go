package repository

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A file-backed database must open a real pool, and every connection in it
// must carry the PRAGMAs — they are per-connection state, which is why they
// are set via the DSN rather than a one-off db.Exec.
// See point-perf-sqlite-maxconns.
func TestNewRepository_PooledConnectionsAllCarryPragmas(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "pool.db")
	repo, err := NewRepository(dbPath)
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()

	db := repo.DB()
	if got := db.Stats().MaxOpenConnections; got != maxOpenConns {
		t.Errorf("MaxOpenConnections = %d, want %d", got, maxOpenConns)
	}

	ctx := context.Background()
	// Pin every connection in the pool open at once, then check each one
	// individually. A PRAGMA applied with a single db.Exec would only have
	// configured whichever connection happened to serve that call.
	var wg sync.WaitGroup
	gate := make(chan struct{})
	errs := make(chan error, maxOpenConns)
	for i := 0; i < maxOpenConns; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := db.Conn(ctx)
			if err != nil {
				errs <- err
				return
			}
			defer func() { _ = c.Close() }()

			var journal string
			if err := c.QueryRowContext(ctx, "PRAGMA journal_mode;").Scan(&journal); err != nil {
				errs <- err
				return
			}
			if !strings.EqualFold(journal, "wal") {
				t.Errorf("pooled connection journal_mode = %q, want wal", journal)
			}
			var fk int
			if err := c.QueryRowContext(ctx, "PRAGMA foreign_keys;").Scan(&fk); err != nil {
				errs <- err
				return
			}
			if fk != 1 {
				t.Error("pooled connection has foreign_keys off")
			}
			var sync int
			if err := c.QueryRowContext(ctx, "PRAGMA synchronous;").Scan(&sync); err != nil {
				errs <- err
				return
			}
			if sync != 1 { // 1 = NORMAL
				t.Errorf("pooled connection synchronous = %d, want 1 (NORMAL)", sync)
			}
			// Hold the connection until every goroutine has one, forcing the
			// pool to actually open maxOpenConns distinct connections.
			<-gate
		}()
	}
	// Wait for the pool to actually open every connection before releasing
	// the goroutines, so no two of them can share one.
	deadline := time.Now().Add(10 * time.Second)
	for db.Stats().OpenConnections < maxOpenConns {
		select {
		case err := <-errs:
			close(gate)
			wg.Wait()
			t.Fatalf("pooled connection: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			close(gate)
			wg.Wait()
			t.Fatalf("pool only opened %d of %d connections", db.Stats().OpenConnections, maxOpenConns)
		}
		time.Sleep(time.Millisecond)
	}
	close(gate)
	wg.Wait()
	select {
	case err := <-errs:
		t.Fatalf("pooled connection: %v", err)
	default:
	}
}

// In-memory DSNs give each connection its own private database, so the pool
// must stay at one connection or the schema would vanish at random.
func TestNewRepository_MemoryStaysSingleConnection(t *testing.T) {
	repo, err := NewRepository(":memory:")
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	defer func() { _ = repo.Close() }()
	if got := repo.DB().Stats().MaxOpenConnections; got != 1 {
		t.Errorf("in-memory MaxOpenConnections = %d, want 1", got)
	}
}

func TestIsMemoryDSN(t *testing.T) {
	for dsn, want := range map[string]bool{
		":memory:":                   true,
		"file::memory:?cache=shared": true,
		"file:x?mode=memory":         true,
		"/var/lib/point/point.db":    false,
		"./data/point.db":            false,
	} {
		if got := isMemoryDSN(dsn); got != want {
			t.Errorf("isMemoryDSN(%q) = %v, want %v", dsn, got, want)
		}
	}
}

func TestPragmaDSN(t *testing.T) {
	got := pragmaDSN("./data/point.db", 8)
	for _, want := range []string{
		"./data/point.db?",
		"_pragma=busy_timeout(5000)",
		"_pragma=journal_mode(WAL)",
		"_pragma=synchronous(NORMAL)",
		"_pragma=foreign_keys(ON)",
		"_txlock=immediate",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("pragmaDSN missing %q; got %q", want, got)
		}
	}
	// The page-cache budget is split across the pool, not multiplied by it.
	if !strings.Contains(got, "_pragma=cache_size(-25000)") {
		t.Errorf("pragmaDSN did not divide cache_size across 8 conns; got %q", got)
	}
	// An existing query string must be extended, not replaced.
	if s := pragmaDSN("file::memory:?cache=shared", 1); !strings.Contains(s, "cache=shared&_pragma=") {
		t.Errorf("pragmaDSN clobbered an existing query string: %q", s)
	}
}
