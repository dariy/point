package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
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

func (s *CacheService) Get(ctx context.Context, key string) ([]byte, error) {
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
	path := filepath.Join(s.cacheDir, key)
	return os.WriteFile(path, data, 0644)
}

func (s *CacheService) Invalidate(ctx context.Context, key string) error {
	path := filepath.Join(s.cacheDir, key)
	return os.Remove(path)
}

func (s *CacheService) Clear(ctx context.Context) error {
	return os.RemoveAll(s.cacheDir)
}

func (s *CacheService) GetWithTTL(ctx context.Context, key string, ttl time.Duration) ([]byte, error) {
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
