package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestCacheService_PathTraversal(t *testing.T) {
	tempDir := t.TempDir()
	cacheService := NewCacheService(tempDir)
	ctx := context.Background()

	t.Run("Get with path traversal", func(t *testing.T) {
		secretFile := filepath.Join(tempDir, "secret.txt")
		err := os.WriteFile(secretFile, []byte("sensitive"), 0644)
		assert.NoError(t, err)

		// Try to access it via ../secret.txt
		_, err = cacheService.Get(ctx, "../secret.txt")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "invalid cache key")

		// Try .
		_, err = cacheService.Get(ctx, ".")
		assert.Error(t, err)
	})

	t.Run("Set with path traversal", func(t *testing.T) {
		err := cacheService.Set(ctx, "../traversal.txt", []byte("hacked"))
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "invalid cache key")

		// Verify file was NOT created
		_, err = os.Stat(filepath.Join(tempDir, "traversal.txt"))
		assert.True(t, os.IsNotExist(err))
	})

	t.Run("Invalidate with path traversal", func(t *testing.T) {
		secretFile := filepath.Join(tempDir, "secret2.txt")
		err := os.WriteFile(secretFile, []byte("sensitive"), 0644)
		assert.NoError(t, err)

		err = cacheService.Invalidate(ctx, "../secret2.txt")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "invalid cache key")

		// Verify file still exists
		_, err = os.Stat(secretFile)
		assert.NoError(t, err)
	})

	t.Run("GetWithTTL with path traversal", func(t *testing.T) {
		_, err := cacheService.GetWithTTL(ctx, "../secret.txt", 0)
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "invalid cache key")
	})
}
