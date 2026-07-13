package services

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// A panicking task must not propagate — background goroutines have no
// middleware.Recover, so an unrecovered panic would kill the server.
func TestSchedulerRunTaskRecoversPanic(t *testing.T) {
	s := &SchedulerService{}
	s.runTask(context.Background(), "boom", func(context.Context) error {
		panic("kaboom")
	})
	// Reaching this line means the panic was recovered.
}

func TestSchedulerRunTaskLogsErrorWithoutPanic(t *testing.T) {
	s := &SchedulerService{}
	s.runTask(context.Background(), "fails", func(context.Context) error {
		return errors.New("nope")
	})
}

// Transport errors from the Graph API client must not leak the access token:
// url.Error embeds the full request URL, and these URLs carry access_token in
// the query string — and they now get logged instead of discarded.
func TestInstagramTransportErrorRedactsToken(t *testing.T) {
	req, _ := http.NewRequest(http.MethodGet, "https://graph.example/v20.0/refresh_access_token?access_token=SECRET123", nil)
	wrapped := redactTransportErr("GET", req, &url.Error{
		Op:  "Get",
		URL: req.URL.String(),
		Err: errors.New("dial tcp: connection refused"),
	})
	if strings.Contains(wrapped.Error(), "SECRET123") {
		t.Fatalf("token leaked into error: %q", wrapped)
	}
	if !strings.Contains(wrapped.Error(), "/v20.0/refresh_access_token") {
		t.Errorf("expected path kept for diagnosability, got %q", wrapped)
	}
}
