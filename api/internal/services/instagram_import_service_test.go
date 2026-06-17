package services

import (
	"reflect"
	"testing"
)

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
