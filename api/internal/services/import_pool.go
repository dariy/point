package services

import (
	"context"
	"runtime"
	"sync"
)

// ImportOutcome is the result of processing one item in a bulk import. Index is
// the item's position in the input, so callers can report per-file errors
// against the right filename after a concurrent run.
type ImportOutcome[R any] struct {
	Index int
	Value R
	Err   error
}

// importWorkers is the parallelism used for bulk media import.
//
// Thumbnailing is CPU-bound (imaging.Fill with Lanczos), so the useful ceiling
// is the core count. It is capped anyway: an import is a background convenience
// running on a machine that is also serving a site, and saturating every core
// to make a bulk import finish sooner is a bad trade for the visitor waiting on
// a page render.
func importWorkers() int {
	n := runtime.NumCPU()
	if n > 4 {
		n = 4
	}
	if n < 1 {
		n = 1
	}
	return n
}

// ParallelImport applies fn to every item across a bounded pool of workers and
// returns the outcomes in input order.
//
// Order is preserved because bulk-import callers report errors as
// "<filename>: <error>"; a result slice that did not line up with the input
// would attribute failures to the wrong file. Every item is attempted even if
// an earlier one fails — a single unreadable photo must not abandon the rest of
// the batch.
//
// Cancelling ctx stops workers from picking up further items; already-running
// items finish, and unstarted ones come back with ctx.Err().
func ParallelImport[T, R any](ctx context.Context, items []T, fn func(context.Context, T) (R, error)) []ImportOutcome[R] {
	out := make([]ImportOutcome[R], len(items))
	if len(items) == 0 {
		return out
	}

	workers := min(importWorkers(), len(items))

	var wg sync.WaitGroup
	indices := make(chan int)

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range indices {
				out[i].Index = i
				if err := ctx.Err(); err != nil {
					out[i].Err = err
					continue
				}
				// Each worker writes only to its own index, so no lock is
				// needed on out.
				out[i].Value, out[i].Err = fn(ctx, items[i])
			}
		}()
	}

	for i := range items {
		select {
		case indices <- i:
		case <-ctx.Done():
			// Mark the rest as cancelled rather than leaving them zero-valued,
			// so a caller cannot mistake "never attempted" for "succeeded".
			for j := i; j < len(items); j++ {
				out[j].Index = j
				out[j].Err = ctx.Err()
			}
			close(indices)
			wg.Wait()
			return out
		}
	}
	close(indices)
	wg.Wait()
	return out
}
