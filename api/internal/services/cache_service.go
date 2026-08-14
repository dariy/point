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

func (s *CacheService) Set(ctx context.Context, key string, data []byte) error {
	if err := s.validateKey(key); err != nil {
		return err
	}
	path := filepath.Join(s.cacheDir, key)
	return os.WriteFile(path, data, 0644)
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
