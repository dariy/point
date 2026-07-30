package services

import (
	"sort"
	"sync"
	"time"
)

// TaskHealth is the recorded outcome history for one named background job.
//
// Only the last run and last failure are kept, not a log: the point is to
// answer "is anything quietly broken right now", which is the question a
// self-hosted operator actually has and which nothing but the request log could
// answer before. Full history is what the logs are for.
type TaskHealth struct {
	Name string `json:"name"`
	// LastRun is when the job last executed, successfully or not.
	LastRun time.Time `json:"last_run"`
	// LastSuccess is the last run that returned no error; zero if it has
	// never succeeded since this process started.
	LastSuccess time.Time `json:"last_success"`
	// LastError is the message from the most recent failure, and LastErrorAt
	// when it happened. Both are retained after a later success so a job that
	// fails intermittently is still visible.
	LastError   string    `json:"last_error,omitempty"`
	LastErrorAt time.Time `json:"last_error_at"`
	Runs        int64     `json:"runs"`
	Failures    int64     `json:"failures"`
}

// Healthy reports whether the most recent run succeeded. A job that has never
// run is considered healthy — it has not failed.
func (t TaskHealth) Healthy() bool {
	return t.Failures == 0 || t.LastSuccess.After(t.LastErrorAt)
}

// HealthRegistry records the outcome of background jobs so an admin can see
// what ran, when, and what broke.
//
// In memory and per process, deliberately: the interesting question is about
// the running server, a restart clears the slate honestly, and a job outcome is
// not worth a write to the database on every tick. Cross-restart history would
// need a table, which is the follow-up if it turns out to be wanted.
//
// A nil *HealthRegistry is usable and does nothing, so callers that were not
// given one need no nil checks.
type HealthRegistry struct {
	mu    sync.RWMutex
	tasks map[string]*TaskHealth
}

// healthTaskInstagramCrossPost is the registry key for background Instagram
// cross-posts. Unlike the scheduler's tasks it is event-driven (it runs when a
// post publishes), so "last run" may be long ago on a healthy site.
const healthTaskInstagramCrossPost = "instagram cross-post"

func NewHealthRegistry() *HealthRegistry {
	return &HealthRegistry{tasks: make(map[string]*TaskHealth)}
}

// Record notes that job name just ran, with err being its outcome (nil for
// success). Safe to call on a nil registry.
func (r *HealthRegistry) Record(name string, err error) {
	if r == nil {
		return
	}
	now := time.Now().UTC()
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.tasks[name]
	if !ok {
		t = &TaskHealth{Name: name}
		r.tasks[name] = t
	}
	t.LastRun = now
	t.Runs++
	if err != nil {
		t.Failures++
		t.LastError = err.Error()
		t.LastErrorAt = now
		return
	}
	t.LastSuccess = now
}

// Snapshot returns a copy of every recorded job, ordered by name so the admin
// view is stable between polls.
func (r *HealthRegistry) Snapshot() []TaskHealth {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	out := make([]TaskHealth, 0, len(r.tasks))
	for _, t := range r.tasks {
		out = append(out, *t)
	}
	r.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
