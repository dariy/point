package api

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/services"
)

// TestPageCacheKey pins the two properties the key composition has to hold:
// the key is filename-safe whatever the visitor typed, and two different
// identities never collide onto one entry.
func TestPageCacheKey(t *testing.T) {
	dirty := pageCacheKey("tagpage", "kyiv_path-location/ukraine_p1_pp12")
	if strings.ContainsAny(dirty, "/\\") {
		t.Errorf("key must not contain a separator, got %q", dirty)
	}
	if !strings.HasPrefix(dirty, "tagpage_") || !strings.HasSuffix(dirty, ".json") {
		t.Errorf("key lost its readable prefix or suffix: %q", dirty)
	}
	if same := pageCacheKey("tagpage", "kyiv_path-location/ukraine_p1_pp12"); same != dirty {
		t.Errorf("key is not stable: %q vs %q", same, dirty)
	}
	if other := pageCacheKey("tagpage", "kyiv_path-_p1_pp12"); other == dirty {
		t.Error("distinct identities collided onto one key")
	}
	if home := pageCacheKey("homepage", "kyiv_path-location/ukraine_p1_pp12"); home == dirty {
		t.Error("distinct prefixes collided onto one key")
	}
}

// TestSetPageCache covers both halves of the write: the payload lands under the
// key, and a refused write is reported rather than swallowed — swallowing is
// what let the path-scoped tag key stay dead for as long as it did.
func TestSetPageCache(t *testing.T) {
	dir := t.TempDir()
	cache := services.NewCacheService(dir)
	ctx := context.Background()

	t.Run("writes the payload", func(t *testing.T) {
		key := pageCacheKey("homepage", "p1_pp12")
		setPageCache(ctx, cache, key, []byte(`{"posts":[]}`))

		got, err := os.ReadFile(filepath.Join(dir, "cache", key))
		if err != nil {
			t.Fatalf("cache entry not written: %v", err)
		}
		if string(got) != `{"posts":[]}` {
			t.Errorf("cached %q, want %q", got, `{"posts":[]}`)
		}
	})

	t.Run("logs a refused write", func(t *testing.T) {
		var buf bytes.Buffer
		restore := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
		defer slog.SetDefault(restore)

		setPageCache(ctx, cache, "not/a/valid/key", []byte("{}"))

		if !strings.Contains(buf.String(), "page cache write failed") {
			t.Errorf("refused write was not logged, got %q", buf.String())
		}
		if !strings.Contains(buf.String(), "not/a/valid/key") {
			t.Errorf("log does not name the key, got %q", buf.String())
		}
	})
}
