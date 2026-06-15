package utils

import (
	"strings"
	"testing"
)

func TestSlugify(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"", ""},
		{"Hello World", "hello-world"},
		{"Hello  World", "hello-world"},
		{"Hello_World", "hello_world"},
		{"_root", "_root"},
		{"Hello--World", "hello-world"},
		{"  Hello World  ", "hello-world"},
		{"!!Hello World!!", "hello-world"},
		{"Héllo Wörld", "hello-world"},
		{"Python & Go", "python-go"},
		{"Long " + string(make([]byte, 210)) + " Text", "long-text"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			actual := Slugify(tt.input)
			if actual != tt.expected {
				t.Errorf("Slugify(%q) = %q, expected %q", tt.input, actual, tt.expected)
			}
		})
	}
}

func TestSlugifyLong(t *testing.T) {
	input := strings.Repeat("a", 210)
	expected := strings.Repeat("a", 200)
	actual := Slugify(input)
	if actual != expected {
		t.Errorf("Slugify long input failed: length %d, expected 200", len(actual))
	}

	input = strings.Repeat("a", 199) + "-" + strings.Repeat("b", 10)
	expected = strings.Repeat("a", 199)
	actual = Slugify(input)
	if actual != expected {
		t.Errorf("Slugify long input with trailing hyphen failed: %q", actual)
	}
}
