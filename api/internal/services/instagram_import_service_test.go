package services

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"point-api/internal/config"
)

// newTestImportService builds an InstagramImportService backed by a real
// MediaService (in-memory DB + temp storage) so downloadMediaURL can be
// exercised end to end.
func newTestImportService(t *testing.T) *InstagramImportService {
	t.Helper()
	repo := setupTestDB(t)
	t.Cleanup(func() { _ = repo.Close() })

	cfg := &config.Config{
		StoragePath:     t.TempDir(),
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}
	settings := NewSettingsService(repo)
	media := NewMediaService(repo, cfg, settings, NewTagService(repo))
	return NewInstagramImportService(nil, media, NewPostService(repo, nil, nil, nil, ""))
}

func TestDownloadMediaURLVideoExtension(t *testing.T) {
	tests := []struct {
		name        string
		path        string // request path served
		contentType string
		wantSuffix  string
	}{
		{"video url with mp4 extension", "/clip.mp4", "video/mp4", ".mp4"},
		{"video url without extension uses mime", "/video", "video/mp4", ".mp4"},
		{"image url with jpg extension", "/photo.jpg", "image/jpeg", ".jpg"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", tt.contentType)
				_, _ = w.Write([]byte("fake-media-bytes-" + tt.name))
			}))
			defer srv.Close()

			svc := newTestImportService(t)
			path, err := svc.downloadMediaURL(context.Background(), srv.URL+tt.path, "")
			if err != nil {
				t.Fatalf("downloadMediaURL: %v", err)
			}
			if !strings.HasSuffix(path, tt.wantSuffix) {
				t.Errorf("stored path = %q, want suffix %q", path, tt.wantSuffix)
			}
		})
	}
}

func TestExtForMime(t *testing.T) {
	tests := []struct {
		mime string
		want string
	}{
		{"video/mp4", ".mp4"},
		{"video/quicktime", ".mov"},
		{"image/jpeg", ".jpg"},
		{"image/png", ".png"},
		{"audio/mpeg", ".mp3"},
		{"application/x-not-a-real-type", ".jpg"}, // unknown → default
		{"", ".jpg"},                              // empty → default
	}
	for _, tt := range tests {
		t.Run(tt.mime, func(t *testing.T) {
			if got := extForMime(tt.mime); got != tt.want {
				t.Errorf("extForMime(%q) = %q, want %q", tt.mime, got, tt.want)
			}
		})
	}
}

func TestBuildPostContentMixedMedia(t *testing.T) {
	got := buildPostContent([]string{
		"originals/2025/06/123_clip.mp4",
		"originals/2025/06/456_photo.jpg",
	})
	want := "/2025/06/123_clip.mp4\n/2025/06/456_photo.jpg"
	if got != want {
		t.Errorf("buildPostContent = %q, want %q", got, want)
	}
}

func TestParseHashtags(t *testing.T) {
	tests := []struct {
		name        string
		caption     string
		wantTags    []string
		wantCleaned string
	}{
		{
			name:        "no hashtags",
			caption:     "Just a normal caption.",
			wantTags:    nil,
			wantCleaned: "Just a normal caption.",
		},
		{
			name:        "trailing hashtag block is stripped",
			caption:     "A great day at the beach\n\n#summer #beach #fun",
			wantTags:    []string{"summer", "beach", "fun"},
			wantCleaned: "A great day at the beach",
		},
		{
			name:        "inline hashtags removed and whitespace tidied",
			caption:     "Loving the #sunset views tonight",
			wantTags:    []string{"sunset"},
			wantCleaned: "Loving the views tonight",
		},
		{
			name:        "case-insensitive dedup keeps first spelling",
			caption:     "#Travel #travel #TRAVEL",
			wantTags:    []string{"Travel"},
			wantCleaned: "",
		},
		{
			name:        "underscores and digits are valid",
			caption:     "#throwback_2024 done",
			wantTags:    []string{"throwback_2024"},
			wantCleaned: "done",
		},
		{
			name:        "unicode letters",
			caption:     "Привет #москва",
			wantTags:    []string{"москва"},
			wantCleaned: "Привет",
		},
		{
			name:        "caption that is only hashtags",
			caption:     "#a #b #c",
			wantTags:    []string{"a", "b", "c"},
			wantCleaned: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotTags, gotCleaned := parseHashtags(tt.caption)
			if !reflect.DeepEqual(gotTags, tt.wantTags) {
				t.Errorf("tags = %#v, want %#v", gotTags, tt.wantTags)
			}
			if gotCleaned != tt.wantCleaned {
				t.Errorf("cleaned = %q, want %q", gotCleaned, tt.wantCleaned)
			}
		})
	}
}

func TestAppendTagUnique(t *testing.T) {
	tests := []struct {
		name string
		tags []string
		add  string
		want []string
	}{
		{name: "empty", tags: nil, add: "instagram", want: []string{"instagram"}},
		{name: "appends new", tags: []string{"summer"}, add: "instagram", want: []string{"summer", "instagram"}},
		{name: "skips exact duplicate", tags: []string{"instagram"}, add: "instagram", want: []string{"instagram"}},
		{name: "skips case-insensitive duplicate", tags: []string{"Instagram"}, add: "instagram", want: []string{"Instagram"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := appendTagUnique(tt.tags, tt.add)
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("appendTagUnique(%#v, %q) = %#v, want %#v", tt.tags, tt.add, got, tt.want)
			}
		})
	}
}
