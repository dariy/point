package services

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"point-api/internal/migrations"
)

func newTestJobs(t *testing.T) (*JobService, *time.Time) {
	t.Helper()
	repo := setupTestDB(t)
	t.Cleanup(func() { _ = repo.Close() })
	if err := migrations.Run(context.Background(), repo); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	s := NewJobService(repo)
	now := time.Unix(1_700_000_000, 0)
	s.now = func() time.Time { return now }
	return s, &now
}

func TestJobRetryBackoffThenFail(t *testing.T) {
	ctx := context.Background()
	s, now := newTestJobs(t)
	calls := 0
	s.Register("k", func(context.Context, json.RawMessage) error { calls++; return errors.New("boom") })
	id, err := s.Enqueue(ctx, "k", map[string]int{"a": 1})
	if err != nil {
		t.Fatal(err)
	}

	for attempt := int64(1); attempt <= defaultJobMaxAttempts; attempt++ {
		if ran, err := s.RunOnce(ctx); err != nil || !ran {
			t.Fatalf("attempt %d: ran=%v err=%v", attempt, ran, err)
		}
		j, _ := s.repo.GetJob(ctx, id)
		if attempt < defaultJobMaxAttempts {
			want := now.Add(s.backoff(attempt)).Unix()
			if j.State != JobQueued || j.NextRunAt != want || j.LastError != "boom" {
				t.Fatalf("attempt %d: %+v, want queued at %d", attempt, j, want)
			}
			// Not due yet.
			if ran, _ := s.RunOnce(ctx); ran {
				t.Fatalf("attempt %d: ran before backoff passed", attempt)
			}
			*now = time.Unix(j.NextRunAt, 0)
		} else if j.State != JobFailed {
			t.Fatalf("after max attempts: state %q", j.State)
		}
	}
	if calls != defaultJobMaxAttempts {
		t.Fatalf("calls = %d", calls)
	}
}

func TestJobPanicIsRecoveredAsFailure(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestJobs(t)
	s.Register("k", func(context.Context, json.RawMessage) error { panic("bad") })
	id, _ := s.Enqueue(ctx, "k", nil)
	if _, err := s.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	j, _ := s.repo.GetJob(ctx, id)
	if j.State != JobQueued || j.LastError != "panic: bad" {
		t.Fatalf("got %+v", j)
	}
}

func TestJobRunningRequeuedAtStart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, _ := newTestJobs(t)
	id, _ := s.Enqueue(ctx, "k", nil)
	// A process stopped mid-job: the row stays running.
	if j, err := s.repo.ClaimDueJob(ctx, s.now()); err != nil || j == nil || j.ID != id {
		t.Fatalf("claim: %v %v", j, err)
	}

	done := make(chan string, 1)
	s.Register("k", func(_ context.Context, p json.RawMessage) error { done <- "ok"; return nil })
	s.Start(ctx)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("requeued job did not run")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		j, _ := s.repo.GetJob(ctx, id)
		if j.State == JobDone {
			if j.Attempts != 2 {
				t.Fatalf("attempts = %d, want 2", j.Attempts)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("state %q", j.State)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestJobEnqueueWakesWorker(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, _ := newTestJobs(t)
	s.poll = time.Hour
	got := make(chan string, 1)
	s.Register("k", func(_ context.Context, p json.RawMessage) error { got <- string(p); return nil })
	s.Start(ctx)
	if _, err := s.Enqueue(ctx, "k", map[string]string{"x": "y"}); err != nil {
		t.Fatal(err)
	}
	select {
	case p := <-got:
		if p != `{"x":"y"}` {
			t.Fatalf("payload %s", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("enqueue did not wake the worker")
	}
}
