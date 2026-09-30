package services

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
	"time"

	"point-api/internal/repository"
	"point-api/internal/utils"
)

// Job states in the jobs table.
const (
	JobQueued  = "queued"
	JobRunning = "running"
	JobDone    = "done"
	JobFailed  = "failed"
)

const (
	defaultJobMaxAttempts = 5
	defaultJobPoll        = 30 * time.Second
	defaultJobBackoffBase = 30 * time.Second
	maxJobBackoff         = 6 * time.Hour
)

// JobHandler does the work of one job. A returned error (or a panic) counts as
// a failed attempt; the job runs again after a backoff until max_attempts.
type JobHandler func(ctx context.Context, payload json.RawMessage) error

// JobService is the durable job store: rows in the SQLite jobs table and one
// worker goroutine that runs them one at a time. Enqueue wakes the worker; a
// poll tick finds jobs whose backoff has passed. See the p-zm2s epic decisions.
type JobService struct {
	repo        repository.Repository
	mu          sync.RWMutex
	handlers    map[string]JobHandler
	wake        chan struct{}
	poll        time.Duration
	backoffBase time.Duration
	now         func() time.Time
}

func NewJobService(repo repository.Repository) *JobService {
	return &JobService{
		repo:        repo,
		handlers:    map[string]JobHandler{},
		wake:        make(chan struct{}, 1),
		poll:        defaultJobPoll,
		backoffBase: defaultJobBackoffBase,
		now:         time.Now,
	}
}

// Register sets the handler for a job kind. Register all kinds before Start.
func (s *JobService) Register(kind string, h JobHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[kind] = h
}

// Enqueue stores a job and wakes the worker. payload is encoded as JSON.
func (s *JobService) Enqueue(ctx context.Context, kind string, payload any) (int64, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("encode %s payload: %w", kind, err)
	}
	id, err := s.repo.InsertJob(ctx, kind, string(raw), defaultJobMaxAttempts, s.now())
	if err != nil {
		return 0, fmt.Errorf("enqueue %s: %w", kind, err)
	}
	s.signal()
	return id, nil
}

func (s *JobService) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Start sets rows left running by a stopped process back to queued, then
// starts the worker. The worker stops when ctx is done.
func (s *JobService) Start(ctx context.Context) {
	if n, err := s.repo.RequeueRunningJobs(ctx); err != nil {
		slog.Error("jobs: requeue running jobs", "error", err)
	} else if n > 0 {
		slog.Info("jobs: requeued interrupted jobs", "count", n)
	}
	utils.SafeGo("job worker", func() { s.loop(ctx) })
}

func (s *JobService) loop(ctx context.Context) {
	ticker := time.NewTicker(s.poll)
	defer ticker.Stop()
	for {
		s.drain(ctx)
		select {
		case <-ctx.Done():
			return
		case <-s.wake:
		case <-ticker.C:
		}
	}
}

// drain runs every due job, one at a time, until none is due.
func (s *JobService) drain(ctx context.Context) {
	for ctx.Err() == nil {
		ran, err := s.RunOnce(ctx)
		if err != nil {
			slog.Error("jobs: claim", "error", err)
			return
		}
		if !ran {
			return
		}
	}
}

// RunOnce claims and runs one due job. It reports whether a job ran.
func (s *JobService) RunOnce(ctx context.Context) (bool, error) {
	job, err := s.repo.ClaimDueJob(ctx, s.now())
	if err != nil || job == nil {
		return false, err
	}
	runErr := s.run(ctx, job)
	state, lastErr, next := JobDone, "", s.now()
	if runErr != nil {
		lastErr = runErr.Error()
		if job.Attempts >= job.MaxAttempts {
			state = JobFailed
			slog.Error("jobs: failed", "id", job.ID, "kind", job.Kind, "attempts", job.Attempts, "error", runErr)
		} else {
			state = JobQueued
			next = next.Add(s.backoff(job.Attempts))
			slog.Warn("jobs: attempt failed", "id", job.ID, "kind", job.Kind, "attempts", job.Attempts, "retry_at", next, "error", runErr)
		}
	}
	// A cancelled ctx must not leave the row running forever; Start requeues
	// it at the next boot anyway, so a background ctx is safe here.
	if err := s.repo.FinishJob(context.WithoutCancel(ctx), job.ID, state, lastErr, next); err != nil {
		return true, fmt.Errorf("finish job %d: %w", job.ID, err)
	}
	return true, nil
}

// run calls the handler and turns a panic into an error.
func (s *JobService) run(ctx context.Context, job *repository.Job) (err error) {
	s.mu.RLock()
	h, ok := s.handlers[job.Kind]
	s.mu.RUnlock()
	if !ok {
		return fmt.Errorf("no handler for job kind %q", job.Kind)
	}
	defer func() {
		if r := recover(); r != nil {
			slog.Error("job panicked", "id", job.ID, "kind", job.Kind, "panic", r, "stack", string(debug.Stack()))
			err = fmt.Errorf("panic: %v", r)
		}
	}()
	return h(ctx, json.RawMessage(job.Payload))
}

// backoff is base * 2^(attempts-1), capped at maxJobBackoff.
func (s *JobService) backoff(attempts int64) time.Duration {
	d := s.backoffBase
	for i := int64(1); i < attempts && d < maxJobBackoff; i++ {
		d *= 2
	}
	return min(d, maxJobBackoff)
}
