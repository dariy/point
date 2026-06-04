package services

import (
	"testing"

	"point-api/internal/repository"
)

func setupTestDB(t *testing.T) repository.Repository {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create test repository: %v", err)
	}

	return repo
}
