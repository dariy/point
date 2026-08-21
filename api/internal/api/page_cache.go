package api

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"

	"point-api/internal/services"
)

// pageCacheKey turns a composed cache identity into a filename-safe key.
//
// The identity carries user-controlled input — a tag slug, the breadcrumb
// `path` chain — which cannot be embedded in a filename directly: CacheService
// rejects any key containing a separator, and it rejected every path-scoped tag
// page for exactly that reason, silently, because both Get and Set errors were
// discarded. Hashing keeps the key opaque and fixed-width, and leaves
// CacheService's traversal guard as belt-and-braces rather than load-bearing.
//
// The prefix stays readable so the cache directory can still be reasoned about
// by eye.
func pageCacheKey(prefix, identity string) string {
	return fmt.Sprintf("%s_%x.json", prefix, sha256.Sum256([]byte(identity)))
}

// setPageCache stores a rendered public payload, logging instead of failing
// when the write is refused.
//
// A cache write is never worth failing a response over — the payload in hand is
// already correct — but discarding the error is what let the path-scoped tag
// key stay dead. One place to write it, one place that reports it.
func setPageCache(ctx context.Context, cache *services.CacheService, key string, data []byte) {
	if err := cache.Set(ctx, key, data); err != nil {
		slog.Warn("page cache write failed", "key", key, "error", err)
	}
}
