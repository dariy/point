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

// runTask is the single choke point every scheduled job passes through, which
// is what makes the health record complete rather than per-task opt-in.
// See point-system-health-admin.
func TestSchedulerRunTaskRecordsHealth(t *testing.T) {
	h := NewHealthRegistry()
	s := (&SchedulerService{}).WithHealth(h)
	ctx := context.Background()

	s.runTask(ctx, "ok task", func(context.Context) error { return nil })
	s.runTask(ctx, "bad task", func(context.Context) error { return errors.New("nope") })

	snap := h.Snapshot()
	if len(snap) != 2 {
		t.Fatalf("recorded %d tasks, want 2", len(snap))
	}
	byName := map[string]TaskHealth{}
	for _, t := range snap {
		byName[t.Name] = t
	}
	if !byName["ok task"].Healthy() {
		t.Error("successful task recorded as unhealthy")
	}
	if byName["bad task"].Healthy() {
		t.Error("failed task recorded as healthy")
	}
	if byName["bad task"].LastError != "nope" {
		t.Errorf("bad task LastError = %q, want \"nope\"", byName["bad task"].LastError)
	}
}

// A panic is the failure most worth surfacing; recovering it must not also
// hide it from the health view.
func TestSchedulerRunTaskRecordsPanicAsFailure(t *testing.T) {
	h := NewHealthRegistry()
	s := (&SchedulerService{}).WithHealth(h)

	s.runTask(context.Background(), "panicker", func(context.Context) error {
		panic("kaboom")
	})

	snap := h.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("recorded %d tasks, want 1", len(snap))
	}
	if snap[0].Healthy() {
		t.Error("a panicking task must be recorded as unhealthy")
	}
	if !strings.Contains(snap[0].LastError, "kaboom") {
		t.Errorf("LastError = %q, want it to mention the panic value", snap[0].LastError)
	}
}

// Services built without a registry must still run.
func TestSchedulerRunTaskWithoutHealthRegistry(t *testing.T) {
	s := &SchedulerService{}
	s.runTask(context.Background(), "no registry", func(context.Context) error { return errors.New("x") })
}
