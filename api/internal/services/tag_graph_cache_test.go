package services

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"point-api/internal/models"
)

// The tag graph is the one piece of shared mutable state in TagService, and the
// likeliest source of cache-coherency bugs. These pin the cache's contract
// directly rather than through the service. See point-tag-service-decompose.

func TestTagGraphCache_BuildsOnceAndReusesResult(t *testing.T) {
	var builds atomic.Int64
	c := newTagGraphCache(func(context.Context) (*TagGraph, error) {
		builds.Add(1)
		return &TagGraph{ByID: map[int64]models.Tag{}}, nil
	})
	ctx := context.Background()

	first, err := c.get(ctx)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	second, err := c.get(ctx)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if builds.Load() != 1 {
		t.Errorf("build ran %d times, want 1", builds.Load())
	}
	if first != second {
		t.Error("second get returned a different graph instead of the cached one")
	}
}

func TestTagGraphCache_InvalidateForcesRebuild(t *testing.T) {
	var builds atomic.Int64
	c := newTagGraphCache(func(context.Context) (*TagGraph, error) {
		builds.Add(1)
		return &TagGraph{}, nil
	})
	ctx := context.Background()

	if _, err := c.get(ctx); err != nil {
		t.Fatalf("get: %v", err)
	}
	c.invalidate()
	if _, err := c.get(ctx); err != nil {
		t.Fatalf("get after invalidate: %v", err)
	}
	if builds.Load() != 2 {
		t.Errorf("build ran %d times, want 2 (one per invalidation)", builds.Load())
	}
}

// A failed build must leave the cache cold, so the next reader retries rather
// than being served a graph that was never assembled.
func TestTagGraphCache_FailedBuildIsNotCached(t *testing.T) {
	var builds atomic.Int64
	boom := errors.New("boom")
	c := newTagGraphCache(func(context.Context) (*TagGraph, error) {
		if builds.Add(1) == 1 {
			return nil, boom
		}
		return &TagGraph{}, nil
	})
	ctx := context.Background()

	if _, err := c.get(ctx); !errors.Is(err, boom) {
		t.Fatalf("first get err = %v, want boom", err)
	}
	g, err := c.get(ctx)
	if err != nil {
		t.Fatalf("second get: %v", err)
	}
	if g == nil {
		t.Fatal("second get returned a nil graph")
	}
	if builds.Load() != 2 {
		t.Errorf("build ran %d times, want 2 — a failed build must not be cached", builds.Load())
	}
}

// Concurrent cold readers must collapse into one build, and none may observe a
// nil graph. Run with -race.
func TestTagGraphCache_ConcurrentColdReadsBuildOnce(t *testing.T) {
	var builds atomic.Int64
	c := newTagGraphCache(func(context.Context) (*TagGraph, error) {
		builds.Add(1)
		return &TagGraph{}, nil
	})
	ctx := context.Background()

	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			g, err := c.get(ctx)
			if err != nil || g == nil {
				t.Errorf("concurrent get = %v, %v", g, err)
			}
		}()
	}
	wg.Wait()
	if builds.Load() != 1 {
		t.Errorf("build ran %d times under concurrent cold reads, want 1", builds.Load())
	}
}

// Invalidating while readers are active must not race or hand out a nil graph.
func TestTagGraphCache_InvalidateRacesSafely(t *testing.T) {
	c := newTagGraphCache(func(context.Context) (*TagGraph, error) {
		return &TagGraph{}, nil
	})
	ctx := context.Background()

	var wg sync.WaitGroup
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 50 {
				if g, err := c.get(ctx); err != nil || g == nil {
					t.Errorf("get during invalidation = %v, %v", g, err)
					return
				}
			}
		}()
	}
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 50 {
				c.invalidate()
			}
		}()
	}
	wg.Wait()
}
