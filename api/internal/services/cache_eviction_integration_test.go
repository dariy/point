//go:build !unit

package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"point-api/internal/config"
)

// dirBytes is what the budget is enforced against: every regular file in the
// cache directory, temp files included.
func dirBytes(t *testing.T, dir string) int64 {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	var total int64
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatalf("Info: %v", err)
		}
		if !e.IsDir() {
			total += info.Size()
		}
	}
	return total
}

// A cache written far past its budget stays under it. This is the whole point
// of the sweep: nothing else removes an entry except a content write dropping
// the lot, so without it the directory grows with traffic and takes the volume
// — shared with the database and the media — down with it.
func TestCacheService_Eviction_StaysUnderBudget(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	const budgetMB = 1
	svc.WithBudgetMB(budgetMB)
	budget := int64(budgetMB) * 1024 * 1024

	// 4 MB of payload into a 1 MB budget, in 64 KB entries. The entry size is
	// deliberately under a tenth of the budget — that is the condition the
	// watermarks rely on, and real page payloads sit far below it.
	payload := make([]byte, 64*1024)
	for i := range payload {
		payload[i] = byte('a' + i%26)
	}
	for i := 0; i < 64; i++ {
		if err := svc.Set(ctx, fmt.Sprintf("entry%03d.json", i), payload); err != nil {
			t.Fatalf("Set %d: %v", i, err)
		}
		if got := dirBytes(t, svc.cacheDir); got > budget {
			t.Fatalf("after %d writes cache is %d bytes, over the %d byte budget", i+1, got, budget)
		}
	}

	// Something has to survive: a sweep that emptied the cache would keep the
	// directory small and the cache useless.
	if got := dirBytes(t, svc.cacheDir); got == 0 {
		t.Fatal("eviction emptied the cache")
	}
}

// Eviction takes the oldest entries first, so the ones still being requested —
// and therefore still being rewritten as they expire — are the ones that stay.
func TestCacheService_Eviction_OldestFirst(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	svc.WithBudgetMB(1)

	payload := make([]byte, 128*1024)
	// Written oldest-first, one hour apart, so mtime order is unambiguous
	// regardless of how fast the test runs.
	base := time.Now().Add(-24 * time.Hour)
	for i := 0; i < 12; i++ {
		key := fmt.Sprintf("entry%02d.json", i)
		if err := svc.Set(ctx, key, payload); err != nil {
			t.Fatalf("Set %d: %v", i, err)
		}
		stamp := base.Add(time.Duration(i) * time.Hour)
		if err := os.Chtimes(filepath.Join(svc.cacheDir, key), stamp, stamp); err != nil {
			t.Fatalf("Chtimes: %v", err)
		}
	}

	// One more write to trigger a sweep now that the mtimes are set.
	if err := svc.Set(ctx, "newest.json", payload); err != nil {
		t.Fatalf("Set newest: %v", err)
	}

	if _, err := svc.Get(ctx, "newest.json"); err != nil {
		t.Errorf("newest entry was evicted: %v", err)
	}
	if _, err := svc.Get(ctx, "entry00.json"); err == nil {
		t.Error("oldest entry survived a sweep that had to evict")
	}
}

// A crash between CreateTemp and Rename leaves a temp file that no code path
// other than the sweep will ever remove.
func TestCacheService_Eviction_CollectsStaleTempFiles(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	svc.WithBudgetMB(1)

	stale := filepath.Join(svc.cacheDir, tmpPrefix+"crashed")
	if err := os.WriteFile(stale, []byte("half a page"), 0644); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-2 * tmpMaxAge)
	if err := os.Chtimes(stale, old, old); err != nil {
		t.Fatal(err)
	}

	fresh := filepath.Join(svc.cacheDir, tmpPrefix+"inflight")
	if err := os.WriteFile(fresh, []byte("still being written"), 0644); err != nil {
		t.Fatal(err)
	}

	// The first Set after a restart always sweeps.
	if err := svc.Set(ctx, "trigger.json", []byte("payload")); err != nil {
		t.Fatalf("Set: %v", err)
	}

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale temp file survived the sweep (err=%v)", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Errorf("in-flight temp file was collected: %v", err)
	}
}

// config cannot import services, so PAGE_CACHE_BUDGET_MB's default is a
// literal over there. This is what notices when the two drift apart.
func TestCacheService_DefaultBudgetMatchesConfig(t *testing.T) {
	t.Setenv("PAGE_CACHE_BUDGET_MB", "")
	cfg, err := config.LoadConfig(t.TempDir())
	if err != nil {
		t.Fatalf("LoadConfig: %v", err)
	}
	if cfg.PageCacheBudgetMB != DefaultBudgetMB {
		t.Errorf("config default is %d MB, services.DefaultBudgetMB is %d MB", cfg.PageCacheBudgetMB, DefaultBudgetMB)
	}
}

// A zero budget is the operator turning eviction off, not a zero-byte cache.
func TestCacheService_Eviction_ZeroBudgetDisables(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	svc.WithBudgetMB(0)

	payload := make([]byte, 64*1024)
	for i := 0; i < 40; i++ {
		if err := svc.Set(ctx, fmt.Sprintf("entry%02d.json", i), payload); err != nil {
			t.Fatalf("Set %d: %v", i, err)
		}
	}

	if got := dirBytes(t, svc.cacheDir); got < 40*int64(len(payload)) {
		t.Errorf("eviction ran with the budget disabled: %d bytes for %d entries", got, 40)
	}
}

// The sweep must survive concurrent writers: Set is called from every request
// that misses, and the sweep deletes files out from under the others.
func TestCacheService_Eviction_ConcurrentSets(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	svc.WithBudgetMB(1)
	budget := int64(1024 * 1024)

	payload := make([]byte, 32*1024)
	done := make(chan error, 8)
	for w := 0; w < 8; w++ {
		go func(w int) {
			for i := 0; i < 20; i++ {
				if err := svc.Set(ctx, fmt.Sprintf("w%d-e%02d.json", w, i), payload); err != nil {
					done <- err
					return
				}
			}
			done <- nil
		}(w)
	}
	for w := 0; w < 8; w++ {
		if err := <-done; err != nil {
			t.Fatalf("concurrent Set: %v", err)
		}
	}

	if got := dirBytes(t, svc.cacheDir); got > budget {
		t.Errorf("cache is %d bytes after concurrent writes, over the %d byte budget", got, budget)
	}
	// Nothing half-written left behind.
	entries, err := os.ReadDir(svc.cacheDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), tmpPrefix) {
			t.Errorf("temp file %q left behind by a completed Set", e.Name())
		}
	}
}
