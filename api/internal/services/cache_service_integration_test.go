//go:build !unit

package services

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestCacheService_SetAndGet(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	data := []byte("hello cache")
	if err := svc.Set(ctx, "key1", data); err != nil {
		t.Fatalf("Set failed: %v", err)
	}

	got, err := svc.Get(ctx, "key1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if string(got) != string(data) {
		t.Errorf("expected %q, got %q", data, got)
	}
}

func TestCacheService_Get_Missing(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	_, err := svc.Get(ctx, "nonexistent")
	if err == nil {
		t.Error("expected error for missing key")
	}
}

func TestCacheService_Get_Empty(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	// Write an empty file manually
	if err := os.WriteFile(svc.cacheDir+"/emptykey", []byte{}, 0644); err != nil {
		t.Fatal(err)
	}

	_, err := svc.Get(ctx, "emptykey")
	if err == nil {
		t.Error("expected error for empty cache file")
	}
}

func TestCacheService_Invalidate(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	_ = svc.Set(ctx, "key2", []byte("data"))
	if err := svc.Invalidate(ctx, "key2"); err != nil {
		t.Fatalf("Invalidate failed: %v", err)
	}

	_, err := svc.Get(ctx, "key2")
	if err == nil {
		t.Error("expected error after invalidation")
	}
}

func TestCacheService_Clear(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	_ = svc.Set(ctx, "a", []byte("1"))
	_ = svc.Set(ctx, "b", []byte("2"))

	if err := svc.Clear(ctx); err != nil {
		t.Fatalf("Clear failed: %v", err)
	}

	_, err := svc.Get(ctx, "a")
	if err == nil {
		t.Error("expected error after Clear")
	}

	// Clear must empty the directory, not remove it: callers discard Set's
	// error, so a missing cache dir would silently disable caching until the
	// next restart.
	if err := svc.Set(ctx, "c", []byte("3")); err != nil {
		t.Fatalf("Set after Clear failed: %v", err)
	}
	got, err := svc.Get(ctx, "c")
	if err != nil || string(got) != "3" {
		t.Errorf("cache is dead after Clear: got %q, err %v", got, err)
	}
}

// InvalidatePublicPages is the write-side entry point: any post or tag write
// drops every rendered page, because the keys cannot be mapped back to the post
// that changed.
func TestCacheService_InvalidatePublicPages(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	_ = svc.Set(ctx, "homepage_p1_pp12.json", []byte("{}"))
	_ = svc.Set(ctx, "tagpage_kyiv_path-_p1_pp12.json", []byte("{}"))
	_ = svc.Set(ctx, "feed.xml", []byte("<rss/>"))

	if err := svc.InvalidatePublicPages(ctx); err != nil {
		t.Fatalf("InvalidatePublicPages failed: %v", err)
	}
	for _, k := range []string{"homepage_p1_pp12.json", "tagpage_kyiv_path-_p1_pp12.json", "feed.xml"} {
		if _, err := svc.Get(ctx, k); err == nil {
			t.Errorf("%s survived invalidation", k)
		}
	}
	if err := svc.Set(ctx, "homepage_p1_pp12.json", []byte("{}")); err != nil {
		t.Fatalf("cache must still be writable afterwards: %v", err)
	}
}

func TestCacheService_GetWithTTL_Valid(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	_ = svc.Set(ctx, "ttlkey", []byte("fresh"))

	got, err := svc.GetWithTTL(ctx, "ttlkey", 1*time.Hour)
	if err != nil {
		t.Fatalf("GetWithTTL failed: %v", err)
	}
	if string(got) != "fresh" {
		t.Errorf("expected 'fresh', got %q", got)
	}
}

func TestCacheService_GetWithTTL_Expired(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	_ = svc.Set(ctx, "expkey", []byte("stale"))

	// Use a TTL in the past
	_, err := svc.GetWithTTL(ctx, "expkey", -1*time.Second)
	if err == nil {
		t.Error("expected error for expired TTL")
	}
}

func TestCacheService_GetWithTTL_Missing(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	_, err := svc.GetWithTTL(ctx, "nosuchkey", 1*time.Hour)
	if err == nil {
		t.Error("expected error for missing key with TTL")
	}
}

func TestCacheService_GetWithTTL_Empty(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	_ = os.WriteFile(svc.cacheDir+"/emptykey2", []byte{}, 0644)

	_, err := svc.GetWithTTL(ctx, "emptykey2", 1*time.Hour)
	if err == nil {
		t.Error("expected error for empty file with TTL")
	}
}

// TestCacheService_Set_Atomic is the regression test for torn reads: Set used
// os.WriteFile, which truncates the live path before writing, so a reader that
// arrived mid-write on a hot key saw a prefix of the payload and served it as
// JSON. The payload here is large enough to span several write syscalls, which
// is what opens the window in the first place.
func TestCacheService_Set_Atomic(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	payload := bytes.Repeat([]byte("point"), 40_000) // 200 KB
	const key = "homepage_atomic.json"

	// Seed the key so readers always find something: the assertion is about
	// completeness, not about hitting on the first iteration.
	if err := svc.Set(ctx, key, payload); err != nil {
		t.Fatalf("seed Set failed: %v", err)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})
	torn := make(chan int, 1)

	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				data, err := svc.GetWithTTL(ctx, key, 1*time.Hour)
				if err != nil {
					continue // a miss is fine; a partial read is not
				}
				if !bytes.Equal(data, payload) {
					select {
					case torn <- len(data):
					default:
					}
					return
				}
			}
		}()
	}

	for i := 0; i < 200; i++ {
		if err := svc.Set(ctx, key, payload); err != nil {
			t.Errorf("Set failed: %v", err)
			break
		}
	}
	close(stop)
	wg.Wait()

	select {
	case n := <-torn:
		t.Fatalf("reader observed a short read: %d of %d bytes", n, len(payload))
	default:
	}

	// The temp files Set writes must all be gone: they live in the cache
	// directory, which has no eviction, so a leak here is permanent.
	entries, err := os.ReadDir(svc.cacheDir)
	if err != nil {
		t.Fatalf("read cache dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != key {
		names := make([]string, len(entries))
		for i, e := range entries {
			names[i] = e.Name()
		}
		t.Errorf("cache dir should hold only %q, got %v", key, names)
	}
}

// TestCacheService_Set_FailedWriteLeavesNoTempFile exercises the error path:
// a rename that cannot succeed must still clean up after itself, or every
// failure leaves a file behind in a directory nothing ever prunes.
func TestCacheService_Set_FailedWriteLeavesNoTempFile(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	// A directory sitting on the key's path makes the rename fail.
	const key = "blocked.json"
	if err := os.Mkdir(filepath.Join(svc.cacheDir, key), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	if err := svc.Set(ctx, key, []byte("payload")); err == nil {
		t.Fatal("expected Set to fail when the key is occupied by a directory")
	}

	entries, err := os.ReadDir(svc.cacheDir)
	if err != nil {
		t.Fatalf("read cache dir: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != key {
		t.Errorf("failed Set leaked a temp file: %v", entries)
	}
}

// TestCacheService_Set_EntryIsReadable pins the mode: os.CreateTemp opens at
// 0600, and cache entries have always been world-readable.
func TestCacheService_Set_EntryIsReadable(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	if err := svc.Set(ctx, "mode.json", []byte("x")); err != nil {
		t.Fatalf("Set failed: %v", err)
	}
	info, err := os.Stat(filepath.Join(svc.cacheDir, "mode.json"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0644 {
		t.Errorf("cache entry mode is %o, want 644", perm)
	}
}
