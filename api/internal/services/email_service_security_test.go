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

func TestSendEmailRejectsMalformedRecipient(t *testing.T) {
	cfg := SMTPConfig{Host: "localhost", Port: 25, From: "sender@example.com"}

	// A CRLF-laced recipient would inject an extra RCPT command if it reached
	// the envelope; ParseAddress rejects it before we dial.
	err := SendEmail(cfg, "victim@x.com\r\nRCPT TO:<attacker@y.com>", "Hi", "body")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "invalid recipient address")

	err = SendEmail(cfg, "not an address", "Hi", "body")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "invalid recipient address")
}

func TestIsLocalHost(t *testing.T) {
	tests := []struct {
		host  string
		local bool
	}{
		{"localhost", true},
		{"127.0.0.1", true},
		{"::1", true},
		{"127.0.0.5", true},
		{"smtp.example.com", false},
		{"8.8.8.8", false},
	}
	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			assert.Equal(t, tt.local, isLocalHost(tt.host))
		})
	}
}

func TestToCRLF(t *testing.T) {
	assert.Equal(t, "a\r\nb", toCRLF("a\nb"))
	assert.Equal(t, "a\r\nb", toCRLF("a\r\nb"))
	assert.Equal(t, "a\r\nb\r\nc", toCRLF("a\r\nb\nc"))
}
