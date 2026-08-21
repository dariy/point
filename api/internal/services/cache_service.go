package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// tmpPrefix marks the half-written files Set leaves in the cache directory for
// the instant between create and rename. It starts with a dot so it sorts away
// from real keys, and nothing composes a key that begins with it.
const tmpPrefix = ".tmp-"

type CacheService struct {
	cacheDir string
}

func NewCacheService(dataPath string) *CacheService {
	cacheDir := filepath.Join(dataPath, "cache")
	_ = os.MkdirAll(cacheDir, 0755)
	return &CacheService{
		cacheDir: cacheDir,
	}
}

func (s *CacheService) validateKey(key string) error {
	if key == "." || strings.Contains(key, "..") || strings.ContainsAny(key, "/\\") {
		return wrapKind(ErrInvalidInput, errors.New("invalid cache key"))
	}
	return nil
}

func (s *CacheService) Get(ctx context.Context, key string) ([]byte, error) {
	if err := s.validateKey(key); err != nil {
		return nil, err
	}
	path := filepath.Join(s.cacheDir, key)
	_, err := os.Stat(path)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		_ = os.Remove(path)
		return nil, fmt.Errorf("cache file empty")
	}
	return data, nil
}

// Set writes a cache entry atomically: into a sibling temp file, then rename.
//
// os.WriteFile truncates the live path before it writes, so a reader arriving
// mid-write on a hot key — the home feed and the tag archives are shared by
// every anonymous visitor — could read a prefix of the payload and serve it as
// application/json. The zero-length case was caught; a truncated one was not,
// and it surfaces as an intermittent SPA parse error on a page that works on
// reload. Rename is atomic within a filesystem, so a reader sees either the
// whole previous entry or the whole new one.
func (s *CacheService) Set(ctx context.Context, key string, data []byte) error {
	if err := s.validateKey(key); err != nil {
		return err
	}
	path := filepath.Join(s.cacheDir, key)

	f, err := os.CreateTemp(s.cacheDir, tmpPrefix+"*")
	if err != nil {
		return err
	}
	tmpPath := f.Name()
	// A no-op once the rename below has succeeded; on every error path this is
	// what keeps failed writes from accumulating in the cache directory.
	defer func() { _ = os.Remove(tmpPath) }()

	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	// CreateTemp opens at 0600; cache entries have always been world-readable.
	if err := os.Chmod(tmpPath, 0644); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func (s *CacheService) Invalidate(ctx context.Context, key string) error {
	if err := s.validateKey(key); err != nil {
		return err
	}
	path := filepath.Join(s.cacheDir, key)
	return os.Remove(path)
}

// Clear empties the cache, keeping the directory itself. Removing the
// directory would leave every subsequent Set writing into a path that no longer
// exists — and since callers discard Set's error, caching would silently stay
// off until the next restart.
func (s *CacheService) Clear(ctx context.Context) error {
	entries, err := os.ReadDir(s.cacheDir)
	if err != nil {
		if os.IsNotExist(err) {
			return os.MkdirAll(s.cacheDir, 0755)
		}
		return err
	}
	var firstErr error
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(s.cacheDir, e.Name())); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

// InvalidatePublicPages drops every cached public payload after a write that
// could change what a guest sees.
//
// It is deliberately all-or-nothing. Every entry in this cache — the home feed
// pages, the tag archives, feed.xml, sitemap.xml — is derived from which posts
// are publicly visible, and the keys are per page *and* per `per_page` (which
// is device-fit, so the key space is effectively unbounded). There is no way to
// map "post 244 became hidden" back to the handful of keys that mentioned it,
// and serving a post in a list that 404s when opened is a worse outcome than
// re-rendering a few pages.
func (s *CacheService) InvalidatePublicPages(ctx context.Context) error {
	return s.Clear(ctx)
}

func (s *CacheService) GetWithTTL(ctx context.Context, key string, ttl time.Duration) ([]byte, error) {
	if err := s.validateKey(key); err != nil {
		return nil, err
	}
	path := filepath.Join(s.cacheDir, key)
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}

	if time.Since(info.ModTime()) > ttl {
		_ = os.Remove(path)
		return nil, fmt.Errorf("cache expired")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		_ = os.Remove(path)
		return nil, fmt.Errorf("cache file empty")
	}
	return data, nil
}
