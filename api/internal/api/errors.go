package api

import (
	"errors"
	"log/slog"
	"net/http"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// statusByKind gives the HTTP status for each kind in the service error
// taxonomy. The taxonomy and the reasoning behind each kind live in
// internal/services/errors.go; this map is only the translation to HTTP.
//
// Every kind in services.ErrorKinds must appear here — TestEveryKindHasAStatus
// fails if one is added without a status, so a new kind cannot silently start
// answering 500.
var statusByKind = map[error]int{
	services.ErrNotFound:        http.StatusNotFound,
	services.ErrInvalidInput:    http.StatusBadRequest,
	services.ErrConflict:        http.StatusConflict,
	services.ErrUnprocessable:   http.StatusUnprocessableEntity,
	services.ErrUnauthenticated: http.StatusUnauthorized,
	services.ErrForbidden:       http.StatusForbidden,
	services.ErrUpstream:        http.StatusBadGateway,
	services.ErrStorageFull:     http.StatusInsufficientStorage,
	services.ErrTooLarge:        http.StatusRequestEntityTooLarge,
}

// MapError converts a service-layer error into the error a handler should
// return, so handlers never decide a status from an error's text.
//
// The rules, in order:
//
//   - nil maps to nil, so `return MapError(err)` is safe on a success path.
//   - An error already carrying an *echo.HTTPError keeps that status and
//     message. An explicit status beats an inferred one.
//   - An error carrying a taxonomy kind gets that kind's status, with the
//     service's own message as the detail — those messages are written for
//     users and are already free of internal wording.
//   - Anything else is unclassified: a bug, a dead database, a failed write.
//     It is logged in full and answered with a bare 500, because an
//     unclassified error's text is the one thing we know isn't fit to show.
//
// It returns error rather than *echo.HTTPError on purpose: a typed nil pointer
// in a non-nil error interface is the classic way this kind of helper breaks
// its callers.
func MapError(err error) error {
	if err == nil {
		return nil
	}

	var he *echo.HTTPError
	if errors.As(err, &he) {
		return he
	}

	// Kinds are mutually exclusive (asserted in services.TestKindsAreDistinct),
	// so the first match is the only match and iteration order is irrelevant.
	// services.ErrorKinds is iterated rather than statusByKind so the order is
	// deterministic and a missing status is detectable.
	for _, kind := range services.ErrorKinds {
		if !errors.Is(err, kind) {
			continue
		}
		status, ok := statusByKind[kind]
		if !ok {
			// A kind with no status is a wiring mistake, not a caller problem.
			slog.Error("service error kind has no HTTP status", "kind", kind, "error", err)
			break
		}
		return echo.NewHTTPError(status, err.Error())
	}

	slog.Error("unclassified service error", "error", err)
	return echo.NewHTTPError(http.StatusInternalServerError, "internal server error")
}
