package services

import (
	"reflect"
	"testing"
)

func TestMediaPathRe(t *testing.T) {
	content := "![alt](</2026/08/my image.jpg>)\n![alt2](/2026/08/my%20image2.jpg)\n/2026/08/my bare image.jpg"
	matches := mediaPathRe.FindAllStringSubmatch(content, -1)
	var got []string
	for _, m := range matches {
		got = append(got, m[1])
	}
	want := []string{
		"/2026/08/my image.jpg",
		"/2026/08/my%20image2.jpg",
		"/2026/08/my bare image.jpg",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("mediaPathRe.FindAllStringSubmatch() = %q, want %q", got, want)
	}
}
