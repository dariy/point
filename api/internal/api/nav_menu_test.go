package api

import (
	"point-api/internal/services"
	"testing"
)

func newNavMenuHandler(t *testing.T) *NavMenuHandler {
	t.Helper()
	repo := setupTestDB(t)
	return NewNavMenuHandler(services.NewSettingsService(repo))
}
