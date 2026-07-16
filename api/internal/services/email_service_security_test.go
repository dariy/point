package services

import (
	"testing"
	"github.com/stretchr/testify/assert"
)

func TestSanitizeHeader(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "plain text",
			input:    "Hello World",
			expected: "Hello World",
		},
		{
			name:     "newlines",
			input:    "Hello\nWorld",
			expected: "HelloWorld",
		},
		{
			name:     "carriage returns",
			input:    "Hello\rWorld",
			expected: "HelloWorld",
		},
		{
			name:     "mixed",
			input:    "Subject\r\nBcc: evil@example.com",
			expected: "SubjectBcc: evil@example.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, sanitizeHeader(tt.input))
		})
	}
}

func TestEnvelopeAddr(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{
			name:     "bare address",
			input:    "monkey@monkey.point.photos",
			expected: "monkey@monkey.point.photos",
		},
		{
			name:     "display name",
			input:    "Monkey <monkey@monkey.point.photos>",
			expected: "monkey@monkey.point.photos",
		},
		{
			name:     "quoted display name",
			input:    `"Point Photos" <no-reply@point.photos>`,
			expected: "no-reply@point.photos",
		},
		{
			name:     "unparseable falls through unchanged",
			input:    "not an address",
			expected: "not an address",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.expected, envelopeAddr(tt.input))
		})
	}
}
