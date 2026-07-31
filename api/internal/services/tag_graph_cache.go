package services

import (
	"context"
	"sync"
)

// tagGraphCache owns the cached tag graph and the lock protecting it.
//
// It exists as its own type because the graph is the one piece of shared
// mutable state in TagService, and a cache whose lock discipline is spread
// across a 1500-line file is where cache-coherency bugs come from. Everything
// that can read or drop the graph goes through these two methods; nothing else
// touches the fields.
//
// The build function is supplied at construction rather than being a method on
// TagService, so the cache has no view of the service beyond "how to rebuild".
type tagGraphCache struct {
	mu    sync.RWMutex
	graph *TagGraph
	build func(context.Context) (*TagGraph, error)
}

func newTagGraphCache(build func(context.Context) (*TagGraph, error)) *tagGraphCache {
	return &tagGraphCache{build: build}
}

// get returns the cached graph, building it if the cache is cold.
//
// The build runs under the write lock. That serializes concurrent cold reads
// into one build instead of a thundering herd, which is the right trade here:
// building issues several queries, and the graph is read far more often than
// it is invalidated.
func (c *tagGraphCache) get(ctx context.Context) (*TagGraph, error) {
	c.mu.RLock()
	g := c.graph
	c.mu.RUnlock()
	if g != nil {
		return g, nil
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	// Another goroutine may have built it while we waited for the lock.
	if c.graph != nil {
		return c.graph, nil
	}
	built, err := c.build(ctx)
	if err != nil {
		// Leave the cache cold so the next reader retries rather than
		// caching a partially-built graph.
		return nil, err
	}
	c.graph = built
	return c.graph, nil
}

// invalidate drops the cached graph so the next read rebuilds it.
func (c *tagGraphCache) invalidate() {
	c.mu.Lock()
	c.graph = nil
	c.mu.Unlock()
}
