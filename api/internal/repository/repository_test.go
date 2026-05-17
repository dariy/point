package repository

import (
	"testing"
)

func setupTestDB(t *testing.T) *Repository {
	repo, err := NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create test repository: %v", err)
	}

	return repo
}
