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
