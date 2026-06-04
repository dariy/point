package services

import (
	"context"
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
		return fmt.Errorf("invalid cache key")
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

func (s *CacheService) Clear(ctx context.Context) error {
	return os.RemoveAll(s.cacheDir)
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
