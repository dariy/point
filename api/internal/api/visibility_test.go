package api

import (
	"point-api/internal/repository"
	"testing"
)

func TestIsPostVisibleToPublic(t *testing.T) {
	hidden := map[int64]bool{2: true, 5: true}

	tests := []struct {
		name     string
		tags     []repository.PostTagInfo
		expected bool
	}{
		{"no tags", []repository.PostTagInfo{}, true},
		{"tag not hidden", []repository.PostTagInfo{{ID: 1}}, true},
		{"tag hidden", []repository.PostTagInfo{{ID: 2}}, false},
		{"mixed tags, one hidden", []repository.PostTagInfo{{ID: 1}, {ID: 5}}, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := IsPostVisibleToPublic(tc.tags, hidden)
			if got != tc.expected {
				t.Errorf("got %v, want %v", got, tc.expected)
			}
		})
	}
}
