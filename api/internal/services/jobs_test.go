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

func TestJobRetryRequeuesFailedJob(t *testing.T) {
	ctx := context.Background()
	s, _ := newTestJobs(t)
	fail := true
	s.Register("k", func(context.Context, json.RawMessage) error {
		if fail {
			return errors.New("boom")
		}
		return nil
	})
	id, _ := s.Enqueue(ctx, "k", map[string]any{"post_id": 7, "caption": "secret"})
	if err := s.Retry(ctx, id); !errors.Is(err, ErrJobNotFailed) {
		t.Fatalf("retry of a queued job: err = %v", err)
	}
	// Force the job to failed.
	if err := s.repo.FinishJob(ctx, id, JobFailed, "boom", s.now()); err != nil {
		t.Fatal(err)
	}

	jobs, err := s.List(ctx, 10)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("list: %v %+v", err, jobs)
	}
	if got := jobs[0].Refs; len(got) != 1 || got["post_id"] != 7 {
		t.Fatalf("refs = %v, want only post_id", got)
	}
	counts, _ := s.Counts(ctx)
	if counts[JobFailed] != 1 || counts[JobQueued] != 0 {
		t.Fatalf("counts = %v", counts)
	}

	fail = false
	if err := s.Retry(ctx, id); err != nil {
		t.Fatal(err)
	}
	j, _ := s.repo.GetJob(ctx, id)
	if j.State != JobQueued || j.Attempts != 0 {
		t.Fatalf("after retry: %+v", j)
	}
	select {
	case <-s.wake:
	default:
		t.Fatal("retry did not wake the worker")
	}
	if ran, err := s.RunOnce(ctx); err != nil || !ran {
		t.Fatalf("run after retry: ran=%v err=%v", ran, err)
	}
	if j, _ := s.repo.GetJob(ctx, id); j.State != JobDone {
		t.Fatalf("state = %q, want done", j.State)
	}
}

func TestJobPruneDoneKeepsFailed(t *testing.T) {
	ctx := context.Background()
	s, now := newTestJobs(t)
	old := now.Add(-JobDoneRetention - time.Hour).Unix()
	recent := now.Add(-time.Hour).Unix()
	ids := map[string]int64{}
	for _, c := range []struct {
		key, state string
		at         int64
	}{
		{"done-old", JobDone, old}, {"done-recent", JobDone, recent},
		{"failed-old", JobFailed, old}, {"queued-old", JobQueued, old}, {"running-old", JobRunning, old},
	} {
		id, err := s.Enqueue(ctx, "k", nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := s.repo.DB().ExecContext(ctx, `UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?`, c.state, c.at, id); err != nil {
			t.Fatal(err)
		}
		ids[c.key] = id
	}
	if n, err := s.PruneDone(ctx); err != nil || n != 1 {
		t.Fatalf("PruneDone = %d, %v", n, err)
	}
	for key, id := range ids {
		_, err := s.repo.GetJob(ctx, id)
		if gone := err != nil; gone != (key == "done-old") {
			t.Fatalf("%s gone = %v", key, gone)
		}
	}
	if n, err := s.ClearFailed(ctx); err != nil || n != 1 {
		t.Fatalf("ClearFailed = %d, %v", n, err)
	}
	if _, err := s.repo.GetJob(ctx, ids["failed-old"]); err == nil {
		t.Fatal("failed job remains after ClearFailed")
	}
}

func TestSchedulerPruneJobs(t *testing.T) {
	ctx := context.Background()
	s, now := newTestJobs(t)
	id, err := s.Enqueue(ctx, "k", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.DB().ExecContext(ctx, `UPDATE jobs SET state = 'done', updated_at = ? WHERE id = ?`,
		now.Add(-JobDoneRetention-time.Hour).Unix(), id); err != nil {
		t.Fatal(err)
	}
	sched := (&SchedulerService{}).WithJobs(s)
	if err := sched.pruneJobs(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.GetJob(ctx, id); err == nil {
		t.Fatal("old done job remains after the scheduler prune")
	}
}
