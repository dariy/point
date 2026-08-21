//go:build !unit

package services

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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

// TestCacheService_Set_MissingCacheDir covers the other end of the write: if
// the cache directory has been removed under a running server, Set must report
// it rather than half-create anything. Callers log that warning; Clear is what
// puts the directory back.
func TestCacheService_Set_MissingCacheDir(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	if err := os.RemoveAll(svc.cacheDir); err != nil {
		t.Fatalf("remove cache dir: %v", err)
	}

	if err := svc.Set(ctx, "gone.json", []byte("payload")); err == nil {
		t.Error("expected Set to fail with no cache directory")
	}
}

// TestCacheService_GetOrRender_CoalescesMisses is the stampede regression: on a
// TTL expiry every concurrent reader of a hot key used to run the full render.
// N readers arriving at one cold key must produce exactly one render, and all
// of them must get its bytes.
func TestCacheService_GetOrRender_CoalescesMisses(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	const (
		key      = "homepage_stampede.json"
		readers  = 32
		rendered = "the rendered page"
	)

	var renders atomic.Int64
	// The render blocks until every reader has had time to arrive, so the test
	// cannot pass merely because the goroutines happened to run in sequence.
	release := make(chan struct{})

	var wg sync.WaitGroup
	results := make([][]byte, readers)
	errs := make([]error, readers)
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = svc.GetOrRender(ctx, key, 1*time.Hour, func(context.Context) ([]byte, error) {
				renders.Add(1)
				<-release
				return []byte(rendered), nil
			})
		}(i)
	}

	// Give the readers a moment to pile up behind the flight before letting the
	// leader finish. A short sleep is enough: a premature release would only
	// make the test weaker, never flaky.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if n := renders.Load(); n != 1 {
		t.Errorf("render ran %d times for %d concurrent readers, want 1", n, readers)
	}
	for i := range results {
		if errs[i] != nil {
			t.Fatalf("reader %d failed: %v", i, errs[i])
		}
		if string(results[i]) != rendered {
			t.Errorf("reader %d got %q, want %q", i, results[i], rendered)
		}
	}

	// And the flight left the entry behind, so the next reader does not render
	// either.
	got, err := svc.GetOrRender(ctx, key, 1*time.Hour, func(context.Context) ([]byte, error) {
		t.Error("a fresh entry must be served without rendering")
		return nil, nil
	})
	if err != nil || string(got) != rendered {
		t.Errorf("cached read: got %q, err %v", got, err)
	}
}

// TestCacheService_GetOrRender_Expiry pins the other half: coalescing must not
// turn into serving a stale entry forever. Once the TTL has passed, the next
// reader renders again.
func TestCacheService_GetOrRender_Expiry(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	const key = "homepage_expiry.json"
	if err := svc.Set(ctx, key, []byte("old")); err != nil {
		t.Fatalf("seed Set failed: %v", err)
	}

	got, err := svc.GetOrRender(ctx, key, -1*time.Second, func(context.Context) ([]byte, error) {
		return []byte("new"), nil
	})
	if err != nil {
		t.Fatalf("GetOrRender failed: %v", err)
	}
	if string(got) != "new" {
		t.Errorf("expired entry was served: got %q", got)
	}

	fresh, err := svc.Get(ctx, key)
	if err != nil || string(fresh) != "new" {
		t.Errorf("re-render was not stored: got %q, err %v", fresh, err)
	}
}

// TestCacheService_GetOrRender_ErrorIsNotCached: a handler that fails — a tag
// that 404s, a query that errors — must not have its failure installed as the
// entry for the next TTL. Every waiter sees the error, and the key stays cold.
func TestCacheService_GetOrRender_ErrorIsNotCached(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	const key = "homepage_failed.json"
	sentinel := errors.New("render failed")

	if _, err := svc.GetOrRender(ctx, key, 1*time.Hour, func(context.Context) ([]byte, error) {
		return nil, sentinel
	}); !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want %v", err, sentinel)
	}

	if _, err := svc.Get(ctx, key); err == nil {
		t.Error("a failed render was cached")
	}

	got, err := svc.GetOrRender(ctx, key, 1*time.Hour, func(context.Context) ([]byte, error) {
		return []byte("recovered"), nil
	})
	if err != nil || string(got) != "recovered" {
		t.Errorf("the key stayed poisoned: got %q, err %v", got, err)
	}
}

// TestCacheService_GetOrRender_SurvivesLeaderCancellation: the goroutine that
// wins the flight is one arbitrary request among the waiters. If its client
// hangs up, everyone queued behind it must still be answered — which is why the
// render runs on a context detached from cancellation.
func TestCacheService_GetOrRender_SurvivesLeaderCancellation(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()

	const key = "homepage_cancelled.json"
	leaderCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	got, err := svc.GetOrRender(leaderCtx, key, 1*time.Hour, func(ctx context.Context) ([]byte, error) {
		cancel() // the leader's client goes away mid-render
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		return []byte("rendered anyway"), nil
	})
	if err != nil {
		t.Fatalf("a cancelled leader must not fail the render: %v", err)
	}
	if string(got) != "rendered anyway" {
		t.Errorf("got %q", got)
	}
}

// TestCacheService_GetOrRender_ReportsRefusedWrite: a write the cache refuses
// costs the next reader a re-render and nothing more, so it must not fail the
// response — but it must be logged. Discarding it is what let a permanently
// dead cache key go unnoticed.
func TestCacheService_GetOrRender_ReportsRefusedWrite(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer func() { _ = os.RemoveAll(dir) }()
	ctx := context.Background()

	var buf bytes.Buffer
	restore := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(restore)

	// A directory sitting on the key's path makes the rename fail.
	const key = "blocked_write.json"
	if err := os.Mkdir(filepath.Join(svc.cacheDir, key), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	got, err := svc.GetOrRender(ctx, key, 1*time.Hour, func(context.Context) ([]byte, error) {
		return []byte("payload"), nil
	})
	if err != nil {
		t.Fatalf("a refused write must not fail the response: %v", err)
	}
	if string(got) != "payload" {
		t.Errorf("got %q, want %q", got, "payload")
	}
	if !strings.Contains(buf.String(), "page cache write failed") {
		t.Errorf("refused write was not logged, got %q", buf.String())
	}
	if !strings.Contains(buf.String(), key) {
		t.Errorf("log does not name the key, got %q", buf.String())
	}
}
