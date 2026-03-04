package repository

import (
	"os"
	"testing"
)

func setupTestDB(t *testing.T) *Repository {
	repo, err := NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create test repository: %v", err)
	}

	schema, err := os.ReadFile("../../sql/schema.sql")
	if err != nil {
		t.Fatalf("failed to read schema: %v", err)
	}

	_, err = repo.DB().Exec(string(schema))
	if err != nil {
		t.Fatalf("failed to execute schema: %v", err)
	}

	return repo
}
