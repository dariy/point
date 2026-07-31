package services

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// See point-media-worker-pool.

// Results must line up with the input: bulk importers report failures as
// "<filename>: <error>", so a misaligned slice blames the wrong file.
func TestParallelImport_PreservesOrder(t *testing.T) {
	items := make([]int, 50)
	for i := range items {
		items[i] = i
	}
	got := ParallelImport(context.Background(), items, func(_ context.Context, n int) (string, error) {
		// Reverse the natural completion order as much as possible.
		time.Sleep(time.Duration(50-n) * time.Microsecond)
		return fmt.Sprintf("v%d", n), nil
	})

	if len(got) != len(items) {
		t.Fatalf("got %d outcomes, want %d", len(got), len(items))
	}
	for i, o := range got {
		if o.Index != i {
			t.Errorf("outcome %d has Index %d", i, o.Index)
		}
		if o.Err != nil {
			t.Errorf("outcome %d: unexpected error %v", i, o.Err)
		}
		if want := fmt.Sprintf("v%d", i); o.Value != want {
			t.Errorf("outcome %d = %q, want %q", i, o.Value, want)
		}
	}
}

// One bad photo must not abandon the rest of the batch.
func TestParallelImport_ContinuesAfterFailure(t *testing.T) {
	boom := errors.New("boom")
	items := []int{0, 1, 2, 3, 4}
	got := ParallelImport(context.Background(), items, func(_ context.Context, n int) (int, error) {
		if n == 2 {
			return 0, boom
		}
		return n * 10, nil
	})

	for i, o := range got {
		if i == 2 {
			if !errors.Is(o.Err, boom) {
				t.Errorf("item 2 err = %v, want boom", o.Err)
			}
			continue
		}
		if o.Err != nil {
			t.Errorf("item %d failed because of an unrelated item: %v", i, o.Err)
		}
		if o.Value != i*10 {
			t.Errorf("item %d = %d, want %d", i, o.Value, i*10)
		}
	}
}

// Parallelism must be bounded — an import runs on a machine that is also
// serving a site.
func TestParallelImport_BoundsConcurrency(t *testing.T) {
	var mu sync.Mutex
	var inFlight, peak int

	items := make([]int, 64)
	ParallelImport(context.Background(), items, func(_ context.Context, _ int) (int, error) {
		mu.Lock()
		inFlight++
		if inFlight > peak {
			peak = inFlight
		}
		mu.Unlock()

		time.Sleep(2 * time.Millisecond)

		mu.Lock()
		inFlight--
		mu.Unlock()
		return 0, nil
	})

	if peak > importWorkers() {
		t.Errorf("peak concurrency %d exceeded the %d-worker bound", peak, importWorkers())
	}
	if peak < 2 && importWorkers() > 1 {
		t.Errorf("peak concurrency %d — the pool did not actually parallelize", peak)
	}
}

// A cancelled context must stop new work and mark the remainder as failed —
// never leave an unattempted item looking like a success.
func TestParallelImport_Cancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var started atomic.Int64

	items := make([]int, 200)
	got := ParallelImport(ctx, items, func(ctx context.Context, _ int) (int, error) {
		if started.Add(1) == 4 {
			cancel()
		}
		time.Sleep(time.Millisecond)
		return 1, nil
	})

	if len(got) != len(items) {
		t.Fatalf("got %d outcomes, want %d", len(got), len(items))
	}
	var cancelled, ok int
	for _, o := range got {
		switch {
		case o.Err != nil:
			cancelled++
		case o.Value == 1:
			ok++
		default:
			t.Error("an item was neither attempted nor marked failed")
		}
	}
	if cancelled == 0 {
		t.Error("cancellation did not stop the batch")
	}
	if ok+cancelled != len(items) {
		t.Errorf("accounted for %d of %d items", ok+cancelled, len(items))
	}
}

func TestParallelImport_EmptyInput(t *testing.T) {
	got := ParallelImport(context.Background(), []int{}, func(context.Context, int) (int, error) {
		t.Error("fn ran for an empty input")
		return 0, nil
	})
	if len(got) != 0 {
		t.Errorf("got %d outcomes for empty input", len(got))
	}
}

func TestImportWorkers_Bounded(t *testing.T) {
	if n := importWorkers(); n < 1 || n > 4 {
		t.Errorf("importWorkers() = %d, want between 1 and 4", n)
	}
}
