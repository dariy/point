package services

import (
	"context"
	"os"
	"testing"
	"time"
)

func setupCacheService(t *testing.T) (*CacheService, string) {
	t.Helper()
	dir, err := os.MkdirTemp("", "cache-test")
	if err != nil {
		t.Fatal(err)
	}
	svc := NewCacheService(dir)
	return svc, dir
}

func TestCacheService_SetAndGet(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer os.RemoveAll(dir)
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
	defer os.RemoveAll(dir)
	ctx := context.Background()

	_, err := svc.Get(ctx, "nonexistent")
	if err == nil {
		t.Error("expected error for missing key")
	}
}

func TestCacheService_Get_Empty(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer os.RemoveAll(dir)
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
	defer os.RemoveAll(dir)
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
	defer os.RemoveAll(dir)
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
}

func TestCacheService_GetWithTTL_Valid(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer os.RemoveAll(dir)
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
	defer os.RemoveAll(dir)
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
	defer os.RemoveAll(dir)
	ctx := context.Background()

	_, err := svc.GetWithTTL(ctx, "nosuchkey", 1*time.Hour)
	if err == nil {
		t.Error("expected error for missing key with TTL")
	}
}

func TestCacheService_GetWithTTL_Empty(t *testing.T) {
	svc, dir := setupCacheService(t)
	defer os.RemoveAll(dir)
	ctx := context.Background()

	_ = os.WriteFile(svc.cacheDir+"/emptykey2", []byte{}, 0644)

	_, err := svc.GetWithTTL(ctx, "emptykey2", 1*time.Hour)
	if err == nil {
		t.Error("expected error for empty file with TTL")
	}
}
