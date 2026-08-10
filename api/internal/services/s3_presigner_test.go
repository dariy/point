package services

import (
	"context"
	"strings"
	"testing"
)

func TestNewS3Presigner(t *testing.T) {
	// Test empty config returns nil
	p, err := NewS3Presigner("", "", "", "", "")
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if p != nil {
		t.Errorf("expected nil presigner for empty config, got %v", p)
	}

	// Test valid config
	p, err = NewS3Presigner("http://localhost:9000", "us-east-1", "test", "test", "mybucket")
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if p == nil {
		t.Fatalf("expected non-nil presigner")
	}
}

func TestPresignGetObject(t *testing.T) {
	p, _ := NewS3Presigner("http://localhost:9000", "us-east-1", "test", "test", "mybucket")
	url, err := p.PresignGetObject(context.Background(), "test-object.jpg")
	if err != nil {
		t.Fatalf("expected nil error, got %v", err)
	}
	if url == "" {
		t.Errorf("expected non-empty URL")
	}
	if !strings.Contains(url, "test-object.jpg") {
		t.Errorf("expected URL to contain object key, got %s", url)
	}
}
