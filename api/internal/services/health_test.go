package services

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// See point-system-health-admin.

func TestHealthRegistry_RecordsSuccessAndFailure(t *testing.T) {
	r := NewHealthRegistry()
	r.Record("backup", nil)
	r.Record("backup", errors.New("disk full"))
	r.Record("cleanup", nil)

	snap := r.Snapshot()
	if len(snap) != 2 {
		t.Fatalf("snapshot has %d tasks, want 2", len(snap))
	}
	// Sorted by name so the admin view is stable between polls.
	if snap[0].Name != "backup" || snap[1].Name != "cleanup" {
		t.Errorf("snapshot is not name-ordered: %v, %v", snap[0].Name, snap[1].Name)
	}

	b := snap[0]
	if b.Runs != 2 || b.Failures != 1 {
		t.Errorf("backup runs=%d failures=%d, want 2 and 1", b.Runs, b.Failures)
	}
	if b.LastError != "disk full" {
		t.Errorf("backup LastError = %q", b.LastError)
	}
	// The earlier success is retained, so an intermittently failing job still
	// shows when it last worked.
	if b.LastSuccess.IsZero() {
		t.Error("backup lost its LastSuccess after a later failure")
	}
	if b.Healthy() {
		t.Error("backup should be unhealthy: its most recent run failed")
	}

	if !snap[1].Healthy() {
		t.Error("cleanup should be healthy")
	}
}

// A job that recovers must report healthy again, while keeping the record of
// what went wrong.
func TestHealthRegistry_RecoveryFlipsHealthy(t *testing.T) {
	r := NewHealthRegistry()
	r.Record("job", errors.New("boom"))
	if r.Snapshot()[0].Healthy() {
		t.Fatal("job should be unhealthy after a failure")
	}
	time.Sleep(time.Millisecond) // ensure a strictly later timestamp
	r.Record("job", nil)

	got := r.Snapshot()[0]
	if !got.Healthy() {
		t.Error("job should be healthy again after a success")
	}
	if got.LastError != "boom" {
		t.Error("the previous failure should still be visible after recovery")
	}
}

// A job that has never run is not a failure.
func TestHealthRegistry_UnrunTaskIsHealthy(t *testing.T) {
	var zero TaskHealth
	if !zero.Healthy() {
		t.Error("a task with no recorded runs must not report unhealthy")
	}
}

// A nil registry is usable, so services constructed without one need no nil
// checks at every call site.
func TestHealthRegistry_NilIsUsable(t *testing.T) {
	var r *HealthRegistry
	r.Record("job", errors.New("x")) // must not panic
	if snap := r.Snapshot(); snap != nil {
		t.Errorf("nil registry Snapshot() = %v, want nil", snap)
	}
}

// Recording happens from every background goroutine; the admin endpoint reads
// concurrently. Run with -race.
func TestHealthRegistry_ConcurrentAccess(t *testing.T) {
	r := NewHealthRegistry()
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 100 {
				if i%2 == 0 {
					r.Record("job", nil)
				} else {
					r.Record("job", errors.New("e"))
				}
			}
		}()
	}
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 100 {
				_ = r.Snapshot()
			}
		}()
	}
	wg.Wait()
	if got := r.Snapshot()[0].Runs; got != 800 {
		t.Errorf("runs = %d, want 800", got)
	}
}
