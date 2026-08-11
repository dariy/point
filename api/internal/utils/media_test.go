package utils

import (
	"testing"
)

func TestMarkdownImageRe(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{`![alt](</2026/08/my image.jpg>)`, `/2026/08/my image.jpg`},
		{`![alt](/2026/08/my-image.jpg)`, `/2026/08/my-image.jpg`},
		{`![alt](/2026/08/my-image.jpg "title")`, `/2026/08/my-image.jpg`},
		{`![alt](</2026/08/my image.jpg> "title")`, `/2026/08/my image.jpg`},
	}
	for _, c := range cases {
		m := markdownImageRe.FindStringSubmatch(c.input)
		if m == nil || m[1] != c.want {
			t.Errorf("markdownImageRe.FindStringSubmatch(%q) = %q, want %q", c.input, m, c.want)
		}
	}
}

func TestDeriveMediaURL(t *testing.T) {
	cases := []struct {
		name          string
		thumbnailPath string
		content       string
		want          string
	}{
		{
			name:          "Thumbnail provided",
			thumbnailPath: "/media/originals/thumb.jpg",
			content:       "Some content",
			want:          "/thumb.jpg",
		},
		{
			name:          "Thumbnail provided absolute",
			thumbnailPath: "http://example.com/thumb.jpg",
			content:       "http://example.com/thumb.jpg",
			want:          "http://example.com/thumb.jpg",
		},
		{
			name:          "Markdown image match",
			thumbnailPath: "",
			content:       "Hello ![alt](/media/originals/image.jpg)",
			want:          "/image.jpg",
		},
		{
			name:          "Video tag match",
			thumbnailPath: "",
			content:       `<video src="/media/originals/video.mp4"></video>`,
			want:          "/video.mp4",
		},
		{
			name:          "Source tag match",
			thumbnailPath: "",
			content:       `<video><source src="originals/video.mp4"></video>`,
			want:          "/video.mp4",
		},
		{
			name:          "Bare media match",
			thumbnailPath: "",
			content:       "\n/media/originals/bare.mp3\n",
			want:          "/bare.mp3",
		},
		{
			name:          "No match",
			thumbnailPath: "",
			content:       "Just some text",
			want:          "",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := DeriveMediaURL(c.thumbnailPath, c.content)
			if got != c.want {
				t.Errorf("DeriveMediaURL() = %q, want %q", got, c.want)
			}
		})
	}
}

func TestMustMatch(t *testing.T) {
	if got := mustMatch(bareMediaRe, "no match"); got != "" {
		t.Errorf("mustMatch() = %q, want empty", got)
	}
}
