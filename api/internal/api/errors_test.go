package api

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"testing"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// httpError extracts the *echo.HTTPError MapError is expected to produce.
func httpError(t *testing.T, err error) *echo.HTTPError {
	t.Helper()
	var he *echo.HTTPError
	if !errors.As(err, &he) {
		t.Fatalf("MapError returned %v (%T), want *echo.HTTPError", err, err)
	}
	return he
}

// TestEveryKindHasAStatus is the guard that keeps the taxonomy and the mapper
// in step: adding a kind in internal/services without a status here fails.
func TestEveryKindHasAStatus(t *testing.T) {
	for _, kind := range services.ErrorKinds {
		if _, ok := statusByKind[kind]; !ok {
			t.Errorf("kind %v has no HTTP status in statusByKind", kind)
		}
	}
	if len(statusByKind) != len(services.ErrorKinds) {
		t.Errorf("statusByKind has %d entries, services.ErrorKinds has %d; a stale entry is left over",
			len(statusByKind), len(services.ErrorKinds))
	}
}

// TestMapErrorKinds covers every kind, both bare and wrapped, since services
// wrap on the way up and the status must survive it.
func TestMapErrorKinds(t *testing.T) {
	tests := []struct {
		name       string
		kind       error
		wantStatus int
	}{
		{"not found", services.ErrNotFound, http.StatusNotFound},
		{"invalid input", services.ErrInvalidInput, http.StatusBadRequest},
		{"conflict", services.ErrConflict, http.StatusConflict},
		{"unprocessable", services.ErrUnprocessable, http.StatusUnprocessableEntity},
		{"unauthenticated", services.ErrUnauthenticated, http.StatusUnauthorized},
		{"forbidden", services.ErrForbidden, http.StatusForbidden},
		{"upstream", services.ErrUpstream, http.StatusBadGateway},
		{"storage full", services.ErrStorageFull, http.StatusInsufficientStorage},
	}

	// Every kind must be exercised, so a kind added later cannot sit untested.
	if len(tests) != len(services.ErrorKinds) {
		t.Fatalf("test table covers %d kinds, taxonomy has %d", len(tests), len(services.ErrorKinds))
	}

	for _, tt := range tests {
		t.Run(tt.name+" bare", func(t *testing.T) {
			he := httpError(t, MapError(tt.kind))
			if he.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", he.Code, tt.wantStatus)
			}
		})

		t.Run(tt.name+" wrapped", func(t *testing.T) {
			err := fmt.Errorf("outer context: %w", tt.kind)
			he := httpError(t, MapError(err))
			if he.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", he.Code, tt.wantStatus)
			}
			// The service's message is the detail, unchanged.
			if he.Message != err.Error() {
				t.Errorf("detail = %v, want %q", he.Message, err.Error())
			}
		})
	}
}

// TestMapErrorNamedSentinels pins the sentinels the service layer actually
// returns to the status a caller will now see.
func TestMapErrorNamedSentinels(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
	}{
		{"ErrMediaNotFound", services.ErrMediaNotFound, http.StatusNotFound},
		{"ErrNotAnImage", services.ErrNotAnImage, http.StatusBadRequest},
		{"ErrUnsupportedMediaType", services.ErrUnsupportedMediaType, http.StatusBadRequest},
		{"ErrActiveSVGContent", services.ErrActiveSVGContent, http.StatusBadRequest},
		{"ErrBackupInProgress", services.ErrBackupInProgress, http.StatusConflict},
		{"ErrResponseUnusable", services.ErrResponseUnusable, http.StatusBadGateway},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			he := httpError(t, MapError(tt.err))
			if he.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d", he.Code, tt.wantStatus)
			}
			if he.Message != tt.err.Error() {
				t.Errorf("detail = %v, want %q", he.Message, tt.err.Error())
			}
		})
	}
}

// TestMapErrorUnclassified covers the fallback: no kind means 500 with nothing
// of the underlying error in the body.
func TestMapErrorUnclassified(t *testing.T) {
	for _, tt := range []struct {
		name string
		err  error
	}{
		{"plain error", errors.New("boom")},
		{"raw driver error", sql.ErrNoRows},
		{"a closed database", errors.New("sql: database is closed")},
		// Deliberately unkinded in .1: our stored hash is broken, not the input.
		{"malformed stored hash", services.ErrInvalidHash},
		{"incompatible argon2 version", services.ErrIncompatibleVersion},
	} {
		t.Run(tt.name, func(t *testing.T) {
			he := httpError(t, MapError(tt.err))
			if he.Code != http.StatusInternalServerError {
				t.Errorf("status = %d, want 500", he.Code)
			}
			if he.Message != "internal server error" {
				t.Errorf("detail = %v, want a generic message; internals must not reach the client", he.Message)
			}
		})
	}
}

func TestMapErrorNil(t *testing.T) {
	// Must be a truly nil interface, not a nil *echo.HTTPError inside one.
	if err := MapError(nil); err != nil {
		t.Errorf("MapError(nil) = %v, want nil", err)
	}
}

// TestMapErrorPreservesExplicitHTTPError covers the passthrough that lets
// handlers keep a status they chose deliberately, including one wrapped by a
// service (tag_service still does this for slug collisions).
func TestMapErrorPreservesExplicitHTTPError(t *testing.T) {
	t.Run("bare", func(t *testing.T) {
		original := echo.NewHTTPError(http.StatusTeapot, "short and stout")
		he := httpError(t, MapError(original))
		if he.Code != http.StatusTeapot || he.Message != "short and stout" {
			t.Errorf("got %d/%v, want 418/short and stout", he.Code, he.Message)
		}
	})

	t.Run("wrapped", func(t *testing.T) {
		err := fmt.Errorf("create tag: %w", echo.NewHTTPError(http.StatusConflict, "a tag with that slug already exists"))
		he := httpError(t, MapError(err))
		if he.Code != http.StatusConflict {
			t.Errorf("status = %d, want 409", he.Code)
		}
	})

	t.Run("explicit status beats an inferred kind", func(t *testing.T) {
		// If both are present the handler's own choice wins, so migrating a
		// handler can never be made worse by the service adding a kind.
		err := fmt.Errorf("%w: %w", echo.NewHTTPError(http.StatusForbidden, "nope"), services.ErrNotFound)
		he := httpError(t, MapError(err))
		if he.Code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", he.Code)
		}
	})
}
