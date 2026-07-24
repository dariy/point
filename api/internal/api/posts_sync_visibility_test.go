package api

import (
	"context"
	"testing"
)

// An empty path set is a no-op: syncMediaVisibility must return before touching
// mediaService, so this is safe to call on a bare handler. Guards the privacy-
// control fast path that skips work when a mutation changed no media.
func TestSyncMediaVisibilityEmptyPathsIsNoop(t *testing.T) {
	h := &PostHandler{} // mediaService intentionally nil; must not be dereferenced

	assert := func(cond bool) {
		if !cond {
			t.Fatalf("expected no panic and early return")
		}
	}

	h.syncMediaVisibility(context.Background(), "test_op", nil)
	h.syncMediaVisibility(context.Background(), "test_op", []string{})
	assert(true) // reaching here means neither call dereferenced the nil service
}
